#!/usr/bin/env node
// Verifies the createBill() idempotency-retry guard added to XeroWriteClient.
// Exercises the REAL DB logic (xero_write_log INSERT/UPDATE) so the guard itself is
// genuinely tested, but overrides assertEnabled/getAccessToken/post so NO network call
// ever reaches Xero — this is a JS subclass, so TypeScript's `private` on those methods
// is a compile-time-only label; at runtime they're plain overridable properties.
// All test rows use a clearly-marked idempotency key prefix and are deleted afterward.
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query, execute, closePool } from "../src/db/mysql.js";
import { XeroWriteClient } from "../src/xero/write-client.js";

let postCallCount = 0;

class FakeWriteClient extends XeroWriteClient {
  assertEnabled() { /* no-op: allow the test to reach this point regardless of XERO_WRITE_ENABLED */ }
  async getAccessToken() { return "fake-token-for-test"; }
  async post(_token, _tenantId, _url, payload, idempotencyKey) {
    postCallCount++;
    // Simulate what Xero would return on a successful create. Short ID — xero_object_id
    // is VARCHAR(64) and a real Xero InvoiceID is a UUID (36 chars), not the full key.
    return { Invoices: [{ ...payload, InvoiceID: `FAKE-${randomUUID().slice(0, 18)}` }] };
  }
}

const tenantId = "test-tenant";
const testKeyPrefix = `test-retry-guard:${randomUUID()}`;
const client = new FakeWriteClient();
let pass = 0, fail = 0;

function check(name, fn) {
  return fn().then(
    () => { console.log(`PASS  ${name}`); pass++; },
    (err) => { console.log(`FAIL  ${name}\n      ${err.message}`); fail++; }
  );
}

async function seedRow(key, status) {
  await execute(
    `INSERT INTO xero_write_log (tenant_id, operation, idempotency_key, dry_run, status, request_payload, ps_reference)
     VALUES (?, 'CREATE_BILL', ?, 0, ?, '{}', 'test')`,
    [tenantId, key, status]
  );
}

async function cleanup() {
  await execute(`DELETE FROM xero_write_log WHERE idempotency_key LIKE ?`, [`${testKeyPrefix}%`]);
}

// --- 1. New key -> allowed ---
await check("1. New idempotency key -> allowed, reaches Xero, ends success", async () => {
  const key = `${testKeyPrefix}:new`;
  postCallCount = 0;
  const created = await client.createBill(tenantId, { Contact: { Name: "Test" } }, key, "ref-new", false);
  assert.ok(created.InvoiceID, "expected an InvoiceID back");
  assert.equal(postCallCount, 1, "expected exactly one Xero call");
  const rows = await query(`SELECT status, xero_object_id FROM xero_write_log WHERE idempotency_key=? AND dry_run=0`, [key]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "success");
});

// --- 2. Existing 'error' -> reusable ---
await check("2. Existing status='error' -> reused (same row), retry reaches Xero, ends success", async () => {
  const key = `${testKeyPrefix}:error-retry`;
  await seedRow(key, "error");
  const before = await query(`SELECT id FROM xero_write_log WHERE idempotency_key=? AND dry_run=0`, [key]);
  postCallCount = 0;
  const created = await client.createBill(tenantId, { Contact: { Name: "Test" } }, key, "ref-error", false);
  assert.ok(created.InvoiceID);
  assert.equal(postCallCount, 1);
  const after = await query(`SELECT id, status, flag_reason FROM xero_write_log WHERE idempotency_key=? AND dry_run=0`, [key]);
  assert.equal(after.length, 1, "must still be exactly one row — reused, not duplicated");
  assert.equal(after[0].id, before[0].id, "must be the SAME row id, not a new insert");
  assert.equal(after[0].status, "success");
  assert.ok(after[0].flag_reason?.includes("Retried"), "flag_reason should record the retry");
});

// --- 3. Existing 'success' -> refused ---
await check("3. Existing status='success' -> refused, no Xero call", async () => {
  const key = `${testKeyPrefix}:success-refuse`;
  await seedRow(key, "success");
  postCallCount = 0;
  await assert.rejects(
    () => client.createBill(tenantId, { Contact: { Name: "Test" } }, key, "ref-success", false),
    /has status='success', not 'error'/
  );
  assert.equal(postCallCount, 0, "must never reach Xero when existing status is success");
});

// --- 4. Existing 'pending' -> refused ---
await check("4. Existing status='pending' -> refused, no Xero call", async () => {
  const key = `${testKeyPrefix}:pending-refuse`;
  await seedRow(key, "pending");
  postCallCount = 0;
  await assert.rejects(
    () => client.createBill(tenantId, { Contact: { Name: "Test" } }, key, "ref-pending", false),
    /has status='pending', not 'error'/
  );
  assert.equal(postCallCount, 0, "must never reach Xero when existing status is pending");
});

// --- 5. Concurrent retry on the same 'error' row -> only one proceeds ---
await check("5. Concurrent retry on the same error row -> exactly one succeeds, one refused", async () => {
  const key = `${testKeyPrefix}:concurrent`;
  await seedRow(key, "error");
  postCallCount = 0;
  const results = await Promise.allSettled([
    client.createBill(tenantId, { Contact: { Name: "A" } }, key, "ref-concurrent", false),
    client.createBill(tenantId, { Contact: { Name: "B" } }, key, "ref-concurrent", false),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, `expected exactly 1 to succeed, got ${fulfilled.length}`);
  assert.equal(rejected.length, 1, `expected exactly 1 to be refused, got ${rejected.length}`);
  assert.equal(postCallCount, 1, "Xero must only ever be called once, no matter how many retries race");
  const rows = await query(`SELECT id, status FROM xero_write_log WHERE idempotency_key=? AND dry_run=0`, [key]);
  assert.equal(rows.length, 1, "must still be exactly one row");
  assert.equal(rows[0].status, "success");
});

// --- 6. Dry-run behavior unchanged ---
await check("6. Dry-run: repeated calls with the same key behave as before (INSERT IGNORE, ends dry_run, no Xero call)", async () => {
  const key = `${testKeyPrefix}:dryrun`;
  postCallCount = 0;
  const first = await client.createBill(tenantId, { Contact: { Name: "Test" } }, key, "ref-dryrun", true);
  const second = await client.createBill(tenantId, { Contact: { Name: "Test" } }, key, "ref-dryrun", true);
  assert.equal(postCallCount, 0, "dry run must never call Xero");
  assert.equal(first.Type, "ACCPAY");
  assert.equal(second.Type, "ACCPAY");
  const rows = await query(`SELECT status FROM xero_write_log WHERE idempotency_key=? AND dry_run=1`, [key]);
  assert.equal(rows.length, 1, "dry_run=1 row should exist exactly once (INSERT IGNORE)");
  assert.equal(rows[0].status, "dry_run");
});

await cleanup();
await closePool();

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail > 0 ? 1 : 0);
