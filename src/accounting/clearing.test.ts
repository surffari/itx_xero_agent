import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClearing, vatMatches, type ClearingFacts } from "./clearing.js";

const base: ClearingFacts = {
  processor: "TAGADA",
  reference: "ABC",
  orderValid: true,
  orderGross: 107,
  orderCurrency: "EUR",
  shopVatRatePct: 7,
  shipCountry: "DE",
  processorTxnId: "pay_1",
  processorAmount: 107,
  processorCurrency: "EUR",
  processorTxnCount: 1,
  processorRefunded: false,
  xeroInvoices: [{ status: "AUTHORISED", total: 107, amountDue: 107, amountPaid: 0, currency: "EUR" }],
  builderTaxRatePct: 7,
  txnAlreadyPosted: false,
};

test("all facts agree -> POST_PAYMENT", () => {
  assert.equal(classifyClearing(base).action, "POST_PAYMENT");
});

test("draft invoice waits for approval", () => {
  const v = classifyClearing({ ...base, xeroInvoices: [{ ...base.xeroInvoices[0], status: "DRAFT" }] });
  assert.equal(v.action, "WAIT_APPROVAL");
});

test("already paid -> NOTHING (no duplicate payment)", () => {
  const v = classifyClearing({ ...base, xeroInvoices: [{ ...base.xeroInvoices[0], status: "PAID", amountDue: 0, amountPaid: 107 }] });
  assert.equal(v.action, "NOTHING");
});

test("duplicate Xero invoices -> REVIEW", () => {
  const v = classifyClearing({ ...base, xeroInvoices: [base.xeroInvoices[0], base.xeroInvoices[0]] });
  assert.equal(v.action, "REVIEW");
});

test("txn already posted -> REVIEW", () => {
  assert.equal(classifyClearing({ ...base, txnAlreadyPosted: true }).action, "REVIEW");
});

test("amount mismatch -> REVIEW", () => {
  assert.equal(classifyClearing({ ...base, processorAmount: 106 }).action, "REVIEW");
  const v = classifyClearing({ ...base, xeroInvoices: [{ ...base.xeroInvoices[0], total: 115.61, amountDue: 115.61 }] });
  assert.equal(v.action, "REVIEW");
});

test("GBP is held for review", () => {
  const v = classifyClearing({
    ...base,
    orderCurrency: "GBP",
    processorCurrency: "GBP",
    xeroInvoices: [{ ...base.xeroInvoices[0], currency: "GBP" }],
  });
  assert.equal(v.action, "REVIEW");
});

test("no processor success -> REVIEW", () => {
  assert.equal(classifyClearing({ ...base, processorTxnId: null, processorAmount: null }).action, "REVIEW");
});

test("refunded -> REVIEW", () => {
  assert.equal(classifyClearing({ ...base, processorRefunded: true }).action, "REVIEW");
});

test("missing invoice with matching VAT -> CREATE_DRAFT_INVOICE", () => {
  assert.equal(classifyClearing({ ...base, xeroInvoices: [] }).action, "CREATE_DRAFT_INVOICE");
});

test("missing invoice with wrong VAT rate -> REVIEW", () => {
  const v = classifyClearing({ ...base, xeroInvoices: [], shopVatRatePct: 0, builderTaxRatePct: 23 });
  assert.equal(v.action, "REVIEW");
});

test("missing invoice with no tax type -> REVIEW", () => {
  assert.equal(classifyClearing({ ...base, xeroInvoices: [], builderTaxRatePct: null }).action, "REVIEW");
});

test("vatMatches tolerance", () => {
  assert.equal(vatMatches(9, 9), true);
  assert.equal(vatMatches(9.2, 9), false);
  assert.equal(vatMatches(null, 9), false);
});
