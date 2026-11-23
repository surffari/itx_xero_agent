import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveContactForBill, type XeroContactRef } from "./contact-resolution-guard.js";

// Real production xero_contacts rows (pulled live 2026-10-01) -- not synthetic. This is the
// exact set of known near-duplicate pairs/groups this project has hit and manually resolved,
// by hand, every single time, all project: Paulo Tomas/Thomas, Kuura Solutions LLC/
// Kuurasolutions.com, DigitalOcean LLC/Digitalocean Eu B.v., Atlassian/Atlassian Pty Ltd,
// Anthropic/Anthropic, PBC, and a 4-way Tradethno split -- all ACTIVE simultaneously.
const CONTACTS: XeroContactRef[] = [
  { contact_id: "08cb1a8b-kuura-llc", name: "Kuura Solutions LLC", status: "ACTIVE" },
  { contact_id: "f3f04f1d-kuura-com", name: "Kuurasolutions.com", status: "ACTIVE" },
  { contact_id: "1f6dc78f-atlassian-pty", name: "Atlassian Pty Ltd", status: "ACTIVE" },
  { contact_id: "ec30ee7b-atlassian", name: "Atlassian", status: "ACTIVE" },
  { contact_id: "33010b43-paulo-thomas", name: "Paulo Thomas", status: "ACTIVE" },
  { contact_id: "3d295abd-paulo-tomas", name: "Paulo Tomas", status: "ACTIVE" },
  { contact_id: "3668d970-anthropic", name: "Anthropic", status: "ACTIVE" },
  { contact_id: "87a05df7-anthropic-pbc", name: "Anthropic, PBC", status: "ACTIVE" },
  { contact_id: "763abfbd-tradethno-bare", name: "Tradethno", status: "ACTIVE" },
  { contact_id: "b333bebc-tradethno-pte-ltd-dot", name: "Tradethno pte. ltd.", status: "ACTIVE" },
  { contact_id: "e337bf56-tradethno-pte-ltd-nodot", name: "Tradethno pte. ltd", status: "ACTIVE" },
  { contact_id: "ec883d4e-tradethno-pte-ltd-nopunct", name: "Tradethno pte ltd", status: "ACTIVE" },
  { contact_id: "ddea14db-digitalocean-eu", name: "Digitalocean Eu B.v.", status: "ACTIVE" },
  { contact_id: "ef8897e0-digitalocean-llc", name: "DigitalOcean LLC", status: "ACTIVE" },
  // An unambiguous, genuinely single supplier for the clean-resolution cases.
  { contact_id: "aaa-brevo", name: "Brevo", status: "ACTIVE" },
  { contact_id: "bbb-easystart", name: "Easystart Office Amsterdam B.V.", status: "ACTIVE" },
  // An archived near-namesake that must never block or get picked.
  { contact_id: "ccc-old-front", name: "Front", status: "ARCHIVED" },
];

// --- Explicit override always wins ---

test("explicit contact_id override is trusted outright, no lookup performed", () => {
  const result = resolveContactForBill("Literally Anything", "some-explicit-contact-id", CONTACTS);
  assert.equal(result.ok, true);
  assert.equal(result.contactId, "some-explicit-contact-id");
});

// --- Clean, unambiguous resolution ---

test("a single exact match with no near-duplicates resolves automatically", () => {
  const result = resolveContactForBill("Brevo", undefined, CONTACTS);
  assert.equal(result.ok, true);
  assert.equal(result.contactId, "aaa-brevo");
});

test("exact match is case-insensitive", () => {
  const result = resolveContactForBill("brevo", undefined, CONTACTS);
  assert.equal(result.ok, true);
  assert.equal(result.contactId, "aaa-brevo");
});

test("a genuinely new supplier with no exact or near match is allowed through as new (no contactId)", () => {
  const result = resolveContactForBill("Totally New Vendor Co", undefined, CONTACTS);
  assert.equal(result.ok, true);
  assert.equal(result.contactId, undefined);
});

test("an archived namesake never blocks or gets picked for a new supplier", () => {
  // "Front" exists but only ARCHIVED -- must resolve as new, not pick the archived contact
  // and not refuse as ambiguous either.
  const result = resolveContactForBill("Front", undefined, CONTACTS);
  assert.equal(result.ok, true);
  assert.equal(result.contactId, undefined);
});

// --- Ambiguous: exact match exists, but so does a near-duplicate (the real Tradethno risk) ---

test("exact match alongside other near-duplicate contacts is refused, not silently picked", () => {
  // "Tradethno" matches bare "Tradethno" exactly, but 3 near-identical "pte ltd" variants
  // also exist -- must not silently assume the bare one is correct.
  const result = resolveContactForBill("Tradethno", undefined, CONTACTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /exact name match exists, but other similarly-named/i);
  assert.match(result.reason!, /Tradethno pte\. ltd\./);
});

test("a near-duplicate legal-suffix variant is refused even when it normalizes identically to an existing contact", () => {
  const result = resolveContactForBill("Tradethno Pte. Ltd.", undefined, CONTACTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /ambiguous/i);
});

// --- Ambiguous: no exact match, but a near-duplicate exists (typo / rebrand / spelling variant) ---

test("a near-miss spelling variant with no exact match is refused, not treated as new", () => {
  // "Paulo Thomas" and "Paulo Tomas" both exist; typing a third near-spelling must not be
  // silently treated as a brand-new supplier.
  const result = resolveContactForBill("Paulo Tomass", undefined, CONTACTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /No exact match, but one or more similarly-named/i);
  assert.match(result.reason!, /Paulo (Tomas|Thomas)/);
});

test("DigitalOcean LLC vs Digitalocean Eu B.v. are recognised as the same supplier and refused as ambiguous", () => {
  const result = resolveContactForBill("Digitalocean", undefined, CONTACTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /DigitalOcean LLC/);
  assert.match(result.reason!, /Digitalocean Eu B\.v\./);
});

test("Kuura Solutions LLC vs Kuurasolutions.com are recognised as the same supplier and refused as ambiguous", () => {
  const result = resolveContactForBill("Kuura Solutions", undefined, CONTACTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /Kuurasolutions\.com/);
});

test("Anthropic vs Anthropic, PBC are recognised as the same supplier and refused as ambiguous", () => {
  const result = resolveContactForBill("Anthropic PBC", undefined, CONTACTS);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /Anthropic/);
});

// --- Multiple exact matches (same name used by more than one active contact) ---

test("short, unrelated abbreviations are NOT flagged as near-duplicates (regression: KVK vs KPN B.V. false positive)", () => {
  const shortNames: XeroContactRef[] = [
    { contact_id: "kvk1", name: "KVK", status: "ACTIVE" },
    { contact_id: "kpn1", name: "KPN B.V.", status: "ACTIVE" },
  ];
  const result = resolveContactForBill("KVK", undefined, shortNames);
  assert.equal(result.ok, true);
  assert.equal(result.contactId, "kvk1");
});

test("multiple exact-name matches are refused as ambiguous", () => {
  const dupeName: XeroContactRef[] = [
    { contact_id: "x1", name: "Generic Supplier", status: "ACTIVE" },
    { contact_id: "x2", name: "Generic Supplier", status: "ACTIVE" },
  ];
  const result = resolveContactForBill("Generic Supplier", undefined, dupeName);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /Multiple contacts share this exact name/);
});
