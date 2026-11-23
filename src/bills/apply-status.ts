// Bills Management (Phase 1): persists a RoutingResult (routing.ts) onto the bills_status
// columns added by migrations/010_bills_management_status.sql. Never touches the existing
// `status` column and never calls Xero or Nextcloud. `apply=false` (the default everywhere
// this is called in Phase 1) makes every call a dry run — nothing is written; the caller
// gets back exactly what WOULD be written, for review before any live change.
import type { RoutingResult } from "./routing.js";

export interface ApplyDeps {
  execute: (sql: string, args: unknown[]) => Promise<unknown>;
}

export async function applyBillsStatus(
  fileId: number,
  result: RoutingResult,
  deps: ApplyDeps,
  apply: boolean
): Promise<{ applied: boolean; result: RoutingResult }> {
  if (!apply) {
    return { applied: false, result };
  }
  await deps.execute(
    `UPDATE mailbox_invoice_files
     SET bills_status=?,
         bills_status_reason=?,
         bills_status_changed_at=NOW(),
         duplicate_check_result=?,
         duplicate_check_reference=?
     WHERE id=? AND bills_status <> ?`,
    [
      result.bills_status,
      result.bills_status_reason,
      result.duplicate_check_result,
      result.duplicate_check_reference,
      fileId,
      result.bills_status,
    ]
  );
  return { applied: true, result };
}

/**
 * Completes the Ready for Xero -> Uploaded to Xero leg of the approved workflow. This
 * does NOT create the Xero bill itself — it only records that bills_status should move
 * to uploaded_to_xero, and is meant to be called immediately after the existing, already
 * tested `create_bill_from_mailbox_file` tool succeeds with dry_run=false. Keeping the
 * live Xero write in that one existing code path (rather than duplicating it here) means
 * this module never performs a live write on its own — it only reflects one that already
 * happened, via the same tool this project's own risk register names as the safe pattern.
 */
export async function markUploadedAfterDraftCreated(
  fileId: number,
  xeroInvoiceId: string,
  deps: ApplyDeps,
  apply: boolean,
  codedAs?: { accountCode: string; taxCode: string }
): Promise<{ applied: boolean; result: RoutingResult }> {
  const result: RoutingResult = {
    bills_status: "uploaded_to_xero",
    bills_status_reason: `Xero ACCPAY bill ${xeroInvoiceId} created`,
    duplicate_check_result: "unique",
    duplicate_check_reference: xeroInvoiceId,
    account_code: codedAs?.accountCode ?? null,
    tax_code: codedAs?.taxCode ?? null,
  };
  return applyBillsStatus(fileId, result, deps, apply);
}
