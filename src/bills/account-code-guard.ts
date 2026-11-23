// Bills Management: guards the one piece of account-coding enforcement that actually sits
// in the live Xero write path (create_bill_from_mailbox_file). Everything else in this
// project's account-coding logic (account-coding.ts, routing.ts) only decides the local
// bills_status tracking column -- it is never consulted before a real Xero write. This
// module is the minimum real safety net for that write: it never lets a bill reach Xero
// with an account code that is missing, misspelled, archived, or obviously the wrong kind
// of account, and it never lets 850 Suspense through silently (knowledge/rule-register.md
// IAR-009: Suspense is temporary only -- it must never be a default for ordinary spend).
//
// Pure decision logic over facts the caller supplies (the synced xero_accounts rows) --
// no DB or Xero calls here, so it's directly unit-testable. See account-code-guard.test.ts.

export interface XeroAccountRef {
  code: string;
  name: string;
  type: string;
  status: string;
}

export interface AccountCodeCheck {
  ok: boolean;
  /** Present when ok=false. Verbatim-safe to return to the caller as the Needs Review reason. */
  reason?: string;
}

export const SUSPENSE_CODE = "850";

// Account types that can never be correct on a supplier bill (ACCPAY) line, regardless of
// what code was typed in -- a bank account, a revenue/sales account, or equity are never
// the right place to code a purchase. (Mirrors the IAR-001 principle -- "200 is sales-only:
// any purchase ... posted to 200 is wrong" -- generalised to every revenue-shaped account.)
const NEVER_VALID_FOR_BILL_TYPES = new Set(["BANK", "REVENUE", "SALES", "EQUITY"]);

/**
 * Decide whether `accountCode` may be used to create a real ACCPAY bill line.
 *
 * Refuses (ok:false) when the code is:
 *   - missing / blank ("unresolved" -- nothing was supplied to code the bill with)
 *   - not found in the synced Xero chart of accounts ("invalid" -- mistyped, or not synced)
 *   - found but ARCHIVED, or of a type that can never be correct for a bill ("invalid")
 *   - exactly 850 Suspense with no `accountCodeReason` ("unresolved" in disguise -- 850
 *     must be an explicit, justified choice per IAR-009, never a fallback)
 *
 * Accepts (ok:true) an ACTIVE, bill-appropriate account code, and 850 specifically only
 * when a non-empty `accountCodeReason` citing the legitimate temporary-holding case
 * (card check, refund, failed/duplicated/pending transaction -- IAR-009) is supplied.
 */
export function checkAccountCodeForBill(
  accountCode: string | null | undefined,
  accountCodeReason: string | null | undefined,
  accounts: readonly XeroAccountRef[]
): AccountCodeCheck {
  const code = (accountCode ?? "").trim();
  if (!code) {
    return {
      ok: false,
      reason:
        "account_code is required and was not supplied — account coding must be resolved " +
        "before a bill can be created. This never defaults to 850 Suspense or any other " +
        "code. Route to Needs Review and determine the account code from the rule register " +
        "(knowledge/rule-register.md) or a verified supplier profile before retrying.",
    };
  }

  const match = accounts.find((a) => a.code === code);
  if (!match) {
    return {
      ok: false,
      reason:
        `account_code "${code}" was not found in the synced Xero chart of accounts ` +
        "(xero_accounts) — it may be mistyped, or the chart hasn't been synced recently " +
        "(run sync_reference). Route to Needs Review rather than guessing.",
    };
  }

  if (match.status !== "ACTIVE") {
    return {
      ok: false,
      reason:
        `account_code "${code}" (${match.name}) is ${match.status} in Xero, not ACTIVE — ` +
        "cannot code a new bill to an archived or inactive account. Route to Needs Review.",
    };
  }

  if (NEVER_VALID_FOR_BILL_TYPES.has(match.type)) {
    return {
      ok: false,
      reason:
        `account_code "${code}" (${match.name}) is a ${match.type} account — that type can ` +
        "never be correct on a supplier bill line. Route to Needs Review.",
    };
  }

  if (code === SUSPENSE_CODE) {
    const reason = (accountCodeReason ?? "").trim();
    if (!reason) {
      return {
        ok: false,
        reason:
          "account_code 850 (Suspense) requires an explicit account_code_reason citing why " +
          "this is a legitimate temporary-holding case per IAR-009 (e.g. a card check, a " +
          "refund, a failed/duplicated/pending transaction, or a short-lived clearing item) " +
          "— Suspense is never a default or an unexplained choice. Route to Needs Review.",
      };
    }
  }

  return { ok: true };
}
