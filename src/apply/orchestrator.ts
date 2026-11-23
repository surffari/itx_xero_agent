import { createHash } from "node:crypto";
import { execute, query } from "../db/mysql.js";
import { XeroWriteClient } from "../xero/write-client.js";
import { XeroFilesClient } from "../xero/files-client.js";
import { loadPsOrderForInvoice, buildInvoiceFromPsOrder } from "../xero/invoice-builder.js";
import { fetchInvoicePdf } from "../presta/rest-pdf.js";

const writeClient = new XeroWriteClient();
const filesClient = new XeroFilesClient();

export interface ApplyOpts {
  dryRun: boolean;
  /**
   * Contact overrides keyed by PS reference (for ACCREC) or Xero invoice ID (for ACCPAY).
   * Lets the agent specify exactly which Xero contact to use after inspecting existing contacts.
   */
  contactOverrides?: Record<string, string>;
}

export interface ProposalResult {
  id: string;
  outcome: "applied" | "skipped" | "flagged" | "error";
  xeroInvoiceId?: string;
  skipReason?: string;
  detail?: string;
}

export interface ApplySummary {
  applied: number;
  skipped: number;
  flagged: number;
  errors: number;
  results: ProposalResult[];
}

/**
 * Apply a batch of proposals to Xero.
 *
 * Proposal ID format:
 *   "accrec:<reconciliation_ps_orphans.id>"  — create a DRAFT ACCREC invoice for a PS orphan order
 *   "accpay:<coding_proposals.id>"           — recode an existing ACCPAY bill in Xero
 *
 * The agent decides which proposals to submit; this function enforces safety rails only.
 */
export async function applyProposals(
  tenantId: string,
  proposalIds: string[],
  opts: ApplyOpts
): Promise<ApplySummary> {
  const results: ProposalResult[] = [];
  let applied = 0, skipped = 0, flagged = 0, errors = 0;

  for (const id of proposalIds) {
    const colonIdx = id.indexOf(":");
    const type = colonIdx === -1 ? id : id.substring(0, colonIdx);
    const rawId = colonIdx === -1 ? "" : id.substring(colonIdx + 1);

    try {
      let result: ProposalResult;
      if (type === "accrec") {
        result = await applyAccrec(tenantId, parseInt(rawId, 10), id, opts);
      } else if (type === "accpay") {
        result = await applyAccpay(tenantId, parseInt(rawId, 10), id, opts);
      } else {
        result = { id, outcome: "error", detail: `Unknown proposal type: ${type}. Use 'accrec' or 'accpay'.` };
      }
      results.push(result);
      if (result.outcome === "applied") applied++;
      else if (result.outcome === "skipped") skipped++;
      else if (result.outcome === "flagged") flagged++;
      else errors++;
    } catch (err) {
      results.push({ id, outcome: "error", detail: String(err) });
      errors++;
    }
  }

  return { applied, skipped, flagged, errors, results };
}

