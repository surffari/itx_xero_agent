#!/usr/bin/env node
// Bills Management: single-row correction for #57 (Darlene Aberin), per Kayne's decision
// 2026-09-15 — use the billing-period end date (2026-08-28) as the invoice date, and code
// as 480/TAX023 per the Fiverr/Upwork/Paulo Tomas/Suhenny Henny contractor precedent in
// Confluence "Accounts and Tax Rates per Supplier". Same single-row pattern as #23 (D16):
// backed up before running, DB reason persisted, Nextcloud file moved, verified live via
// PROPFIND. No Xero bill created — still gated behind P1-05 sign-off.
import "dotenv/config";
import { execute, closePool } from "../src/db/mysql.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { writeFile } from "node:fs/promises";

const reason =
  "Invoice has no single invoice-date field, only a billing period (10.8.-28.8.2026); " +
  "Kayne confirmed use of the period-end date, 2026-08-28, as the invoice date. " +
  "Contractor pattern (digital marketing, non-EU individual, no VAT) matches " +
  "Fiverr/Upwork/Paulo Tomas/Suhenny Henny precedent in Confluence " +
  "'Accounts and Tax Rates per Supplier' -> 480 Contractor & Freelance Services / TAX023 No VAT.";

const backup = {
  id: 57,
  filename: "Intactix_Invoice_1_Darlene_Aberin_10.8-28.8.2026.pdf",
  previous_bills_status: "incoming",
  previous_folder: "⚠️ 02 - Needs Review",
  new_bills_status: "ready_for_xero",
  new_folder: "✅ 03 - Ready for Xero",
  account_code: "480",
  tax_code: "TAX023",
  invoice_date_used: "2026-08-28",
  reason,
  by: "Kayne",
  timestamp: new Date().toISOString(),
};
await writeFile(
  `/opt/projects/gopure/bills_management/backups/doc57_correction_${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  JSON.stringify(backup, null, 2),
  "utf8"
);
console.log("Backed up correction record.");

await execute(
  `UPDATE mailbox_invoice_files SET bills_status='ready_for_xero', bills_status_reason=? WHERE id=57`,
  [reason]
);
console.log("Persisted DB correction: #57 bills_status -> ready_for_xero");

const nc = new NextcloudWebDavClient();
await nc.moveFile(
  "⚠️ 02 - Needs Review/57_Intactix_Invoice_1_Darlene_Aberin_10.8-28.8.2026.pdf",
  "✅ 03 - Ready for Xero/57_Intactix_Invoice_1_Darlene_Aberin_10.8-28.8.2026.pdf"
);
console.log("Moved file in Nextcloud.");

const nrAfter = await nc.listFolder("⚠️ 02 - Needs Review");
const rfxAfter = await nc.listFolder("✅ 03 - Ready for Xero");
console.log("Needs Review still has 57's file:", nrAfter.some((f) => f.startsWith("57_")));
console.log("Ready for Xero now has 57's file:", rfxAfter.some((f) => f.startsWith("57_")));
console.log("Needs Review count:", nrAfter.length, "| Ready for Xero count:", rfxAfter.length);

await closePool();
