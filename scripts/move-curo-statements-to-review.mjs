#!/usr/bin/env node
// Bills Management: move the 12 CURO Payments B.V. Statement/Settlement documents from
// Exceptions to Needs Review, per Kayne's request (2026-09-15) — she wants to clarify
// with Jani what these actually represent (what was purchased/paid) before filing them
// permanently as non-actionable receivables paperwork. Same single/multi-row correction
// pattern as #23/#57/#48/#58/#59: backed up before running, DB reason persisted, files
// moved in Nextcloud, verified live. No Xero bill touched — these were never bills.
import "dotenv/config";
import { execute, closePool } from "../src/db/mysql.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { writeFile } from "node:fs/promises";

const EXCEPTIONS = "🚨 05 - Exceptions";
const NEEDS_REVIEW = "⚠️ 02 - Needs Review";

const docs = [
  { id: 3, filename: "Statement S268.19578.210514534.pdf" },
  { id: 5, filename: "Settlement R268.19578.210514534.pdf" },
  { id: 14, filename: "Statement S267.19578.210512652.pdf" },
  { id: 16, filename: "Settlement R267.19578.210512652.pdf" },
  { id: 18, filename: "Statement S267.19578.210511032.pdf" },
  { id: 20, filename: "Settlement R267.19578.210511032.pdf" },
  { id: 27, filename: "Statement S268.19578.210515556.pdf" },
  { id: 29, filename: "Settlement R268.19578.210515556.pdf" },
  { id: 44, filename: "Statement S268.19578.210518060.pdf" },
  { id: 46, filename: "Settlement R268.19578.210518060.pdf" },
  { id: 62, filename: "Statement S269.19578.210519620.pdf" },
  { id: 64, filename: "Settlement R269.19578.210519620.pdf" },
];

const reason =
  "CURO Payments B.V. Statement/Settlement document. Originally classified as Exceptions " +
  "(not a vendor bill — appears to be receivables/payment-processor paperwork, money owed " +
  "TO Intactix rather than a purchase). Kayne wants to clarify with Jani what this actually " +
  "represents — what was purchased or paid — before filing it as non-actionable. Held in " +
  "Needs Review pending that conversation (2026-09-15).";

console.log(`=== Moving ${docs.length} CURO Payments Statement/Settlement docs: Exceptions -> Needs Review ===\n`);

const backup = docs.map((d) => ({
  ...d,
  previous_bills_status: "exceptions",
  previous_folder: EXCEPTIONS,
  new_bills_status: "needs_review",
  new_folder: NEEDS_REVIEW,
  reason,
  by: "Kayne",
  timestamp: new Date().toISOString(),
}));
await writeFile(
  `/opt/projects/gopure/bills_management/backups/curo_statements_to_review_${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`,
  JSON.stringify(backup, null, 2),
  "utf8"
);
console.log("Backed up correction records.");

const nc = new NextcloudWebDavClient();
for (const doc of docs) {
  await execute(`UPDATE mailbox_invoice_files SET bills_status='needs_review', bills_status_reason=? WHERE id=?`, [
    reason,
    doc.id,
  ]);
  await nc.moveFile(`${EXCEPTIONS}/${doc.id}_${doc.filename}`, `${NEEDS_REVIEW}/${doc.id}_${doc.filename}`);
  console.log(`Moved #${doc.id}: Exceptions -> Needs Review`);
}

const exAfter = await nc.listFolder(EXCEPTIONS);
const nrAfter = await nc.listFolder(NEEDS_REVIEW);
console.log(`\nExceptions count: ${exAfter.length} | Needs Review count: ${nrAfter.length}`);

await closePool();
