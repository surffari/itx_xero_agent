// Bills Management (Phase 1, R7-R11): classifies a mailbox_invoice_files row into the
// business-facing bills_status lifecycle added by migrations/010_bills_management_status.sql.
// Reads the agent's existing `status` and extracted_* columns but never writes to them,
// and never calls the live Xero API — this module is pure decision logic plus one
// read-only duplicate-check query against the local xero_invoice_balances warehouse
// table (the same lookup create_bill_from_mailbox_file already runs before it creates
// a live bill). Persisting the decision is a separate, explicit step (see apply-status.ts).
//
// Also gates Ready for Xero on account/VAT determination (account-coding.ts) — a document
// is never staged for Xero without a confidently-determined account code and tax
// treatment, per the approved account mapping / Tax SOP. No confident determination ->
// Needs Review, never a silent 850/Tax Exempt default.

import { determineAccountAndTax, type InvoiceFacts, type SupplierTaxProfileFacts } from "./account-coding.js";

export type BillsStatus =
  | "incoming"
  | "ready_for_xero"
  | "uploaded_to_xero"
  | "needs_review"
  | "exceptions";

export type DuplicateCheckResult = "not_checked" | "unique" | "duplicate";

export interface MailboxFileRow {
  id: number;
  status: "new" | "processing" | "matched" | "no_match" | "error";
  matched_orphan_id: number | null;
  matched_invoice_id: string | null;
  extracted_supplier: string | null;
  extracted_amount: number | null;
  extracted_currency: string | null;
  extracted_date: string | null; // YYYY-MM-DD
}

export interface RoutingResult {
  bills_status: BillsStatus;
  bills_status_reason: string | null;
  duplicate_check_result: DuplicateCheckResult;
  duplicate_check_reference: string | null;
  account_code: string | null;
  tax_code: string | null;
}

export interface DuplicateMatch {
  invoice_id: string;
  invoice_number: string | null;
  reference: string | null;
  contact_name?: string | null;
  status?: string | null;
  total?: number | null;
  currency_code?: string | null;
  invoice_date?: string | null;
}

export type QueryFn = (sql: string, args: unknown[]) => Promise<DuplicateMatch[]>;

/**
 * mysql2 returns DATE columns as JS Date objects, not strings, even though
 * MailboxFileRow types extracted_date as `string | null` — normalize defensively at
 * every read site rather than trust the declared type against a live DB row.
 */
function normalizeDateString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || Number.isNaN(Date.parse(trimmed))) return null;
    return trimmed;
  }
  return null;
}

/**
 * Pure validation: is the extraction complete enough to attempt Ready for Xero?
 * Deliberately conservative — R8 says never guess, so any missing/nonsensical field
 * routes to Needs Review instead of a best-effort attempt.
 */
export function evaluateExtraction(row: MailboxFileRow): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!row.extracted_supplier || !row.extracted_supplier.trim()) missing.push("supplier");
  if (row.extracted_amount == null || !(row.extracted_amount > 0)) missing.push("amount");
  if (!row.extracted_currency || !/^[A-Z]{3}$/.test(row.extracted_currency)) missing.push("currency");
  if (!normalizeDateString(row.extracted_date)) missing.push("date");
  return { complete: missing.length === 0, missing };
}

/**
 * Duplicate check against the local xero_invoice_balances warehouse table. This is the
 * single duplicate-detection algorithm for mailbox-sourced ACCPAY bills — both the Phase 1
 * bills_status classification (routeMailboxFile, below) and the live write path
 * (create_bill_from_mailbox_file, src/mcp/server.ts) call this function rather than each
 * keeping their own copy. Takes a queryFn so it is testable without a database connection.
 *
 * Matches on:
 *   1. Exact reference, invoice_number, or invoice_id (matched_invoice_id) equality.
 *   2. Supplier + amount + invoice date, ALL THREE together, when reference is missing or
 *      doesn't match anything (Q9/D17: reference-only matching missed a real duplicate for
 *      exactly this reason).
 * Deliberately never matches on supplier + amount alone (e.g. a recurring subscription
 * charged the same amount every month would otherwise false-positive every cycle) — a
 * different invoice date, or a different amount, on an otherwise-matching supplier is a
 * legitimate distinct bill, not a duplicate, and falls through to normal validation.
 */
export async function checkDuplicate(
  row: MailboxFileRow,
  params: { tenantId: string; reference: string | null; invoiceNumber: string | null },
  queryFn: QueryFn
): Promise<{ result: DuplicateCheckResult; reference: string | null; match: DuplicateMatch | null }> {
  // Never claim "unique" without enough information to actually verify it: a blank
  // tenant ID makes the whole lookup meaningless (it would just match nothing, which is
  // not the same as confirming nothing matches), and whitespace-only reference/invoice
  // number strings are not real values to check against.
  const tenantId = params.tenantId?.trim();
  const reference = params.reference?.trim() || null;
  const invoiceNumber = params.invoiceNumber?.trim() || null;
  const matchedInvoiceId = row.matched_invoice_id?.trim() || null;

  const supplierName = row.extracted_supplier?.trim() || null;
  const amount = row.extracted_amount;
  const invoiceDate = normalizeDateString(row.extracted_date);
  const hasKeyDetails = !!supplierName && amount != null && amount > 0 && !!invoiceDate;

  if (!tenantId || (!reference && !invoiceNumber && !matchedInvoiceId && !hasKeyDetails)) {
    return { result: "not_checked", reference: null, match: null };
  }
  const rows = await queryFn(
    `SELECT invoice_id, invoice_number, reference, contact_name, status, total, currency_code, invoice_date
     FROM xero_invoice_balances
     WHERE tenant_id=?
       AND invoice_type='ACCPAY'
       AND status NOT IN ('DELETED','VOIDED')
       AND (
         (? IS NOT NULL AND reference = ?)
         OR (? IS NOT NULL AND invoice_number = ?)
         OR (? IS NOT NULL AND invoice_id = ?)
         OR (? AND LOWER(contact_name) = LOWER(?) AND invoice_date = ? AND ROUND(total, 2) = ROUND(?, 2))
       )
     LIMIT 5`,
    [
      tenantId,
      reference, reference,
      invoiceNumber, invoiceNumber,
      matchedInvoiceId, matchedInvoiceId,
      hasKeyDetails, supplierName, invoiceDate, amount,
    ]
  );
  if (rows.length === 0) return { result: "unique", reference: null, match: null };
  return { result: "duplicate", reference: rows[0].invoice_id, match: rows[0] };
}