// ---------------------------------------------------------------------------
// ACCREC: create a Xero DRAFT invoice for a PS orphan order
// ---------------------------------------------------------------------------
async function applyAccrec(
  tenantId: string,
  orphanId: number,
  id: string,
  opts: ApplyOpts
): Promise<ProposalResult> {
  const orphans = await query<any[]>(
    `SELECT * FROM reconciliation_ps_orphans WHERE id = ?`,
    [orphanId]
  );
  if (!orphans[0]) return { id, outcome: "error", detail: `reconciliation_ps_orphans row ${orphanId} not found` };
  const orphan = orphans[0];

  // --- Existence check: warehouse first, Xero live only if not found ---
  if (orphan.ps_reference) {
    const warehouseHit = await query<any[]>(
      `SELECT invoice_id FROM xero_invoice_balances
       WHERE tenant_id = ? AND reference = ? AND invoice_type = 'ACCREC'
         AND status NOT IN ('DELETED','VOIDED') LIMIT 1`,
      [tenantId, orphan.ps_reference]
    );
    if (warehouseHit[0]) {
      await execute(
        `UPDATE reconciliation_ps_orphans SET apply_status='skipped_exists', xero_draft_id=? WHERE id=?`,
        [warehouseHit[0].invoice_id, orphanId]
      );
      return {
        id,
        outcome: "skipped",
        xeroInvoiceId: warehouseHit[0].invoice_id,
        skipReason: "already_exists_in_xero",
      };
    }
    // Not in warehouse — verify live (catches invoices created since last sync)
    const existing = await writeClient.findInvoiceByReference(tenantId, orphan.ps_reference);
    if (existing) {
      await execute(
        `UPDATE reconciliation_ps_orphans SET apply_status='skipped_exists', xero_draft_id=? WHERE id=?`,
        [existing.InvoiceID, orphanId]
      );
      return {
        id,
        outcome: "skipped",
        xeroInvoiceId: existing.InvoiceID,
        skipReason: "already_exists_in_xero",
      };
    }
  }

  // --- Period lock (warning only for DRAFTs) ---
  const invoiceDateStr = orphan.ps_date
    ? String(orphan.ps_date instanceof Date ? orphan.ps_date.toISOString() : orphan.ps_date).substring(0, 10)
    : null;
  if (invoiceDateStr) {
    const lock = await writeClient.checkPeriodLock(tenantId, invoiceDateStr);
    if (lock.locked) {
      console.warn(
        `[orchestrator] Period-lock warning: ${orphan.ps_reference} date ${invoiceDateStr} ` +
        `falls in locked period (lock through ${lock.lockDate}). Continuing with DRAFT.`
      );
    }
  }

  // --- Load full PS order (customer name + line data) ---
  const ps = await loadPsOrderForInvoice(orphan.ps_reference);
  if (!ps) {
    return { id, outcome: "error", detail: `PS order not found for reference ${orphan.ps_reference}` };
  }

  // --- Build Xero invoice payload ---
  const buildResult = await buildInvoiceFromPsOrder(ps);
  if (buildResult.status === "flagged") {
    await execute(`UPDATE reconciliation_ps_orphans SET apply_status='flagged' WHERE id=?`, [orphanId]);
    return { id, outcome: "flagged", detail: buildResult.flag };
  }

  // --- Apply contact override if the agent provided one ---
  let payload = buildResult.payload as Record<string, any>;
  const contactOverride = opts.contactOverrides?.[ps.reference];
  if (contactOverride) {
    payload = { ...payload, Contact: { ContactID: contactOverride } };
  }

  // --- Idempotency key ---
  const ikey = createHash("sha256")
    .update(`CREATE_ACCREC:${ps.reference}:${tenantId}`)
    .digest("hex");

  // --- Create DRAFT invoice ---
  const created = await writeClient.createInvoice(tenantId, payload, ikey, ps.reference, opts.dryRun);
  const xeroInvoiceId: string = created.InvoiceID ?? "dry_run";

  // --- Attach PDF (non-blocking) ---
  if (!opts.dryRun && xeroInvoiceId !== "dry_run") {
    const pdf = await fetchInvoicePdf(ps.id_order, ikey, tenantId);
    if (pdf) {
      await writeClient.attachPdf(tenantId, xeroInvoiceId, pdf.filename, pdf.buffer, false);
    }
  }

  // --- Update orphan record ---
  await execute(
    `UPDATE reconciliation_ps_orphans SET apply_status=?, xero_draft_id=?, applied_at=NOW() WHERE id=?`,
    [opts.dryRun ? "dry_run" : "draft_created", xeroInvoiceId, orphanId]
  );

  return { id, outcome: "applied", xeroInvoiceId };
}

// ---------------------------------------------------------------------------
// ACCPAY: recode an existing Xero bill using a coding proposal
// ---------------------------------------------------------------------------
async function applyAccpay(
  tenantId: string,
  proposalId: number,
  id: string,
  opts: ApplyOpts
): Promise<ProposalResult> {
  const proposals = await query<any[]>(
    `SELECT * FROM coding_proposals WHERE id = ?`,
    [proposalId]
  );
  if (!proposals[0]) return { id, outcome: "error", detail: `coding_proposals row ${proposalId} not found` };
  const proposal = proposals[0];

  if (!proposal.xero_invoice_id) {
    return { id, outcome: "error", detail: "Proposal has no xero_invoice_id to update" };
  }
  if (!proposal.proposed_account_code) {
    return { id, outcome: "flagged", detail: "Proposal has no proposed_account_code — agent must resolve before applying" };
  }

  // Check lock on the bill's date
  if (proposal.transaction_date) {
    const dateStr = String(proposal.transaction_date instanceof Date
      ? proposal.transaction_date.toISOString()
      : proposal.transaction_date).substring(0, 10);
    const lock = await writeClient.checkPeriodLock(tenantId, dateStr);
    if (lock.locked) {
      console.warn(
        `[orchestrator] Period-lock warning for bill ${proposal.xero_invoice_id}: date ${dateStr} ` +
        `falls in locked period (lock through ${lock.lockDate}). Continuing with DRAFT update.`
      );
    }
  }

  const ikey = createHash("sha256")
    .update(`RECODE_ACCPAY:${proposal.xero_invoice_id}:${tenantId}`)
    .digest("hex");

  await writeClient.updateInvoiceCoding(
    tenantId,
    proposal.xero_invoice_id,
    proposal.proposed_account_code,
    proposal.proposed_tax_code ?? undefined,
    ikey,
    opts.dryRun
  );

  if (!opts.dryRun) {
    await execute(
      `UPDATE coding_proposals SET proposal_status='applied', applied_at=NOW() WHERE id=?`,
      [proposalId]
    );
  }

  return { id, outcome: "applied", xeroInvoiceId: proposal.xero_invoice_id };
}

