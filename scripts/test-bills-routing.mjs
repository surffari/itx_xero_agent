#!/usr/bin/env node
// Bills Management P1-02: exercises routeMailboxFile() against representative sample
// documents covering every branch of the approved workflow. Uses an in-memory mock for
// the xero_invoice_balances lookup (queryFn) and for the DB write (execute) — no live
// database connection, no Xero API call, no .env required. This is the "test routing
// logic against sample documents" step; the live-data dry-run against the real 31-doc
// backlog (P1-05) is a separate step that does need DB access.
import assert from "node:assert/strict";
import { routeMailboxFile, checkDuplicate } from "../src/bills/routing.js";
import { applyBillsStatus } from "../src/bills/apply-status.js";

const baseRow = {
  id: 0,
  status: "new",
  matched_orphan_id: null,
  matched_invoice_id: null,
  extracted_supplier: null,
  extracted_amount: null,
  extracted_currency: null,
  extracted_date: null,
};

function row(overrides) {
  return { ...baseRow, ...overrides };
}

// No duplicates in the warehouse for any of these test cases by default.
async function noDuplicatesQuery() {
  return [];
}

async function duplicateFoundQuery() {
  return [{ invoice_id: "XERO-DUP-1", invoice_number: "INV-DUP", reference: "REF-DUP" }];
}

