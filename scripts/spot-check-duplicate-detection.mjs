#!/usr/bin/env node
// Bills Management P1-03: spot-checks duplicate-check behaviour against REAL data.
// Read-only throughout — every query is a SELECT, nothing is written to
// mailbox_invoice_files, xero_invoice_balances, or Xero itself.
//
// Requires DB credentials (intactix_accounting_agent/.env) — run as whoever owns that
// file (surffari), same as the migration in P1-01.
//
// What this checks, and why:
//   1. True positive:  a reference that DOES exist in xero_invoice_balances must come
//      back "duplicate" — proves the lookup actually finds real matches, not just that
//      it never fires.
//   2. True negative:  an obviously fabricated reference must come back "unique" —
//      proves it doesn't false-positive.
//   3. The real backlog: every current mailbox_invoice_files row, run through
//      checkDuplicate with NO reference supplied (today's real situation — see Q3 in
//      PLAN.md, extracted_reference/extracted_invoice_number are not persisted yet).
//      The explicit requirement from Kayne for this spot-check: NONE of these may come
//      back "unique" when there wasn't enough information to verify it. They must all
//      honestly report "not_checked". This script asserts that and fails loudly if it
//      ever sees otherwise.
import "dotenv/config";
import assert from "node:assert/strict";
import { query, closePool } from "../src/db/mysql.js";
import { config } from "../src/config.js";
import { checkDuplicate } from "../src/bills/routing.js";

const tenantId = config.XERO_TENANT_ID;
if (!tenantId) {
  console.error("XERO_TENANT_ID is not set in .env — cannot run a meaningful duplicate check. Aborting.");
  process.exit(1);
}

async function queryFn(sql, args) {
  return query(sql, args);
}

let failures = 0;

console.log(`=== Bills Management P1-03 duplicate-check spot-check (tenant ${tenantId}) ===\n`);

// --- 1. True positive: pick one real, non-deleted ACCPAY bill and confirm its own
// reference/invoice_number correctly comes back "duplicate". ---
const realBills = await query(
  `SELECT invoice_id, invoice_number, reference
   FROM xero_invoice_balances
   WHERE tenant_id=? AND invoice_type='ACCPAY' AND status NOT IN ('DELETED','VOIDED')
     AND (COALESCE(reference,'') <> '' OR COALESCE(invoice_number,'') <> '')
   LIMIT 1`,
  [tenantId]
);

if (realBills.length === 0) {
  console.log("SKIP  True-positive check: no non-deleted ACCPAY bill with a reference/invoice_number exists to test against.");
} else {
  const bill = realBills[0];
  const probe = bill.reference || bill.invoice_number;
  const field = bill.reference ? "reference" : "invoiceNumber";
  const { result, reference } = await checkDuplicate(
    { id: -1, status: "processing", matched_orphan_id: null, matched_invoice_id: null,
      extracted_supplier: null, extracted_amount: null, extracted_currency: null, extracted_date: null },
    { tenantId, reference: field === "reference" ? probe : null, invoiceNumber: field === "invoiceNumber" ? probe : null },
    queryFn
  );
  try {
    assert.equal(result, "duplicate", `expected "duplicate" for known real ${field}="${probe}", got "${result}"`);
    assert.equal(reference, bill.invoice_id, `expected matched invoice_id ${bill.invoice_id}, got ${reference}`);
    console.log(`PASS  True positive: real ${field}="${probe}" correctly found as duplicate of ${bill.invoice_id}`);
  } catch (err) {
    console.log(`FAIL  True positive check: ${err.message}`);
    failures++;
  }
}

// --- 2. True negative: an obviously fabricated reference must never match. ---
const fakeReference = `BILLS-MGMT-SPOTCHECK-${Date.now()}`;
{
  const { result } = await checkDuplicate(
    { id: -1, status: "processing", matched_orphan_id: null, matched_invoice_id: null,
      extracted_supplier: null, extracted_amount: null, extracted_currency: null, extracted_date: null },
    { tenantId, reference: fakeReference, invoiceNumber: null },
    queryFn
  );
  try {
    assert.equal(result, "unique", `expected "unique" for a fabricated reference, got "${result}"`);
    console.log(`PASS  True negative: fabricated reference "${fakeReference}" correctly came back unique`);
  } catch (err) {
    console.log(`FAIL  True negative check: ${err.message}`);
    failures++;
  }
}

// --- 3. The real backlog, as it actually is today: no reference/invoice_number is
// persisted on mailbox_invoice_files (Q3). Rows WITHOUT complete supplier+amount+date
// must honestly report "not_checked" — never a false "unique". Rows WITH all three
// (Q9/D17: key-details matching, added 2026-09-14) are now genuinely checkable even
// without a reference, and may legitimately come back "unique" or "duplicate" — that
// is the fix working as intended, not a regression of this guarantee. ---
console.log("\n=== Real mailbox_invoice_files rows (no reference/invoice_number persisted — see Q3) ===");
const rows = await query(
  `SELECT id, attachment_filename, status, matched_invoice_id,
          extracted_supplier, extracted_amount, extracted_currency, extracted_date
   FROM mailbox_invoice_files
   ORDER BY id DESC`
);

let checkedCount = 0;
let wronglyUnique = 0;
let keyDetailsChecked = 0;
for (const r of rows) {
  const hasKeyDetails =
    !!r.extracted_supplier?.trim() && r.extracted_amount != null && r.extracted_amount > 0 && !!r.extracted_date;
  const { result } = await checkDuplicate(
    {
      id: r.id, status: r.status, matched_orphan_id: null, matched_invoice_id: r.matched_invoice_id,
      extracted_supplier: r.extracted_supplier, extracted_amount: r.extracted_amount,
      extracted_currency: r.extracted_currency, extracted_date: r.extracted_date,
    },
    { tenantId, reference: null, invoiceNumber: null }, // honest: this is all we actually have today
    queryFn
  );
  checkedCount++;
  if (hasKeyDetails) keyDetailsChecked++;
  // Only a row WITHOUT complete supplier+amount+date has no real basis for "unique" —
  // that's the case this guard protects. A row WITH all three legitimately ran the
  // Q9/D17 key-details check and may honestly come back "unique".
  if (result === "unique" && !hasKeyDetails) wronglyUnique++;
  console.log(`  #${r.id} (${r.attachment_filename}) status=${r.status} matched_invoice_id=${r.matched_invoice_id ?? "-"} -> duplicate_check_result=${result}${hasKeyDetails ? " (key-details check ran)" : ""}`);
}

try {
  assert.equal(wronglyUnique, 0, `${wronglyUnique} of ${checkedCount} real rows with INCOMPLETE data were marked "unique" — this must never happen`);
  console.log(`\nPASS  All ${checkedCount} real backlog rows honestly report a verifiable result (${keyDetailsChecked} had complete supplier+amount+date and ran the Q9/D17 key-details check; the rest correctly report "not_checked")`);
} catch (err) {
  console.log(`\nFAIL  ${err.message}`);
  failures++;
}

console.log(`\n${failures === 0 ? "ALL SPOT-CHECKS PASSED" : `${failures} SPOT-CHECK(S) FAILED`}`);
await closePool();
process.exit(failures > 0 ? 1 : 0);