/**
 * Full Phase 1 routing decision for one mailbox_invoice_files row:
 *   Incoming -> validate + duplicate check
 *   valid and complete, unique -> Ready for Xero
 *   unclear/incomplete -> Needs Review
 *   confirmed duplicate, non-invoice, or processing failure -> Exceptions
 *   already has a live Xero bill -> Uploaded to Xero
 * Read-only: never writes to `status`, bills_status, Xero, or Nextcloud. Callers decide
 * whether/how to persist the result via apply-status.ts.
 */
export async function routeMailboxFile(
  row: MailboxFileRow,
  ctx: {
    tenantId: string;
    reference: string | null;
    invoiceNumber: string | null;
    queryFn: QueryFn;
    invoiceFacts?: InvoiceFacts;
    supplierProfile?: SupplierTaxProfileFacts | null;
  }
): Promise<RoutingResult> {
  // Already turned into a live Xero bill by the existing agent flow — reflect that, don't re-decide it.
  if (row.matched_invoice_id) {
    return {
      bills_status: "uploaded_to_xero",
      bills_status_reason: `Xero ACCPAY bill ${row.matched_invoice_id} already created`,
      duplicate_check_result: "not_checked",
      duplicate_check_reference: row.matched_invoice_id,
      account_code: null,
      tax_code: null,
    };
  }

  // R11: a processing failure is an exception, not a silent retry loop.
  if (row.status === "error") {
    return {
      bills_status: "exceptions",
      bills_status_reason: "Agent processing failed for this attachment (status=error)",
      duplicate_check_result: "not_checked",
      duplicate_check_reference: null,
      account_code: null,
      tax_code: null,
    };
  }

  // Nothing extracted yet at all (as opposed to a partial/incomplete extraction, which
  // falls through to validation below) — nothing to route yet, stays Incoming.
  const hasAnyExtraction =
    row.extracted_supplier != null ||
    row.extracted_amount != null ||
    row.extracted_currency != null ||
    row.extracted_date != null;
  if (row.status === "new" || (row.status === "processing" && !hasAnyExtraction)) {
    return {
      bills_status: "incoming",
      bills_status_reason: null,
      duplicate_check_result: "not_checked",
      duplicate_check_reference: null,
      account_code: null,
      tax_code: null,
    };
  }

  // R8/R10: extraction attempted but incomplete/uncertain — never guess, route to a human.
  const { complete, missing } = evaluateExtraction(row);
  if (!complete) {
    return {
      bills_status: "needs_review",
      bills_status_reason: `Missing or invalid: ${missing.join(", ")}`,
      duplicate_check_result: "not_checked",
      duplicate_check_reference: null,
      account_code: null,
      tax_code: null,
    };
  }

  // The agent inspected this and could not confidently match/code it. Treated as Needs
  // Review, not a confirmed Exception — "no_match" alone doesn't prove it's a non-invoice,
  // and this project's non-negotiable rule is to route uncertainty to a human, not guess.
  if (row.status === "no_match") {
    return {
      bills_status: "needs_review",
      bills_status_reason: "Agent could not confidently match/code this document",
      duplicate_check_result: "not_checked",
      duplicate_check_reference: null,
      account_code: null,
      tax_code: null,
    };
  }

  // Complete extraction — check for a confirmed duplicate before staging for Xero.
  const dup = await checkDuplicate(row, ctx, ctx.queryFn);
  if (dup.result === "duplicate") {
    return {
      bills_status: "exceptions",
      bills_status_reason: `Confirmed duplicate of existing Xero bill ${dup.reference}`,
      duplicate_check_result: "duplicate",
      duplicate_check_reference: dup.reference,
      account_code: null,
      tax_code: null,
    };
  }

  // Unique and complete, but Ready for Xero also requires a confidently-determined
  // account code AND VAT/tax treatment — never 850 Suspense / Tax Exempt by default.
  // No invoiceFacts supplied at all means "not yet determined", not "assume clean".
  if (!ctx.invoiceFacts) {
    return {
      bills_status: "needs_review",
      bills_status_reason: "Account code and VAT treatment not yet determined (no invoice facts supplied)",
      duplicate_check_result: dup.result,
      duplicate_check_reference: null,
      account_code: null,
      tax_code: null,
    };
  }

  const coding = determineAccountAndTax(ctx.invoiceFacts, ctx.supplierProfile ?? null);
  if (!coding.confident) {
    return {
      bills_status: "needs_review",
      bills_status_reason: coding.reason,
      duplicate_check_result: dup.result,
      duplicate_check_reference: null,
      account_code: coding.accountCode,
      tax_code: coding.taxCode,
    };
  }

  // Clean, complete, unique, and confidently coded — staged for Xero DRAFT creation.
  return {
    bills_status: "ready_for_xero",
    bills_status_reason: coding.reason,
    duplicate_check_result: dup.result,
    duplicate_check_reference: null,
    account_code: coding.accountCode,
    tax_code: coding.taxCode,
  };
}
