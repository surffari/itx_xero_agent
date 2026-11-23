#!/usr/bin/env node
// Bills Management: applies Kayne's new standing rule (2026-10-01) -- CURO "Invoice C..."
// processing-fee documents ("request for payment") are Exceptions, not a payable to code
// and draft. Closes Q12 (the open CURO-405 account-coding question) by resolving it as
// "don't draft these at all" rather than finding the right account code.
import "dotenv/config";
import { query, execute, closePool } from "../src/db/mysql.js";
import { applyBillsStatus } from "../src/bills/apply-status.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { syncReviewLog } from "../src/bills/review-log.js";
import { writeFile, mkdir } from "node:fs/promises";

const nc = new NextcloudWebDavClient();
const NEEDS_REVIEW = "⚠️ 02 - Needs Review";
const EXCEPTIONS = "🚨 05 - Exceptions";

const docs = [
  { id: 45, filename: "Invoice C268.19578.210518060.pdf" },
  { id: 63, filename: "Invoice C269.19578.210519620.pdf" },
  { id: 70, filename: "Invoice C269.19578.210520866.pdf" },
  { id: 84, filename: "Invoice C269.19578.210521970.pdf" },
];

console.log("=== Routing 4 CURO 'request for payment' docs to Exceptions ===\n");

const backup = [];
for (const d of docs) {
  const rows = await query(`SELECT * FROM mailbox_invoice_files WHERE id=?`, [d.id]);
  backup.push(rows[0]);
}
await mkdir("/opt/projects/gopure/bills_management/backups", { recursive: true });
const backupPath = `/opt/projects/gopure/bills_management/backups/curo_request_for_payment_to_exceptions_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(backupPath, JSON.stringify(backup, null, 2));
console.log(`Backed up -> ${backupPath}\n`);

const reason = "Standing rule (2026-10-01): CURO 'request for payment' documents (Invoice C...) are Exceptions, not a payable to code/draft -- Kayne: 'the request for payment will be under exceptions'. Closes Q12 (CURO-405 account-coding question) by resolving it as don't-draft rather than finding the right code.";

for (const d of docs) {
  const result = {
    bills_status: "exceptions",
    bills_status_reason: reason,
    duplicate_check_result: "not_checked",
    duplicate_check_reference: null,
    account_code: null,
    tax_code: null,
  };
  await applyBillsStatus(d.id, result, { execute }, true);
  await nc.moveFile(`${NEEDS_REVIEW}/${d.id}_${d.filename}`, `${EXCEPTIONS}/${d.id}_${d.filename}`);
  console.log(`#${d.id}: Needs Review -> Exceptions`);
}

console.log("\n=== Syncing Documents Review Log.xlsx ===");
const syncResult = await syncReviewLog(nc, query, {});
console.log(`${syncResult.changed} updated, ${syncResult.added} added, ${syncResult.unchanged} unchanged.`);

await closePool();
