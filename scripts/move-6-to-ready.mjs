#!/usr/bin/env node
// Bills Management: move #6 (OnlineJobs.ph, "Monthly recruiting platform fee", USD 83.49) from
// Needs Review to Ready for Xero, per Kayne's explicit coding call (2026-09-17): account 429
// General Business Expenses (same call as #42), tax TAX057 (21% Standard VAT).
//
// This is a deliberate human override of a genuine SOP gap, not a new automated rule: the real
// invoice shows OnlineJobs.ph (US, non-EU) explicitly charging 21% tax directly on the face of
// the invoice, not reverse-charging -- a pattern account-coding.ts's determineTaxCode()
// correctly declines to resolve automatically (TAX057/NL-Standard-VAT is only ever applied to a
// domestic NL supplier; TAX021 requires an explicit reverse-charge statement, which this invoice
// does not make). No existing rule-register/SOP precedent covers a non-EU vendor charging
// VAT-like tax directly -- flagged as an open question since 2026-09-10 (D13) and again in the
// 2026-09-15 review. Kayne resolved it herself: treat the 21% as reclaimable standard-rate
// input VAT (TAX057) rather than leaving it unresolved.
//
// Uses applyBillsStatus() so bills_status_changed_at is set correctly (see D24).
import "dotenv/config";
import { execute, closePool } from "../src/db/mysql.js";
import { applyBillsStatus } from "../src/bills/apply-status.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { syncReviewLog } from "../src/bills/review-log.js";
import { writeFile } from "node:fs/promises";

const ID = 6;
const FILENAME = "07-15-2026_invoice.pdf";
const NEEDS_REVIEW = "⚠️ 02 - Needs Review";
const READY = "✅ 03 - Ready for Xero";

const reason =
  "OnlineJobs.ph (US, non-EU), monthly recruiting platform fee, USD 83.49. Coded 429 " +
  "General Business Expenses per Kayne's call, same as #42. Tax: invoice explicitly charges " +
  "21% directly (not reverse charge) -- no existing SOP precedent covers a non-EU vendor " +
  "doing this (open since D13/2026-09-10). Kayne's explicit decision (2026-09-17): treat as " +
  "reclaimable standard-rate input VAT -> TAX057, a deliberate human override, not an " +
  "automated rule-register match.";

console.log("=== Moving #6 (OnlineJobs.ph): Needs Review -> Ready for Xero ===\n");

const backup = {
  id: ID,
  filename: FILENAME,
  previous_bills_status: "needs_review",
  previous_folder: NEEDS_REVIEW,
  new_bills_status: "ready_for_xero",
  new_folder: READY,
  account_code: "429",
  tax_code: "TAX057",
  reason,
  by: "Kayne",
  timestamp: new Date().toISOString(),
};
await writeFile(
  `/opt/projects/gopure/bills_management/backups/doc6_correction_${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`,
  JSON.stringify(backup, null, 2),
  "utf8"
);
console.log("Backed up correction record.");

await applyBillsStatus(
  ID,
  {
    bills_status: "ready_for_xero",
    bills_status_reason: reason,
    duplicate_check_result: "not_checked",
    duplicate_check_reference: null,
    account_code: "429",
    tax_code: "TAX057",
  },
  { execute },
  true
);
console.log(`Persisted #${ID}: needs_review -> ready_for_xero (bills_status_changed_at set)`);

const nc = new NextcloudWebDavClient();
await nc.moveFile(`${NEEDS_REVIEW}/${ID}_${FILENAME}`, `${READY}/${ID}_${FILENAME}`);
console.log(`Moved #${ID} in Nextcloud: Needs Review -> Ready for Xero`);

const nrAfter = await nc.listFolder(NEEDS_REVIEW);
const readyAfter = await nc.listFolder(READY);
console.log(`\nNeeds Review count: ${nrAfter.length} | Ready for Xero count: ${readyAfter.length}`);

console.log("\n=== Syncing Documents Review Log.xlsx ===");
const syncResult = await syncReviewLog(nc, (sql, args) =>
  import("../src/db/mysql.js").then((m) => m.query(sql, args))
);
console.log(`Backed up previous workbook -> ${syncResult.backupPath}`);
console.log(`${syncResult.changed} row(s) updated, ${syncResult.unchanged} unchanged.`);

await closePool();
