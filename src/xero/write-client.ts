import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { execute, query } from "../db/mysql.js";
import { getXeroAccessToken } from "./token-store.js";

type AnyRecord = Record<string, any>;

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}


/**
 * Separate write client — kept apart from the read-only XeroClient intentionally.
 * All writes go through here. Read client is NEVER modified.
 * Kill switch: XERO_WRITE_ENABLED must be "true" in .env or writes throw immediately.
 */
export class XeroWriteClient {

  private assertEnabled(): void {
    if (config.XERO_WRITE_ENABLED !== true) {
      throw new Error(
        "Xero writes are disabled. Set XERO_WRITE_ENABLED=true in .env after write scope is granted."
      );
    }
  }

  /**
   * Create a draft ACCREC invoice. Always creates as DRAFT regardless of Status in payload.
   * Returns the created invoice object from Xero.
   */
  async createInvoice(
    tenantId: string,
    payload: AnyRecord,
    idempotencyKey: string,
    psReference: string,
    dryRun: boolean
  ): Promise<AnyRecord> {
    // Enforce draft-first regardless of what was passed
    const safePayload = { ...payload, Status: "DRAFT" };

    await execute(
      `INSERT ${dryRun ? "IGNORE " : ""}INTO xero_write_log
         (tenant_id, operation, idempotency_key, dry_run, status, request_payload, ps_reference)
       VALUES (?, 'CREATE_INVOICE', ?, ?, 'pending', ?, ?)`,
      [tenantId, idempotencyKey, dryRun ? 1 : 0, JSON.stringify(safePayload), psReference]
    );

    if (dryRun) {
      await execute(
        `UPDATE xero_write_log SET status='dry_run' WHERE idempotency_key=? AND dry_run=1`,
        [idempotencyKey]
      );
      return safePayload;
    }

    this.assertEnabled();

    const token = await this.getAccessToken();
    const url = "https://api.xero.com/api.xro/2.0/Invoices";
    const response = await this.post(token, tenantId, url, safePayload, idempotencyKey);

    const created = response.Invoices?.[0];
    if (!created?.InvoiceID) {
      throw new Error(`Xero CREATE_INVOICE returned no InvoiceID: ${JSON.stringify(response)}`);
    }

    await execute(
      `UPDATE xero_write_log
         SET status='success', response_payload=?, xero_object_id=?
       WHERE idempotency_key=? AND dry_run=0`,
      [JSON.stringify(created), created.InvoiceID, idempotencyKey]
    );

    return created;
  }

  /**
   * Record a payment against an AUTHORISED invoice (used for the CURO / TagadaPay
   * clearing accounts 209 / 210). The caller has already run the safety checks in
   * src/accounting/clearing.ts; this method only logs, sends and records the result.
   */
  async createPayment(
    tenantId: string,
    payload: AnyRecord,
    idempotencyKey: string,
    psReference: string,
    dryRun: boolean
  ): Promise<AnyRecord> {
    await execute(
      `INSERT ${dryRun ? "IGNORE " : ""}INTO xero_write_log
         (tenant_id, operation, idempotency_key, dry_run, status, request_payload, ps_reference)
       VALUES (?, 'CREATE_PAYMENT', ?, ?, 'pending', ?, ?)`,
      [tenantId, idempotencyKey, dryRun ? 1 : 0, JSON.stringify(payload), psReference]
    );

    if (dryRun) {
      await execute(
        `UPDATE xero_write_log SET status='dry_run' WHERE idempotency_key=? AND dry_run=1`,
        [idempotencyKey]
      );
      return payload;
    }

    this.assertEnabled();

    const token = await this.getAccessToken();
    const url = "https://api.xero.com/api.xro/2.0/Payments";
    const response = await this.post(token, tenantId, url, payload, idempotencyKey);

    const created = response.Payments?.[0];
    if (!created?.PaymentID) {
      throw new Error(`Xero CREATE_PAYMENT returned no PaymentID: ${JSON.stringify(response)}`);
    }

    await execute(
      `UPDATE xero_write_log
         SET status='success', response_payload=?, xero_object_id=?
       WHERE idempotency_key=? AND dry_run=0`,
      [JSON.stringify(created), created.PaymentID, idempotencyKey]
    );

    return created;
  }

