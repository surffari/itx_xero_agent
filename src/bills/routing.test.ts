import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDuplicate, type MailboxFileRow, type DuplicateMatch } from "./routing.js";

const TENANT = "tenant-abc";

interface FixtureBill extends DuplicateMatch {
  invoice_id: string;
  tenant_id: string;
}

const FIXTURE_BILLS: FixtureBill[] = [
  {
    tenant_id: TENANT,
    invoice_id: "bill-ref-match",
    invoice_number: "INV-1001",
    reference: "REF-ABC-123",
    contact_name: "Some Supplier Ltd",
    status: "AUTHORISED",
    total: 250.0,
    currency_code: "EUR",
    invoice_date: "2026-08-01",
  },
  {
    tenant_id: TENANT,
    invoice_id: "bill-curo-processing-fee",
    invoice_number: "C268.19578.210514534",
    reference: null,
    contact_name: "CURO Payments B.V.",
    status: "AUTHORISED",
    total: 1.09,
    currency_code: "EUR",
    invoice_date: "2026-08-09",
  },
  {
    tenant_id: TENANT,
    invoice_id: "bill-kayne-aug10",
    invoice_number: "INV-707545",
    reference: null,
    contact_name: "Kayne Joelle Pecha",
    status: "PAID",
    total: 70.0,
    currency_code: "USD",
    invoice_date: "2026-08-10",
  },
];

/**
 * Faithfully mirrors the WHERE clause in checkDuplicate's SQL (routing.ts) against an
 * in-memory fixture, so these tests exercise the real matching semantics checkDuplicate
 * asks the database to apply — not just its own wrapper logic — without needing a live DB.
 * Argument order/positions match the real query exactly (see routing.ts checkDuplicate).
 */
function fakeQueryFn(bills: FixtureBill[]) {
  return async (_sql: string, args: unknown[]): Promise<DuplicateMatch[]> => {
    const [
      tenantId, reference1, _reference2, invoiceNumber1, _invoiceNumber2,
      matchedInvoiceId1, _matchedInvoiceId2, hasKeyDetails, supplierName, invoiceDate, amount,
    ] = args as [string, string | null, string | null, string | null, string | null, string | null, string | null, boolean, string | null, string | null, number | null];

    return bills
      .filter((b) => b.tenant_id === tenantId)
      .filter((b) =>
        (reference1 != null && b.reference === reference1) ||
        (invoiceNumber1 != null && b.invoice_number === invoiceNumber1) ||
        (matchedInvoiceId1 != null && b.invoice_id === matchedInvoiceId1) ||
        (hasKeyDetails &&
          (b.contact_name ?? "").toLowerCase() === String(supplierName).toLowerCase() &&
          b.invoice_date === invoiceDate &&
          round2(b.total ?? 0) === round2(amount ?? -1))
      )
      .slice(0, 5);
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function row(overrides: Partial<MailboxFileRow>): MailboxFileRow {
  return {
    id: 1,
    status: "processing",
    matched_orphan_id: null,
    matched_invoice_id: null,
    extracted_supplier: null,
    extracted_amount: null,
    extracted_currency: null,
    extracted_date: null,
    ...overrides,
  };
}

// --- 1. Exact reference duplicate ---

test("exact reference match is a duplicate, with full matching bill info returned", async () => {
  const result = await checkDuplicate(
    row({ extracted_supplier: "Some Supplier Ltd", extracted_amount: 250.0, extracted_date: "2026-08-01" }),
    { tenantId: TENANT, reference: "REF-ABC-123", invoiceNumber: null },
    fakeQueryFn(FIXTURE_BILLS)
  );
  assert.equal(result.result, "duplicate");
  assert.equal(result.reference, "bill-ref-match");
  assert.ok(result.match);
  assert.equal(result.match!.invoice_id, "bill-ref-match");
  assert.equal(result.match!.contact_name, "Some Supplier Ltd");
  assert.equal(result.match!.status, "AUTHORISED");
});

// --- 2. Contact + date + amount duplicate (reference present but doesn't match anything) ---

test("contact + date + amount duplicate is caught even when a non-matching reference was supplied", async () => {
  const result = await checkDuplicate(
    row({ extracted_supplier: "CURO Payments B.V.", extracted_amount: 1.09, extracted_date: "2026-08-09" }),
    { tenantId: TENANT, reference: "WRONG-REF-999", invoiceNumber: null },
    fakeQueryFn(FIXTURE_BILLS)
  );
  assert.equal(result.result, "duplicate");
  assert.equal(result.match!.invoice_id, "bill-curo-processing-fee");
});

// --- 3. Same supplier + amount, different date -> legitimate non-duplicate ---

test("same supplier and amount but a different invoice date is NOT a duplicate", async () => {
  const result = await checkDuplicate(
    row({ extracted_supplier: "CURO Payments B.V.", extracted_amount: 1.09, extracted_date: "2026-09-09" }),
    { tenantId: TENANT, reference: null, invoiceNumber: null },
    fakeQueryFn(FIXTURE_BILLS)
  );
  assert.equal(result.result, "unique");
  assert.equal(result.match, null);
});

// --- 4. Same supplier + date, different amount -> legitimate non-duplicate ---

test("same supplier and date but a different amount is NOT a duplicate", async () => {
  const result = await checkDuplicate(
    row({ extracted_supplier: "CURO Payments B.V.", extracted_amount: 999.99, extracted_date: "2026-08-09" }),
    { tenantId: TENANT, reference: null, invoiceNumber: null },
    fakeQueryFn(FIXTURE_BILLS)
  );
  assert.equal(result.result, "unique");
  assert.equal(result.match, null);
});

// --- Never duplicate on supplier + amount alone, regardless of date ---

test("same supplier and amount alone, with no date given at all, is never classified duplicate", async () => {
  // extracted_date omitted entirely -> hasKeyDetails is false -> the contact+date+amount
  // branch can never fire, and there is no reference/invoiceNumber either.
  const result = await checkDuplicate(
    row({ extracted_supplier: "Kayne Joelle Pecha", extracted_amount: 70.0 }),
    { tenantId: TENANT, reference: null, invoiceNumber: null },
    fakeQueryFn(FIXTURE_BILLS)
  );
  assert.equal(result.result, "not_checked");
  assert.equal(result.match, null);
});

// --- 5. No matching bill -> allowed to continue ---

test("no matching bill at all -> unique, allowed to continue", async () => {
  const result = await checkDuplicate(
    row({ extracted_supplier: "Brand New Supplier Inc", extracted_amount: 42.0, extracted_date: "2026-10-01" }),
    { tenantId: TENANT, reference: "REF-NEW-999", invoiceNumber: "INV-NEW-999" },
    fakeQueryFn(FIXTURE_BILLS)
  );
  assert.equal(result.result, "unique");
  assert.equal(result.match, null);
});

// --- 6. Missing reference entirely, with a matching contact/date/amount -> blocked ---

test("reference entirely missing (not just non-matching) still catches a contact+date+amount duplicate", async () => {
  const result = await checkDuplicate(
    row({ extracted_supplier: "Kayne Joelle Pecha", extracted_amount: 70.0, extracted_date: "2026-08-10" }),
    { tenantId: TENANT, reference: null, invoiceNumber: null },
    fakeQueryFn(FIXTURE_BILLS)
  );
  assert.equal(result.result, "duplicate");
  assert.equal(result.match!.invoice_id, "bill-kayne-aug10");
  assert.equal(result.match!.currency_code, "USD");
});
