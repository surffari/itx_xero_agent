/**
 * Decision logic for the CURO / TagadaPay clearing workflow.
 *
 * Pure functions only (no DB, no network) so every safety rule is unit-testable.
 * The script scripts/clearing-sync.mjs gathers the facts and acts on the verdict.
 *
 * Rule of thumb: POST only when every fact agrees. Anything uncertain is REVIEW
 * with a reason; nothing is ever posted for a REVIEW row.
 */

export type Processor = "CURO" | "TAGADA";

/** Xero clearing accounts (payments enabled). 209 Curo Settlement Clearing, 210 TagadaPay Settlement Clearing. */
export const CLEARING_ACCOUNT: Record<Processor, string> = { CURO: "209", TAGADA: "210" };

export interface ClearingFacts {
  processor: Processor;
  reference: string;
  /** Shop order data */
  orderValid: boolean;
  orderGross: number;
  orderCurrency: string;
  shopVatRatePct: number | null;
  shipCountry: string;
  /** Processor data (null when the processor has no confirmed success for this order) */
  processorTxnId: string | null;
  processorAmount: number | null;
  processorCurrency: string | null;
  processorTxnCount: number;
  processorRefunded: boolean;
  /** Xero invoices found for this reference or invoice number (live or warehouse) */
  xeroInvoices: Array<{
    status: string;
    total: number;
    amountDue: number;
    amountPaid: number;
    currency: string;
  }>;
  /** Effective rate (%) of the Xero tax type the builder would use; null = no tax type configured */
  builderTaxRatePct: number | null;
  /** Processor transaction id already used on a payment or a write-log entry */
  txnAlreadyPosted: boolean;
}

export type Action = "POST_PAYMENT" | "CREATE_DRAFT_INVOICE" | "WAIT_APPROVAL" | "NOTHING" | "REVIEW";

export interface Verdict {
  action: Action;
  reasons: string[];
}

const EPS = 0.005;
/** Shop-rate vs Xero-rate tolerance (percentage points). Mixed shipping/product rounding stays inside this. */
const VAT_TOLERANCE_PP = 0.15;

export function vatMatches(shopRate: number | null, xeroRate: number | null): boolean {
  if (shopRate == null || xeroRate == null) return false;
  return Math.abs(shopRate - xeroRate) <= VAT_TOLERANCE_PP;
}

export function classifyClearing(f: ClearingFacts): Verdict {
  const review: string[] = [];

  // --- Processor facts ---
  if (!f.orderValid) review.push("order not valid in shop");
  if (f.processorRefunded) review.push("processor payment refunded");
  if (!f.processorTxnId) review.push("no confirmed successful processor payment");
  if (f.processorTxnCount > 1 && f.processor === "CURO") review.push("multiple CardGate transactions for order");
  if (f.processorAmount != null && Math.abs(f.processorAmount - f.orderGross) > EPS) {
    review.push(`processor amount ${f.processorAmount} != order ${f.orderGross}`);
  }
  if (f.processorCurrency && f.processorCurrency !== f.orderCurrency) {
    review.push(`processor currency ${f.processorCurrency} != order ${f.orderCurrency}`);
  }
  if (f.txnAlreadyPosted) review.push("processor transaction already posted (duplicate guard)");

  // --- Xero invoice facts ---
  if (f.xeroInvoices.length > 1) {
    review.push(`${f.xeroInvoices.length} Xero invoices carry this reference (possible duplicate)`);
  }
  const inv = f.xeroInvoices.length === 1 ? f.xeroInvoices[0] : null;

  if (!inv && f.xeroInvoices.length === 0) {
    // No invoice yet: may create a DRAFT, but only when VAT is demonstrably right.
    if (f.builderTaxRatePct == null) review.push(`no Xero tax type configured for ${f.shipCountry}`);
    else if (!vatMatches(f.shopVatRatePct, f.builderTaxRatePct)) {
      review.push(`VAT mismatch: shop charged ${f.shopVatRatePct}% but Xero rate for ${f.shipCountry} is ${f.builderTaxRatePct}%`);
    }
    if (review.length) return { action: "REVIEW", reasons: review };
    return { action: "CREATE_DRAFT_INVOICE", reasons: ["invoice missing in Xero; VAT rate matches shop"] };
  }

  if (inv) {
    if (Math.abs(inv.total - f.orderGross) > EPS) review.push(`Xero total ${inv.total} != order ${f.orderGross}`);
    if (inv.currency !== f.orderCurrency) review.push(`Xero currency ${inv.currency} != order ${f.orderCurrency}`);
    if (inv.status === "VOIDED" || inv.status === "DELETED") review.push(`Xero invoice is ${inv.status}`);
    if (inv.amountPaid > EPS || inv.status === "PAID") {
      // Already settled (manually or by bank rec): nothing to do unless something else is off.
      return review.length
        ? { action: "REVIEW", reasons: ["invoice already has a payment", ...review] }
        : { action: "NOTHING", reasons: ["invoice already paid"] };
    }
    // Foreign-currency payments into a base-currency clearing account need a rate decision.
    if (f.orderCurrency !== "EUR") review.push(`non-EUR (${f.orderCurrency}): clearing accounts are EUR, exchange-rate treatment not decided`);
    if (review.length) return { action: "REVIEW", reasons: review };
    if (inv.status === "DRAFT" || inv.status === "SUBMITTED") {
      return { action: "WAIT_APPROVAL", reasons: [`invoice is ${inv.status}; approve in Xero, then re-run`] };
    }
    if (inv.status !== "AUTHORISED") return { action: "REVIEW", reasons: [`unexpected Xero status ${inv.status}`] };
    if (Math.abs(inv.amountDue - f.orderGross) > EPS) return { action: "REVIEW", reasons: [`amount due ${inv.amountDue} != order ${f.orderGross}`] };
    return { action: "POST_PAYMENT", reasons: ["all facts agree"] };
  }

  return { action: "REVIEW", reasons: review.length ? review : ["unclassified"] };
}
