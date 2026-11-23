import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCuroDocument } from "./curo-document-guard.js";

// --- D30: Settlement -> hard block ---

test("D30: CURO Settlement document is blocked, never drafted", () => {
  const result = checkCuroDocument("CURO Payments B.V.", "Settlement R269.19578.210521970.pdf");
  assert.equal(result.ok, false);
  assert.match(result.reason!, /D30/);
  assert.match(result.reason!, /hard block/i);
});

test("D30: Settlement match is case-insensitive", () => {
  const result = checkCuroDocument("CURO Payments B.V.", "SETTLEMENT r269.pdf");
  assert.equal(result.ok, false);
  assert.match(result.reason!, /D30/);
});

// --- Statement (Q10, open) -> blocked as receivables paperwork ---

test("CURO Statement document is blocked as receivables paperwork, not guessed per Q10", () => {
  const result = checkCuroDocument("CURO Payments B.V.", "Statement S269.19578.210521970.pdf");
  assert.equal(result.ok, false);
  assert.match(result.reason!, /Q10/);
  assert.match(result.reason!, /receivables/i);
});

// --- D36: request-for-payment Invoice -> Exceptions ---

test("D36: CURO processing-fee Invoice document is blocked, routed to Exceptions", () => {
  const result = checkCuroDocument("CURO Payments B.V.", "Invoice C269.19578.210521970.pdf");
  assert.equal(result.ok, false);
  assert.match(result.reason!, /D36/);
  assert.match(result.reason!, /Exceptions/);
});

test("D36: matches the other real CURO invoice filenames from this project (#45, #70)", () => {
  assert.equal(checkCuroDocument("CURO Payments B.V.", "Invoice C268.19578.210518060.pdf").ok, false);
  assert.equal(checkCuroDocument("CURO Payments B.V.", "Invoice C269.19578.210520866.pdf").ok, false);
});

// --- Unrecognised CURO document shape -> blocked defensively, not assumed safe ---

test("a CURO document matching none of the three known patterns is blocked defensively", () => {
  const result = checkCuroDocument("CURO Payments B.V.", "Receipt-12345.pdf");
  assert.equal(result.ok, false);
  assert.match(result.reason!, /none of the known CURO document patterns/);
});

test("CURO mentioned via supplier name alone (no filename) still blocks defensively", () => {
  const result = checkCuroDocument("CURO Payments B.V.", undefined);
  assert.equal(result.ok, false);
});

// --- Must not affect anything that isn't actually CURO ---

test("a non-CURO supplier is entirely unaffected, even with a similar-sounding filename", () => {
  const result = checkCuroDocument("Brevo", "Invoice 12345.pdf");
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
});

test("a supplier whose name happens to contain 'settlement' but is not CURO is NOT blocked", () => {
  const result = checkCuroDocument("Settlement Services Ltd", "Invoice 2026-001.pdf");
  assert.equal(result.ok, true);
});

test("'curo' as a non-word substring (e.g. inside another word) does not false-positive", () => {
  // "Securonix" contains the letters c-u-r-o consecutively but not as the standalone word
  // "curo" -- word-boundary matching must not treat it as a CURO mention.
  const result = checkCuroDocument("Securonix Inc.", "Invoice 2026-002.pdf");
  assert.equal(result.ok, true);
});

test("real CURO contact name variants are still recognised even without 'Payments B.V.' suffix", () => {
  const result = checkCuroDocument("CURO", "Settlement X1.pdf");
  assert.equal(result.ok, false);
});