  /**
   * Check whether an invoice with this Reference already exists in Xero.
   * Read-only — uses the read scope; does not require XERO_WRITE_ENABLED.
   */
  async findInvoiceByReference(tenantId: string, reference: string, type: "ACCREC" | "ACCPAY" = "ACCREC"): Promise<AnyRecord | null> {
    const url = `https://api.xero.com/api.xro/2.0/Invoices?where=Reference%3D%3D%22${encodeURIComponent(reference)}%22%26%26Type%3D%3D%22${type}%22`;
    const body = await this.get(tenantId, url, "findInvoiceByReference");
    const invoices: AnyRecord[] = body.Invoices ?? [];
    return invoices.find((i) => i.Status !== "DELETED" && i.Status !== "VOIDED") ?? null;
  }

  /**
   * GET a single invoice/bill by ID from Xero (live, not local warehouse).
   * Read-only; does not require XERO_WRITE_ENABLED.
   */
  async getInvoice(tenantId: string, invoiceId: string): Promise<AnyRecord | null> {
    const url = `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`;
    const body = await this.get(tenantId, url, "getInvoice");
    return body.Invoices?.[0] ?? null;
  }

  /**
   * Create a draft ACCPAY bill.
   * Forces Status=DRAFT regardless of payload; existence check is caller's responsibility.
   */
  async createBill(
    tenantId: string,
    payload: AnyRecord,
    idempotencyKey: string,
    reference: string,
    dryRun: boolean
  ): Promise<AnyRecord> {
    const safePayload = { ...payload, Type: "ACCPAY", Status: "DRAFT" };

    if (dryRun) {
      await execute(
        `INSERT IGNORE INTO xero_write_log
           (tenant_id, operation, idempotency_key, dry_run, status, request_payload, ps_reference)
         VALUES (?, 'CREATE_BILL', ?, 1, 'pending', ?, ?)`,
        [tenantId, idempotencyKey, JSON.stringify(safePayload), reference]
      );
      await execute(`UPDATE xero_write_log SET status='dry_run' WHERE idempotency_key=? AND dry_run=1`, [idempotencyKey]);
      return safePayload;
    }

    // Real write: a given idempotency key may only ever reach Xero once. If a record
    // already exists for this exact key, only a cleanly-failed ('error') one may be
    // retried — and it is REUSED, not duplicated.
    const existing = await query<any[]>(
      `SELECT id, status FROM xero_write_log WHERE idempotency_key=? AND dry_run=0`,
      [idempotencyKey]
    );

    if (existing.length === 0) {
      await execute(
        `INSERT INTO xero_write_log
           (tenant_id, operation, idempotency_key, dry_run, status, request_payload, ps_reference)
         VALUES (?, 'CREATE_BILL', ?, 0, 'pending', ?, ?)`,
        [tenantId, idempotencyKey, JSON.stringify(safePayload), reference]
      );
    } else if (existing[0].status === "error") {
      const result = await execute(
        `UPDATE xero_write_log
           SET status='pending',
               flag_reason=CONCAT(COALESCE(flag_reason, ''), ' | Retried ', NOW()),
               request_payload=?, response_payload=NULL, xero_object_id=NULL
         WHERE id=? AND status='error'`,
        [JSON.stringify(safePayload), existing[0].id]
      );
      if (result.affectedRows !== 1) {
        throw new Error(
          `Refusing CREATE_BILL retry for idempotency key "${idempotencyKey}": record changed status before the retry could claim it. Re-check xero_write_log before trying again.`
        );
      }
    } else {
      throw new Error(
        `Refusing CREATE_BILL retry for idempotency key "${idempotencyKey}": existing xero_write_log record (id=${existing[0].id}) has status='${existing[0].status}', not 'error'. ` +
        `A 'success' or 'pending' record must never be silently retried.`
      );
    }

    this.assertEnabled();
    const token = await this.getAccessToken();
    const response = await this.post(token, tenantId, "https://api.xero.com/api.xro/2.0/Invoices", safePayload, idempotencyKey);
    const created = response.Invoices?.[0];
    if (!created?.InvoiceID) throw new Error(`Xero CREATE_BILL returned no InvoiceID: ${JSON.stringify(response)}`);

    await execute(
      `UPDATE xero_write_log SET status='success', response_payload=?, xero_object_id=? WHERE idempotency_key=? AND dry_run=0`,
      [JSON.stringify(created), created.InvoiceID, idempotencyKey]
    );
    return created;
  }

