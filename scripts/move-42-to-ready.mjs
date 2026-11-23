#!/usr/bin/env node
// Bills Management: move #42 (Kuura Solutions LLC, "Ecommerce Management", USD 200.00) from
// Needs Review to Ready for Xero, per Kayne's coding call (2026-09-17): "general business
// account" -> 429 General Business Expenses (verified against the live Xero chart of
// accounts, exact name match). Kayne's tax rule: check the real invoice for a stated reverse
// charge -> TAX021 if present, otherwise No VAT -> TAX023. Verified against the actual PDF
// (downloaded read-only over IMAP, uid 37): Kuura Solutions LLC, Sheridan, WY, United States
// (non-EU) -> Intactix BV; Sep 1, 2026; "Ecommerce Management" USD 200.00; no VAT/tax line and
// no reverse-charge statement anywhere on the invoice -> TAX023, matching the existing non-EU
// no-VAT-shown precedent (IAR-005/IAR-006, same pattern as #7/#21/#48).
//
// Uses applyBillsStatus() (not a raw UPDATE like the earlier one-off correction scripts this
// week) so bills_status_changed_at is set correctly this time -- see D24, which found 56 of
// 65 real documents missing that column because past one-off scripts skipped it.
import "dotenv/config";
import { execute, closePool } from "../src/db/mysql.js";
import { applyBillsStatus } from "../src/bills/apply-status.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { syncReviewLog } from "../src/bills/review-log.js";
import { writeFile } from "node:fs/promises";

const ID = 42;
const FILENAME = "Invoice KS00019.pdf";
const NEEDS_REVIEW = "⚠️ 02 - Needs Review";
const READY = "✅ 03 - Ready for Xero";

const reason =
  "Kuura Solutions LLC (Sheridan, WY, US — non-EU), 'Ecommerce Management', USD 200.00, " +
  "2026-09-01. Coded 429 General Business Expenses per Kayne's call. Real invoice verified: " +
  "no VAT/tax line, no reverse-charge statement -> No VAT (TAX023), per Kayne's rule and the " +
  "non-EU no-VAT-shown precedent (IAR-005/006, same pattern as #7/#21/#48).";

console.log("=== Moving #42 (Kuura Solutions): Needs Review -> Ready for Xero ===\n");

const backup = {
  id: ID,
  filename: FILENAME,
  previous_bills_status: "needs_review",
  previous_folder: NEEDS_REVIEW,
  new_bills_status: "ready_for_xero",
  new_folder: READY,
  account_code: "429",
  tax_code: "TAX023",
  reason,
  by: "Kayne",
  timestamp: new Date().toISOString(),
};
await writeFile(
  `/opt/projects/gopure/bills_management/backups/doc42_correction_${new Date()
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
    tax_code: "TAX023",
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