// ---------------------------------------------------------------------------
// INBOX MATCH: create a DRAFT ACCPAY bill from an inbox file + spend orphan
// ---------------------------------------------------------------------------

export interface InboxMatchData {
  supplierName: string;
  amount: number;
  currency: string;
  date: string;        // YYYY-MM-DD
  description?: string;
  accountCode?: string;
  taxCode?: string;
}

interface ResolvedBillAmount {
  amount: number;
  currency: string;
  note?: string;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function resolveBillAmountFromSpendOrphan(orphan: any, extracted: InboxMatchData): Promise<ResolvedBillAmount> {
  const orphanAmount = Number(orphan.amount ?? extracted.amount);
  const orphanCurrency = orphan.currency ?? extracted.currency;
  const sourceId = String(orphan.xero_bank_tx_id ?? "");

  // Bank/Xero movement wins over document denomination. For Wise card lines, the
  // provider feed can be gross while Xero records the card fee separately.
  if (orphan.source_type === "STATEMENT_LINE" && sourceId.startsWith("CARD:")) {
    const feeRef = `FEE-${sourceId.replace(/:/g, "-")}`;
    const feeRows = await query<any[]>(
      `SELECT CAST(JSON_EXTRACT(payload, '$.Total') AS DECIMAL(18,4)) AS total
       FROM xero_raw_objects
       WHERE tenant_id = ?
         AND object_type = 'BANKTRANSACTION'
         AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.Type')) = 'SPEND'
         AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.Reference')) = ?
         AND (? IS NULL OR DATE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.DateString'))) BETWEEN DATE_SUB(?, INTERVAL 3 DAY) AND DATE_ADD(?, INTERVAL 3 DAY))
       ORDER BY fetched_at DESC
       LIMIT 1`,
      [orphan.tenant_id, feeRef, orphan.transaction_date ?? null, orphan.transaction_date ?? null, orphan.transaction_date ?? null]
    );

    const feeAmount = Math.abs(Number(feeRows[0]?.total ?? 0));
    if (feeAmount > 0) {
      return {
        amount: roundMoney(orphanAmount - feeAmount),
        currency: orphanCurrency,
        note: `Adjusted Wise gross statement amount ${orphanCurrency} ${orphanAmount.toFixed(2)} minus separately recorded Xero fee ${orphanCurrency} ${feeAmount.toFixed(2)} (${feeRef}).`,
      };
    }
  }

  if (orphan.currency && extracted.currency !== orphan.currency) {
    return {
      amount: roundMoney(orphanAmount),
      currency: orphanCurrency,
      note: `Used bank/account currency ${orphanCurrency} ${orphanAmount.toFixed(2)}; document amount ${extracted.currency} ${extracted.amount.toFixed(2)} is matching evidence only.`,
    };
  }

  return { amount: roundMoney(orphanAmount), currency: orphanCurrency };
}

export async function applyInboxMatch(
  tenantId: string,
  fileId: string,
  orphanId: number,
  extracted: InboxMatchData,
  opts: ApplyOpts
): Promise<ProposalResult> {
  const id = `inbox:${fileId}:${orphanId}`;

  const orphans = await query<any[]>(
    `SELECT * FROM bank_spend_orphans WHERE id = ? AND tenant_id = ?`,
    [orphanId, tenantId]
  );
  if (!orphans[0]) return { id, outcome: "error", detail: `bank_spend_orphans row ${orphanId} not found` };
  const orphan = orphans[0];

  if (!["flagged", "chasing", "received", "matched"].includes(orphan.status)) {
    return { id, outcome: "skipped", skipReason: `orphan status is '${orphan.status}' — already coded or dismissed` };
  }

  // Existence check: warehouse first, Xero live only if not found
  const spendRef = `SPEND:${orphan.xero_bank_tx_id}`;
  const warehouseHit = await query<any[]>(
    `SELECT invoice_id FROM xero_invoice_balances
     WHERE tenant_id = ? AND reference = ? AND invoice_type = 'ACCPAY'
       AND status NOT IN ('DELETED','VOIDED') LIMIT 1`,
    [tenantId, spendRef]
  );
  if (warehouseHit[0]) {
    await execute(
      `UPDATE bank_spend_orphans SET status='coded', matched_invoice_id=? WHERE id=?`,
      [warehouseHit[0].invoice_id, orphanId]
    );
    return { id, outcome: "skipped", xeroInvoiceId: warehouseHit[0].invoice_id, skipReason: "bill_already_exists" };
  }
  const existing = await writeClient.findInvoiceByReference(tenantId, spendRef, "ACCPAY");
  if (existing) {
    await execute(
      `UPDATE bank_spend_orphans SET status='coded', matched_invoice_id=? WHERE id=?`,
      [existing.InvoiceID, orphanId]
    );
    return { id, outcome: "skipped", xeroInvoiceId: existing.InvoiceID, skipReason: "bill_already_exists" };
  }

  // Period lock warning
  const lock = await writeClient.checkPeriodLock(tenantId, extracted.date);
  if (lock.locked) {
    console.warn(
      `[orchestrator] Period-lock warning for inbox match ${fileId}: date ${extracted.date} ` +
      `falls in locked period (lock through ${lock.lockDate}). Continuing with DRAFT.`
    );
  }

  // Look up or resolve contact override
  const contactName = extracted.supplierName;
  const contactOverride = opts.contactOverrides?.[`inbox:${fileId}`];
  const contact = contactOverride
    ? { ContactID: contactOverride }
    : { Name: contactName };
  const billAmount = await resolveBillAmountFromSpendOrphan(orphan, extracted);

  const billPayload = {
    Contact: contact,
    Date: extracted.date,
    DueDate: extracted.date,
    Reference: `SPEND:${orphan.xero_bank_tx_id}`,
    CurrencyCode: billAmount.currency,
    LineItems: [
      {
        Description: extracted.description ?? contactName,
        Quantity: 1,
        UnitAmount: billAmount.amount,
        AccountCode: extracted.accountCode ?? "850",
        ...(extracted.taxCode ? { TaxType: extracted.taxCode } : {}),
      },
    ],
  };

  const ikey = createHash("sha256")
    .update(`CREATE_BILL_INBOX:${orphan.xero_bank_tx_id}:${tenantId}`)
    .digest("hex");

  const created = await writeClient.createBill(tenantId, billPayload, ikey, `SPEND:${orphan.xero_bank_tx_id}`, opts.dryRun);
  const xeroInvoiceId: string = created.InvoiceID ?? "dry_run";

  // Attach the inbox file to the bill
  if (!opts.dryRun && xeroInvoiceId !== "dry_run") {
    try {
      const { buffer, mimeType } = await filesClient.downloadFile(tenantId, fileId);
      const ext = mimeType.includes("pdf") ? "pdf" : mimeType.includes("png") ? "png" : "jpg";
      const safeSourceId = orphan.xero_bank_tx_id.replace(/[^A-Za-z0-9._-]/g, "-");
      await writeClient.attachPdf(tenantId, xeroInvoiceId, `receipt-${safeSourceId}.${ext}`, buffer, false);
    } catch (err) {
      console.warn(`[orchestrator] Could not attach inbox file ${fileId} to bill: ${err}`);
    }

    // Update statuses
    await execute(
      `UPDATE bank_spend_orphans SET status='coded', matched_file_id=?, matched_invoice_id=? WHERE id=?`,
      [fileId, xeroInvoiceId, orphanId]
    );
    await execute(
      `UPDATE xero_inbox_files SET status='matched', matched_orphan_id=?, matched_invoice_id=? WHERE tenant_id=? AND file_id=?`,
      [orphanId, xeroInvoiceId, tenantId, fileId]
    );
    // Close the decision queue entry
    await execute(
      `UPDATE decision_queue SET status='answered', answered_by='agent', answered_at=NOW(),
         answer='Bill created: Xero invoice ${xeroInvoiceId}'
       WHERE queue_key=? AND status='open'`,
      [`SPEND_ORPHAN:${orphan.xero_bank_tx_id}`]
    );
  } else if (opts.dryRun) {
    await execute(
      `UPDATE bank_spend_orphans SET notes=? WHERE id=?`,
      [
        `dry_run: would create bill for ${extracted.supplierName} ${billAmount.currency} ${billAmount.amount}` +
          (billAmount.note ? ` (${billAmount.note})` : ""),
        orphanId
      ]
    );
  }

  return { id, outcome: "applied", xeroInvoiceId, detail: billAmount.note };
}
