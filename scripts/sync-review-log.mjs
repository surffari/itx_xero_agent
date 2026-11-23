#!/usr/bin/env node
// Standalone CLI entry point for the shared syncReviewLog() logic (src/bills/review-log.ts).
// Also called automatically at the end of scripts/route-to-nextcloud.mjs — run this
// directly only for an out-of-band sync (e.g. after a manual Nextcloud folder move).
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { syncReviewLog } from "../src/bills/review-log.js";

console.log("=== Syncing Documents Review Log.xlsx with live Nextcloud/DB state ===\n");

const nc = new NextcloudWebDavClient();
const result = await syncReviewLog(nc, query);

console.log(`Backed up previous workbook -> ${result.backupPath}`);
if (result.updatedIds.length > 0) {
  console.log(`Updated rows: ${result.updatedIds.map((id) => `#${id}`).join(", ")}`);
}
console.log(`\n${result.changed} row(s) updated, ${result.unchanged} unchanged.`);
console.log(result.changed > 0 ? "Re-uploaded updated workbook to Nextcloud." : "Nothing changed — workbook left as-is on Nextcloud.");

await closePool();