  /**
   * Recode the line items of an existing ACCPAY bill in Xero.
   * Fetches the bill live, applies proposedAccountCode + proposedTaxCode to every line, then PUTs back.
   * Only works on bills in DRAFT or SUBMITTED status (Xero rejects edits to AUTHORISED bills).
   */
  async updateInvoiceCoding(
    tenantId: string,
    invoiceId: string,
    proposedAccountCode: string,
    proposedTaxType: string | undefined,
    idempotencyKey: string,
    dryRun: boolean
  ): Promise<AnyRecord> {
    const existing = await this.getInvoice(tenantId, invoiceId);
    if (!existing) throw new Error(`Invoice ${invoiceId} not found in Xero`);

    if (!["DRAFT", "SUBMITTED"].includes(existing.Status)) {
      throw new Error(`Cannot recode invoice ${invoiceId}: status is ${existing.Status} (only DRAFT/SUBMITTED allowed)`);
    }

    const updatedLines = (existing.LineItems ?? []).map((line: AnyRecord) => ({
      LineItemID: line.LineItemID,
      Description: line.Description,
      Quantity: line.Quantity,
      UnitAmount: line.UnitAmount,
      AccountCode: proposedAccountCode,
      ...(proposedTaxType ? { TaxType: proposedTaxType } : {}),
    }));

    const updatePayload = { InvoiceID: invoiceId, LineItems: updatedLines };

    await execute(
      `INSERT INTO xero_write_log
         (tenant_id, operation, idempotency_key, dry_run, status, request_payload, ps_reference)
       VALUES (?, 'RECODE_BILL', ?, ?, 'pending', ?, ?)
       ON DUPLICATE KEY UPDATE status='pending', request_payload=VALUES(request_payload)`,
      [tenantId, idempotencyKey, dryRun ? 1 : 0, JSON.stringify(updatePayload), invoiceId]
    );

    if (dryRun) {
      await execute(`UPDATE xero_write_log SET status='dry_run' WHERE idempotency_key=? AND dry_run=1`, [idempotencyKey]);
      return updatePayload;
    }

    this.assertEnabled();
    try {
      const token = await this.getAccessToken();
      const url = `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Xero-tenant-id": tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(updatePayload),
      });
      if (resp.status === 429) {
        const waitMs = Number(resp.headers.get("retry-after") ?? 65) * 1000;
        await delay(waitMs);
        return this.updateInvoiceCoding(tenantId, invoiceId, proposedAccountCode, proposedTaxType, idempotencyKey, dryRun);
      }
      const updated = await this.parseResponse<AnyRecord>(resp, "updateInvoiceCoding");
      const result = updated.Invoices?.[0] ?? updated;

      await execute(
        `UPDATE xero_write_log SET status='success', response_payload=?, xero_object_id=? WHERE idempotency_key=? AND dry_run=0`,
        [JSON.stringify(result), invoiceId, idempotencyKey]
      );
      return result;
    } catch (err) {
      await execute(
        `UPDATE xero_write_log SET status='error', flag_reason=? WHERE idempotency_key=? AND dry_run=0`,
        [err instanceof Error ? err.message : String(err), idempotencyKey]
      );
      throw err;
    }
  }

  /**
   * Withdraw an existing ACCPAY bill: DELETED for DRAFT/SUBMITTED bills (Xero has no
   * VOIDED transition from those statuses — VOIDED only applies to AUTHORISED bills).
   * Used for a confirmed-duplicate DRAFT, not a general-purpose delete.
   */
  async deleteInvoice(
    tenantId: string,
    invoiceId: string,
    idempotencyKey: string,
    dryRun: boolean
  ): Promise<AnyRecord> {
    const existing = await this.getInvoice(tenantId, invoiceId);
    if (!existing) throw new Error(`Invoice ${invoiceId} not found in Xero`);

    if (!["DRAFT", "SUBMITTED"].includes(existing.Status)) {
      throw new Error(`Cannot delete invoice ${invoiceId}: status is ${existing.Status} (only DRAFT/SUBMITTED allowed — use void for AUTHORISED)`);
    }

    const updatePayload = { InvoiceID: invoiceId, Status: "DELETED" };

    await execute(
      `INSERT INTO xero_write_log
         (tenant_id, operation, idempotency_key, dry_run, status, request_payload, ps_reference)
       VALUES (?, 'DELETE_BILL', ?, ?, 'pending', ?, ?)
       ON DUPLICATE KEY UPDATE status='pending', request_payload=VALUES(request_payload)`,
      [tenantId, idempotencyKey, dryRun ? 1 : 0, JSON.stringify(updatePayload), invoiceId]
    );

    if (dryRun) {
      await execute(`UPDATE xero_write_log SET status='dry_run' WHERE idempotency_key=? AND dry_run=1`, [idempotencyKey]);
      return updatePayload;
    }

    this.assertEnabled();
    try {
      const token = await this.getAccessToken();
      const url = `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Xero-tenant-id": tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(updatePayload),
      });
      if (resp.status === 429) {
        const waitMs = Number(resp.headers.get("retry-after") ?? 65) * 1000;
        await delay(waitMs);
        return this.deleteInvoice(tenantId, invoiceId, idempotencyKey, dryRun);
      }
      const updated = await this.parseResponse<AnyRecord>(resp, "deleteInvoice");
      const result = updated.Invoices?.[0] ?? updated;