const cases = [
  {
    name: "1. Not yet processed (status=new, nothing extracted) -> Incoming",
    row: row({ id: 1, status: "new" }),
    queryFn: noDuplicatesQuery,
    expect: { bills_status: "incoming", duplicate_check_result: "not_checked" },
  },
  {
    // Mirrors the real "claim" step at mcp/server.ts:1538 (`SET status='processing'
    // WHERE id=? AND status='new'`), which flips status BEFORE extraction writes any
    // field — a genuine intermediate state, not a hypothetical one.
    name: "2. Claimed but not yet extracted (status=processing, all fields still null) -> Incoming",
    row: row({ id: 2, status: "processing" }),
    queryFn: noDuplicatesQuery,
    expect: { bills_status: "incoming", duplicate_check_result: "not_checked" },
  },
  {
    name: "3a. Valid, complete, unique, verified supplier profile -> Ready for Xero",
    row: row({
      id: 3,
      status: "processing",
      extracted_supplier: "Anthropic, PBC",
      extracted_amount: 18.0,
      extracted_currency: "EUR",
      extracted_date: "2026-09-05",
    }),
    reference: "Q2IYL8NI-0010",
    queryFn: noDuplicatesQuery,
    invoiceFacts: { supplierName: "Anthropic, PBC", supplierCountryIso: "US", description: "Claude Pro subscription", explicitVatRatePct: null, reverseChargeStated: false },
    supplierProfile: { defaultAccountCode: "422", defaultTaxCode: "TAX023", confidence: 0.85 },
    expect: { bills_status: "ready_for_xero", duplicate_check_result: "unique", account_code: "422", tax_code: "TAX023" },
  },
  {
    name: "3b. Valid and complete, but NO invoiceFacts supplied at all -> Needs Review " +
      "(account/VAT not yet determined, never assumed clean)",
    row: row({
      id: 3,
      status: "processing",
      extracted_supplier: "Anthropic, PBC",
      extracted_amount: 18.0,
      extracted_currency: "EUR",
      extracted_date: "2026-09-05",
    }),
    queryFn: noDuplicatesQuery,
    // duplicate_check_result is "unique" here, not "not_checked": supplier+amount+date
    // are all present (Q9/D17 key-details check), even though no reference is supplied.
    expect: { bills_status: "needs_review", duplicate_check_result: "unique", account_code: null, tax_code: null },
    expectReasonContains: "not yet determined",
  },
  {
    name: "4. Missing amount (extraction incomplete) -> Needs Review",
    row: row({
      id: 4,
      status: "processing",
      extracted_supplier: "Tradethno Pte. Ltd.",
      extracted_currency: "EUR",
      extracted_date: "2026-09-05",
    }),
    queryFn: noDuplicatesQuery,
    expect: { bills_status: "needs_review", duplicate_check_result: "not_checked" },
    expectReasonContains: "amount",
  },
  {
    name: "5. Bad currency code (extraction invalid, not guessed) -> Needs Review",
    row: row({
      id: 5,
      status: "processing",
      extracted_supplier: "Some Supplier",
      extracted_amount: 100,
      extracted_currency: "euros",
      extracted_date: "2026-09-05",
    }),
    queryFn: noDuplicatesQuery,
    expect: { bills_status: "needs_review" },
    expectReasonContains: "currency",
  },
  {
    name: "6. Complete extraction but confirmed duplicate -> Exceptions",
    row: row({
      id: 6,
      status: "processing",
      extracted_supplier: "Anthropic, PBC",
      extracted_amount: 18.0,
      extracted_currency: "EUR",
      extracted_date: "2026-08-05",
    }),
    queryFn: duplicateFoundQuery,
    expect: { bills_status: "exceptions", duplicate_check_result: "duplicate", duplicate_check_reference: "XERO-DUP-1" },
  },
  {
    name: "7. Agent could not match/code it (status=no_match) -> Needs Review, not Exceptions",
    row: row({
      id: 7,
      status: "no_match",
      extracted_supplier: "Unclear Ltd",
      extracted_amount: 50,
      extracted_currency: "USD",
      extracted_date: "2026-09-01",
    }),
    queryFn: noDuplicatesQuery,
    expect: { bills_status: "needs_review", duplicate_check_result: "not_checked" },
  },
  {
    name: "8. Processing failure (status=error) -> Exceptions",
    row: row({ id: 8, status: "error" }),
    queryFn: noDuplicatesQuery,
    expect: { bills_status: "exceptions" },
  },
  {
    name: "9. Already has a live Xero bill (matched_invoice_id set) -> Uploaded to Xero",
    row: row({ id: 9, status: "matched", matched_invoice_id: "XERO-LIVE-9" }),
    queryFn: noDuplicatesQuery,
    expect: { bills_status: "uploaded_to_xero", duplicate_check_reference: "XERO-LIVE-9" },
  },
  {
    name: "14. Non-EU individual contractor, no VAT shown, no profile -> Ready for Xero via rule-register match (480/TAX023)",
    row: row({
      id: 14,
      status: "processing",
      extracted_supplier: "Kayne Joelle Pecha",
      extracted_amount: 70.0,
      extracted_currency: "USD",
      extracted_date: "2026-08-24",
    }),
    reference: "INV-717897",
    queryFn: noDuplicatesQuery,
    invoiceFacts: { supplierName: "Kayne Joelle Pecha", supplierCountryIso: "PH", description: "Bookkeeping & accounting support", explicitVatRatePct: null, reverseChargeStated: false, entityType: "individual" },
    expect: { bills_status: "ready_for_xero", account_code: "480", tax_code: "TAX023" },
  },
  {
    name: "15. Domestic NL invoice, explicit 21% VAT shown -> Ready for Xero (453/TAX057)",
    row: row({
      id: 15,
      status: "processing",
      extracted_supplier: "Easystart Office Amsterdam B.V.",
      extracted_amount: 95.59,
      extracted_currency: "EUR",
      extracted_date: "2026-08-22",
    }),
    reference: "ESA 7908",
    queryFn: noDuplicatesQuery,
    invoiceFacts: { supplierName: "Easystart Office Amsterdam B.V.", supplierCountryIso: "NL", description: "Registratieadres KvK", explicitVatRatePct: 21, reverseChargeStated: false },
    expect: { bills_status: "ready_for_xero", account_code: "453", tax_code: "TAX057" },
  },
  {
    name: "16. EU cross-border, invoice explicitly states reverse charge -> Ready for Xero (425/TAX021)",
    row: row({
      id: 16,
      status: "processing",
      extracted_supplier: "DirectLing Trade UG",
      extracted_amount: 440.0,
      extracted_currency: "EUR",
      extracted_date: "2026-08-28",
    }),
    reference: "RE-1009",
    queryFn: noDuplicatesQuery,
    invoiceFacts: { supplierName: "DirectLing Trade UG", supplierCountryIso: "DE", description: "Shipping costs", explicitVatRatePct: null, reverseChargeStated: true },
    expect: { bills_status: "ready_for_xero", account_code: "425", tax_code: "TAX021" },
  },
  {
    name: "17. Non-EU platform, explicit VAT shown, no rule-register match -> Needs Review, never 850/Tax Exempt",
    row: row({
      id: 17,
      status: "processing",
      extracted_supplier: "OnlineJobs.ph",
      extracted_amount: 83.49,
      extracted_currency: "USD",
      extracted_date: "2026-07-15",
    }),
    reference: "873668",
    queryFn: noDuplicatesQuery,
    invoiceFacts: { supplierName: "OnlineJobs.ph", supplierCountryIso: "US", description: "Monthly recruiting platform fee", explicitVatRatePct: 21, reverseChargeStated: false },
    expect: { bills_status: "needs_review" },
    expectReasonContains: "VAT/tax treatment",
    expectAccountNotNull: true, // 480 should still resolve (contractor/platform match) — only VAT is undetermined
  },
  {
    name: "18. Domestic NL invoice, explicit 9% reduced rate (no confirmed Xero code for it) -> Needs Review, not guessed as TAX057",
    row: row({
      id: 18,
      status: "processing",
      extracted_supplier: "Easystart Office Amsterdam B.V.",
      extracted_amount: 50.0,
      extracted_currency: "EUR",
      extracted_date: "2026-08-01",
    }),
    reference: "ESA-9PCT-TEST",
    queryFn: noDuplicatesQuery,
    invoiceFacts: { supplierName: "Easystart Office Amsterdam B.V.", supplierCountryIso: "NL", description: "Registratieadres KvK", explicitVatRatePct: 9, reverseChargeStated: false },
    expect: { bills_status: "needs_review", tax_code: null },
    expectReasonContains: "VAT/tax treatment",
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  try {
    const result = await routeMailboxFile(c.row, {
      tenantId: "TEST-TENANT",
      reference: c.reference ?? (c.row.id === 6 ? "REF-DUP" : null),
      invoiceNumber: null,
      queryFn: c.queryFn,
      invoiceFacts: c.invoiceFacts,
      supplierProfile: c.supplierProfile,
    });
    for (const [key, expected] of Object.entries(c.expect)) {
      assert.equal(result[key], expected, `${key}: expected ${expected}, got ${result[key]}`);
    }
    if (c.expectReasonContains) {
      assert.ok(
        result.bills_status_reason?.includes(c.expectReasonContains),
        `reason should mention "${c.expectReasonContains}", got: ${result.bills_status_reason}`
      );
    }
    if (c.expectAccountNotNull) {
      assert.ok(result.account_code != null, `expected account_code to still resolve, got null`);
    }
    console.log(`PASS  ${c.name}`);
    console.log(`      -> ${JSON.stringify(result)}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${c.name}`);
    console.log(`      ${err.message}`);
    fail++;
  }
}

// Confirm apply-status.ts's dry-run default never calls execute() (no live write unless apply=true).
let executeCalled = false;
const mockDeps = { execute: async () => { executeCalled = true; } };
const dryRunResult = await applyBillsStatus(
  3,
  { bills_status: "ready_for_xero", bills_status_reason: null, duplicate_check_result: "unique", duplicate_check_reference: null, account_code: "480", tax_code: "TAX023" },
  mockDeps,
  false // apply=false, the default used everywhere in Phase 1
);
try {
  assert.equal(executeCalled, false, "dry run (apply=false) must never call execute()");
  assert.equal(dryRunResult.applied, false);
  console.log("PASS  10. applyBillsStatus(apply=false) performs no write");
  pass++;
} catch (err) {
  console.log(`FAIL  10. applyBillsStatus(apply=false) performs no write\n      ${err.message}`);
  fail++;
}

// P1-03 hardening: checkDuplicate must never report "unique" when there isn't enough
// real information to verify it — whitespace-only values and a blank tenant ID are not
// real values, even though they are not strictly null/empty.
const p103Cases = [
  {
    name: "11. Whitespace-only reference/invoice_number -> not_checked, not unique",
    args: [row({ id: 11 }), { tenantId: "TEST-TENANT", reference: "   ", invoiceNumber: "  " }, noDuplicatesQuery],
    expect: "not_checked",
  },
  {
    name: "12. Real reference but blank tenantId -> not_checked, not unique",
    args: [row({ id: 12 }), { tenantId: "  ", reference: "Q2IYL8NI-0010", invoiceNumber: null }, noDuplicatesQuery],
    expect: "not_checked",
  },
  {
    name: "13. Real reference and real tenantId, nothing found -> unique (positive control)",
    args: [row({ id: 13 }), { tenantId: "TEST-TENANT", reference: "Q2IYL8NI-0010", invoiceNumber: null }, noDuplicatesQuery],
    expect: "unique",
  },
];

for (const c of p103Cases) {
  try {
    const { result } = await checkDuplicate(...c.args);
    assert.equal(result, c.expect, `expected ${c.expect}, got ${result}`);
    console.log(`PASS  ${c.name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${c.name}\n      ${err.message}`);
    fail++;
  }
}

// Q9/D17: key-details (supplier + amount + invoice date, all three) matching against
// the warehouse table, for cases with no reference on file at all — this is exactly
// what #23 (Easystart Office Amsterdam B.V.) needed and the old reference-only check
// missed. A different date must never trigger a duplicate on its own, even with a
// matching supplier + amount (a recurring subscription charged the same amount every
// month), per Kayne's explicit instruction: continue normal validation instead.
async function keyDetailsMatchQuery() {
  return [{ invoice_id: "XERO-KEYMATCH-1", invoice_number: null, reference: "" }];
}

const q9Cases = [
  {
    name: "19. Same supplier + amount + date as an existing Xero bill, no reference on file (mirrors #23) -> duplicate",
    args: [
      row({ id: 19, extracted_supplier: "Easystart Office Amsterdam B.V.", extracted_amount: 95.59, extracted_currency: "EUR", extracted_date: "2026-06-22" }),
      { tenantId: "TEST-TENANT", reference: null, invoiceNumber: null },
      keyDetailsMatchQuery,
    ],
    expect: "duplicate",
  },
  {
    name: "20. Same supplier + amount as an existing bill but a DIFFERENT date (mirrors FrontApp #9/#24) -> unique, not flagged",
    args: [
      row({ id: 20, extracted_supplier: "FrontApp, Inc.", extracted_amount: 58.0, extracted_currency: "USD", extracted_date: "2026-08-07" }),
      { tenantId: "TEST-TENANT", reference: null, invoiceNumber: null },
      noDuplicatesQuery, // a real date-filtered query would exclude the July row, same as this mock
    ],
    expect: "unique",
  },
  {
    name: "21. Supplier + amount present but date missing -> not_checked (all three of supplier/amount/date required)",
    args: [
      row({ id: 21, extracted_supplier: "Some Supplier", extracted_amount: 100, extracted_currency: "USD", extracted_date: null }),
      { tenantId: "TEST-TENANT", reference: null, invoiceNumber: null },
      keyDetailsMatchQuery, // even if this were queried, no date means the check must not run at all
    ],
    expect: "not_checked",
  },
];

for (const c of q9Cases) {
  try {
    const { result } = await checkDuplicate(...c.args);
    assert.equal(result, c.expect, `expected ${c.expect}, got ${result}`);
    console.log(`PASS  ${c.name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${c.name}\n      ${err.message}`);
    fail++;
  }
}

// End-to-end confirmation that a different date does not just avoid a false "duplicate"
// but genuinely "continues normal validation" — routes all the way to Ready for Xero
// when everything else checks out, exactly as Kayne asked.
try {
  const result = await routeMailboxFile(
    row({ id: 22, status: "processing", extracted_supplier: "FrontApp, Inc.", extracted_amount: 58.0, extracted_currency: "USD", extracted_date: "2026-08-07" }),
    {
      tenantId: "TEST-TENANT",
      reference: null,
      invoiceNumber: null,
      queryFn: noDuplicatesQuery,
      invoiceFacts: { supplierName: "FrontApp, Inc.", supplierCountryIso: "US", description: "Front Starter Plan subscription", explicitVatRatePct: null, reverseChargeStated: false },
    }
  );
  assert.equal(result.duplicate_check_result, "unique");
  assert.equal(result.bills_status, "ready_for_xero", `date mismatch alone must not block Ready for Xero, got ${result.bills_status}: ${result.bills_status_reason}`);
  console.log("PASS  22. Different-date, same-supplier-and-amount case reaches Ready for Xero end-to-end (not diverted to Needs Review)");
  pass++;
} catch (err) {
  console.log(`FAIL  22. Different-date end-to-end case\n      ${err.message}`);
  fail++;
}

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail > 0 ? 1 : 0);
