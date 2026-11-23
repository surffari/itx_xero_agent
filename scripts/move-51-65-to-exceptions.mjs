#!/usr/bin/env node
// Bills Management: #51 and #65 (both "ESA 7908.pdf") confirmed duplicates, moved from
// Ready for Xero to Exceptions -- flagged by Kayne (2026-09-22), verified carefully before
// acting:
//   - #51 and #65 are byte-for-byte identical (SHA-256 match) -- the same email/attachment,
//     landed as two separate mailbox_invoice_files rows (uid 43 and uid 57).
//   - Traced the invoice number (Easystart Office Amsterdam B.V., ESA 7908, EUR 95.59,
//     2026-08-22) to mailbox row #32, already uploaded to Xero on 2026-09-14 as bill
//     4126a9d3-8061-467c-bdfa-d032c14de59e -- confirmed live via get_bills: status PAID,
//     fully_paid_on_date 2026-09-15, same amount/date/contact.
//   - Neither #51 nor #65 had ever been drafted in Xero (bills_status was still
//     ready_for_xero for both, matched_invoice_id null) -- no Xero write to undo, this is a
//     DB/Nextcloud-only correction, same pattern as #23/D16.
// Both never got extraction persisted, so the automated duplicate-check never ran a
// comparison at all (duplicate_check_result was 'not_checked' for both) -- same known gap as
// the #49/#50 and #54/#55 same-batch siblings (2026-09-14 changelog).
//
// Uses applyBillsStatus() so bills_status_changed_at is set correctly (see D24).
import "dotenv/config";
import { execute, closePool } from "../src/db/mysql.js";
import { applyBillsStatus } from "../src/bills/apply-status.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { syncReviewLog } from "../src/bills/review-log.js";
import { writeFile } from "node:fs/promises";

const READY = "✅ 03 - Ready for Xero";
const EXCEPTIONS = "🚨 05 - Exceptions";
const FILENAME = "ESA 7908.pdf";
const IDS = [51, 65];

const reason =
  "Confirmed duplicate: byte-for-byte identical to #65/#51 (SHA-256 match) and to #32, " +
  "already uploaded to Xero as bill 4126a9d3-... (Easystart Office Amsterdam B.V., ESA 7908, " +
  "EUR 95.59, 2026-08-22) -- now PAID (2026-09-15). Never drafted in Xero, so no live bill to " +
  "void; DB/Nextcloud correction only. Same-batch sibling duplicate never cross-checked " +
  "against #32 or each other (extraction never persisted for either) -- caught by Kayne's " +
  "review 2026-09-22.";

console.log("=== Moving #51 and #65 (ESA 7908, confirmed duplicates of #32): Ready for Xero -> Exceptions ===\n");

const backup = IDS.map((id) => ({
  id,
  filename: FILENAME,
  previous_bills_status: "ready_for_xero",
  previous_folder: READY,
  new_bills_status: "exceptions",
  new_folder: EXCEPTIONS,
  duplicate_of_mailbox_id: 32,
  duplicate_of_xero_bill_id: "4126a9d3-8061-467c-bdfa-d032c14de59e",
  reason,
  by: "Kayne",
  timestamp: new Date().toISOString(),
}));
await writeFile(
  `/opt/projects/gopure/bills_management/backups/doc51_65_correction_${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`,
  JSON.stringify(backup, null, 2),
  "utf8"
);
console.log("Backed up correction records.");

const nc = new NextcloudWebDavClient();
for (const id of IDS) {
  await applyBillsStatus(
    id,
    {
      bills_status: "exceptions",
      bills_status_reason: reason,
      duplicate_check_result: "duplicate",
      duplicate_check_reference: "4126a9d3-8061-467c-bdfa-d032c14de59e",
      account_code: null,
      tax_code: null,
    },
    { execute },
    true
  );
  await nc.moveFile(`${READY}/${id}_${FILENAME}`, `${EXCEPTIONS}/${id}_${FILENAME}`);
  console.log(`Moved #${id}: Ready for Xero -> Exceptions (bills_status_changed_at set)`);
}

const readyAfter = await nc.listFolder(READY);
const exAfter = await nc.listFolder(EXCEPTIONS);
console.log(`\nReady for Xero count: ${readyAfter.length} | Exceptions count: ${exAfter.length}`);

console.log("\n=== Syncing Documents Review Log.xlsx ===");
const syncResult = await syncReviewLog(nc, (sql, args) =>
  import("../src/db/mysql.js").then((m) => m.query(sql, args))
);
console.log(`Backed up previous workbook -> ${syncResult.backupPath}`);
console.log(`${syncResult.changed} row(s) updated, ${syncResult.unchanged} unchanged.`);

await closePool();