      await execute(
        `UPDATE xero_write_log SET status='success', response_payload=?, xero_object_id=? WHERE idempotency_key=? AND dry_run=0`,
        [JSON.stringify(result), invoiceId, idempotencyKey]
      );
      return result;
    } catch (err) {
      await execute(
        `UPDATE xero_write_log SET status='error', flag_reason=? WHERE idempotency_key=? AND dry_run=0`,
        [err instanceof Error ? err.message : String(err), idempotencyKey]
      );
      throw err;
    }
  }

  /**
   * Attach a PDF to an existing Xero invoice.
   * Non-throwing on failure: logs and returns { success: false } so callers can continue.
   */
  async attachPdf(
    tenantId: string,
    invoiceId: string,
    filename: string,
    pdfBuffer: Buffer,
    dryRun: boolean
  ): Promise<{ success: boolean; reason?: string }> {
    // Hashed rather than embedding the raw filename: filenames can contain non-Latin1
    // characters (e.g. an en-dash), and the Idempotency-Key HTTP header value must be a
    // ByteString — fetch throws before the request is ever sent if it isn't.
    const ikey = `attach:${shortHash(`${invoiceId}:${filename}`)}`;

    if (dryRun) {
      await execute(
        `INSERT INTO xero_write_log (tenant_id, operation, idempotency_key, dry_run, status, request_payload, ps_reference)
         VALUES (?, 'ATTACH_PDF', ?, 1, 'dry_run', ?, ?)
         ON DUPLICATE KEY UPDATE status='dry_run'`,
        [tenantId, ikey, JSON.stringify({ invoiceId, filename, bytes: pdfBuffer.length }), invoiceId]
      );
      return { success: true };
    }

    this.assertEnabled();
    try {
      const token = await this.getAccessToken();
      const url = `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}/Attachments/${encodeURIComponent(filename)}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Xero-tenant-id": tenantId,
          "Content-Type": "application/pdf",
          "Idempotency-Key": ikey,
        },
        body: pdfBuffer as unknown as BodyInit,
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`${resp.status}: ${detail}`);
      }
      await execute(
        `INSERT INTO xero_write_log (tenant_id, operation, idempotency_key, dry_run, status, request_payload, ps_reference)
         VALUES (?, 'ATTACH_PDF', ?, 0, 'success', ?, ?)
         ON DUPLICATE KEY UPDATE status='success'`,
        [tenantId, ikey, JSON.stringify({ invoiceId, filename, bytes: pdfBuffer.length }), invoiceId]
      );
      return { success: true };
    } catch (err) {
      const reason = String(err);
      await execute(
        `INSERT INTO xero_write_log (tenant_id, operation, idempotency_key, dry_run, status, request_payload, ps_reference)
         VALUES (?, 'ATTACH_PDF', ?, 0, 'error', ?, ?)
         ON DUPLICATE KEY UPDATE status='error', request_payload=VALUES(request_payload)`,
        [tenantId, ikey, JSON.stringify({ invoiceId, filename, error: reason }), invoiceId]
      );
      return { success: false, reason };
    }
  }

  /**
   * Check Xero organisation period lock dates against a given invoice date.
   * DRAFT writes: logs a warning but never throws (Xero may still accept the DRAFT).
   * Returns { locked, lockDate } for the caller to log or surface to the agent.
   */
  async checkPeriodLock(
    tenantId: string,
    invoiceDate: string
  ): Promise<{ locked: boolean; lockDate: string | null }> {
    try {
      const token = await this.getAccessToken();
      const resp = await fetch("https://api.xero.com/api.xro/2.0/Organisation", {
        headers: { Authorization: `Bearer ${token}`, "Xero-tenant-id": tenantId, Accept: "application/json" },
      });
      const body = await this.parseResponse<AnyRecord>(resp, "checkPeriodLock");
      const org = body.Organisations?.[0];
      if (!org) return { locked: false, lockDate: null };

      const lockDate = org.PeriodLockDate ?? org.EndOfYearLockDate ?? null;
      if (!lockDate) return { locked: false, lockDate: null };

      const locked = invoiceDate <= String(lockDate).substring(0, 10);
      return { locked, lockDate: String(lockDate).substring(0, 10) };
    } catch {
      // Non-fatal — don't block a write because we couldn't check the lock
      return { locked: false, lockDate: null };
    }
  }

  private async get(tenantId: string, url: string, label: string): Promise<AnyRecord> {
    const token = await this.getAccessToken();
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Xero-tenant-id": tenantId, Accept: "application/json" },
    });
    if (resp.status === 429) {
      const waitMs = Number(resp.headers.get("retry-after") ?? 65) * 1000;
      await delay(waitMs);
      return this.get(tenantId, url, label);
    }
    return this.parseResponse<AnyRecord>(resp, label);
  }

  private async post(
    token: string,
    tenantId: string,
    url: string,
    body: AnyRecord,
    idempotencyKey: string
  ): Promise<AnyRecord> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Xero-tenant-id": tenantId,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Idempotency-Key": idempotencyKey,
    };
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (response.status === 429) {
      const waitMs = Number(response.headers.get("retry-after") ?? 65) * 1000;
      await delay(waitMs);
      return this.post(token, tenantId, url, body, idempotencyKey);
    }
    return this.parseResponse<AnyRecord>(response, url);
  }

  private async getAccessToken(): Promise<string> {
    // Shared, disk-backed token store: see token-store.ts for why clients must not keep their own copy.
    return getXeroAccessToken();
  }

  private async parseResponse<T>(response: Response, label: string): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.Detail ?? parsed.Message ?? JSON.stringify(parsed);
      } catch {
        // leave raw text
      }
      throw new Error(`Xero write ${label} failed (${response.status}): ${detail}`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }
}
