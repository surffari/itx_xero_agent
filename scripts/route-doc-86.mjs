#!/usr/bin/env node
import "dotenv/config";
import { query, closePool, execute } from "../src/db/mysql.js";
import { applyBillsStatus } from "../src/bills/apply-status.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { syncReviewLog } from "../src/bills/review-log.js";
import { readFile } from "node:fs/promises";

const nc = new NextcloudWebDavClient();
const reason = "Tax and Law Spain (Erica Eced) P2026098, EUR75.00, 21-09-2026, German Q3 2026 tax rep fee. Billed to Mari Oksala personally, not Intactix B.V. directly (Q6 pattern). No existing Xero bill, no account-code precedent -- and the PDF body itself contains embedded instructions to the reader (link + urgent data request), flagged separately for Kayne, not actioned.";
console.log(`reason length: ${reason.length}`);

const result = {
  bills_status: "needs_review",
  bills_status_reason: reason,
  duplicate_check_result: "not_checked",
  duplicate_check_reference: null,
  account_code: null,
  tax_code: null,
};
await applyBillsStatus(86, result, { execute }, true);

const buf = await readFile("/opt/projects/openclaw/gopure/intactix/scratch-incoming-review/86_P2026098.pdf");
await nc.uploadFile("⚠️ 02 - Needs Review/86_P2026098.pdf", buf, "application/pdf");
console.log("#86 -> Needs Review");

const syncResult = await syncReviewLog(nc, query, { 86: { invoice: "P2026098", supplier: "Tax and Law Spain (Erica Eced)" } });
console.log(`${syncResult.changed} updated, ${syncResult.added} added, ${syncResult.unchanged} unchanged.`);

await closePool();
