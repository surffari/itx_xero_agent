import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAccountCodeForBill, type XeroAccountRef } from "./account-code-guard.js";

const ACCOUNTS: XeroAccountRef[] = [
  { code: "480", name: "Contractor & Freelance Services", type: "EXPENSE", status: "ACTIVE" },
  { code: "453", name: "Office & Compliance Costs", type: "EXPENSE", status: "ACTIVE" },
  { code: "850", name: "Suspense", type: "CURRLIAB", status: "ACTIVE" },
  { code: "429", name: "General Business Expenses", type: "EXPENSE", status: "ACTIVE" },
  { code: "720", name: "Computer Equipment", type: "FIXED", status: "ACTIVE" },
  { code: "100", name: "Wise EUR", type: "BANK", status: "ACTIVE" },
  { code: "200", name: "Export Sales", type: "REVENUE", status: "ACTIVE" },
  { code: "202", name: "Portugal Sales", type: "REVENUE", status: "ARCHIVED" },
  { code: "999", name: "Old Contractor Costs", type: "EXPENSE", status: "ARCHIVED" },
];

// --- Missing ---

test("missing: undefined account_code is refused, never defaults", () => {
  const result = checkAccountCodeForBill(undefined, undefined, ACCOUNTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /required/i);
  assert.match(result.reason!, /never defaults to 850/i); // explicit that no silent default happens
});

test("missing: null account_code is refused", () => {
  const result = checkAccountCodeForBill(null, null, ACCOUNTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /required/i);
});

test("missing: blank/whitespace-only account_code is refused", () => {
  const result = checkAccountCodeForBill("   ", undefined, ACCOUNTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /required/i);
});

// --- Invalid ---

test("invalid: account_code not in the synced chart of accounts is refused", () => {
  const result = checkAccountCodeForBill("999999", undefined, ACCOUNTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /not found/i);
});

test("invalid: ARCHIVED account_code is refused even though it exists", () => {
  const result = checkAccountCodeForBill("999", undefined, ACCOUNTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /ARCHIVED/);
});

test("invalid: ARCHIVED revenue account is refused for the archived reason, not silently treated as a type error", () => {
  const result = checkAccountCodeForBill("202", undefined, ACCOUNTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /ARCHIVED/);
});

test("invalid: BANK account_code is refused — never a valid bill coding target", () => {
  const result = checkAccountCodeForBill("100", undefined, ACCOUNTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /BANK/);
});

test("invalid: REVENUE account_code is refused — a purchase can never land on a sales account", () => {
  const result = checkAccountCodeForBill("200", undefined, ACCOUNTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /REVENUE/);
});

// --- Unresolved (850 without justification behaves like unresolved) ---

test("unresolved: 850 with no account_code_reason is refused, not silently accepted", () => {
  const result = checkAccountCodeForBill("850", undefined, ACCOUNTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /IAR-009/);
});

test("unresolved: 850 with a blank account_code_reason is refused", () => {
  const result = checkAccountCodeForBill("850", "   ", ACCOUNTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /IAR-009/);
});

// --- Valid ---

test("valid: an ordinary ACTIVE expense account is accepted", () => {
  const result = checkAccountCodeForBill("480", undefined, ACCOUNTS);
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
});

test("valid: a different ACTIVE expense account is accepted", () => {
  const result = checkAccountCodeForBill("453", undefined, ACCOUNTS);
  assert.equal(result.ok, true);
});

test("valid: ACTIVE FIXED asset account is accepted (bills aren't only expenses)", () => {
  const result = checkAccountCodeForBill("720", undefined, ACCOUNTS);
  assert.equal(result.ok, true);
});

test("valid: 850 IS accepted when explicitly and legitimately justified", () => {
  const result = checkAccountCodeForBill(
    "850",
    "Card check pending bank confirmation, per IAR-009 — will clear within days.",
    ACCOUNTS
  );
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
});

test("valid: account_code with surrounding whitespace is trimmed and matched", () => {
  const result = checkAccountCodeForBill("  480  ", undefined, ACCOUNTS);
  assert.equal(result.ok, true);
});
