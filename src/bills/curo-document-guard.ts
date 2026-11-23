// Bills Management: encodes two CURO Payments B.V. standing rules directly in the write
// path. Both previously existed only as prose in PLAN.md, a document this one project's
// Claude sessions happen to read -- nothing in intactix_accounting_agent itself enforced
// either of them, so a different session, a less careful pass, or a future reduction in
// manual review would have no way to know they exist. See the Xero Agent gap analysis,
// P0-4.
//
// Pure decision logic, no DB/Xero calls -- see curo-document-guard.test.ts.

export interface CuroDocumentCheck {
  ok: boolean;
  /** Present when ok=false. Verbatim-safe to return to the caller as the refusal reason. */
  reason?: string;
}

function mentionsCuro(supplierName: string, attachmentFilename: string | null | undefined): boolean {
  const haystack = `${supplierName} ${attachmentFilename ?? ""}`;
  return /\bcuro\b/i.test(haystack);
}

/**
 * Decide whether a CURO Payments B.V. document may proceed to bill creation.
 *
 * Returns ok:true immediately for anything that doesn't mention CURO at all -- this guard
 * only ever touches CURO documents, never any other supplier.
 *
 * For a CURO document, classifies by the document-type word in its filename:
 *   - "Settlement" -> hard block (D30, 2026-09-24: Kayne — "if theres a word settlement in
 *     curo do not draft it"). The net-payout receipt, money owed TO Intactix, never a
 *     purchase, regardless of account_code or any other input.
 *   - "Statement" -> blocked as receivables/payment-processor paperwork (Q10, open as of
 *     2026-09-24 — what these represent is still pending Kayne's conversation with Jani —
 *     but under no resolution of that open question does a Statement become an ACCPAY bill).
 *   - "Invoice" -> blocked (D36, 2026-10-01: Kayne — "the request for payment will be
 *     under exceptions"). The processing-fee "request for payment" pattern is Exceptions,
 *     not a payable to code and draft.
 *   - anything else mentioning CURO -> blocked defensively. CURO documents have
 *     repeatedly turned out not to be straightforward payables; an unrecognised pattern is
 *     routed to a human rather than assumed safe.
 */
export function checkCuroDocument(
  supplierName: string,
  attachmentFilename: string | null | undefined
): CuroDocumentCheck {
  if (!mentionsCuro(supplierName, attachmentFilename)) {
    return { ok: true };
  }

  const filename = attachmentFilename ?? "";

  if (/\bsettlement\b/i.test(filename)) {
    return {
      ok: false,
      reason:
        'Standing rule (D30): a CURO document with "Settlement" in the filename is the ' +
        "net-payout receipt — money owed TO Intactix from processed card payments, never " +
        "a purchase. Never drafted as a Xero bill, regardless of account_code or any other " +
        "input. This is a hard block, not a judgment call to reconsider.",
    };
  }

  if (/\bstatement\b/i.test(filename)) {
    return {
      ok: false,
      reason:
        "A CURO Statement document is receivables/payment-processor paperwork, not a " +
        "vendor bill (Q10, open since 2026-09-24: what these represent is still pending " +
        "Kayne's conversation with Jani) — under no resolution of that open question does " +
        "a Statement become an ACCPAY bill. Refusing.",
    };
  }

  if (/\binvoice\b/i.test(filename)) {
    return {
      ok: false,
      reason:
        'Standing rule (D36, 2026-10-01): a CURO "request for payment" document (the ' +
        'processing-fee "Invoice C..." pattern) is Exceptions, not a payable to code and ' +
        'draft — Kayne: "the request for payment will be under exceptions". Route to ' +
        "Exceptions rather than creating a bill.",
    };
  }

  return {
    ok: false,
    reason:
      `This document mentions CURO ("${supplierName}"` +
      (attachmentFilename ? `, filename "${attachmentFilename}"` : "") +
      ") but matches none of the known CURO document patterns (Settlement/Statement/" +
      "Invoice). CURO documents have repeatedly turned out not to be straightforward " +
      "payables — route to Needs Review rather than assuming this one is safe to draft.",
  };
}
