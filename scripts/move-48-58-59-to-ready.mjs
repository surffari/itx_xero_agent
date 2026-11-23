#!/usr/bin/env node
// Bills Management: single-row corrections for #48 (Tradethno), #58 and #59 (DirectLing),
// per Kayne's decisions 2026-09-15. Same pattern as #23 (D16) / #57: backed up before
// running, DB reason persisted per row, Nextcloud files moved, verified live via PROPFIND.
// No Xero bill created — still gated behind P1-05 sign-off.
import "dotenv/config";
import { execute, closePool } from "../src/db/mysql.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { writeFile } from "node:fs/promises";

const NEEDS_REVIEW = "⚠️ 02 - Needs Review";
const READY_FOR_XERO = "✅ 03 - Ready for Xero";

const corrections = [
  {
    id: 48,
    filename: "Invoice INV-0184.pdf",
    account_code: "310",
    tax_code: "TAX023",
    reason:
      "Tradethno Pte. Ltd. (Singapore), 'Ecommerce Platform Development', EUR 3,000, invoice " +
      "states 'Out Of Scope Services' (no GST/VAT charged). Account confirmed by Kayne as 310 " +
      "Cost of Goods Sold. Confluence 'Tax Rate Selection and Coding Notes' (newer page, " +
      "2026-08-11) resolves Tradethno to Cost of Goods Sold / No Vat (0%) -> TAX023 per " +
      "account-coding.ts's non-EU-no-VAT pattern (IAR-005/IAR-006), superseding the older " +
      "'Accounts and Tax Rates per Supplier' page which still shows Review/Review.",
  },
  {
    id: 58,
    filename: "KRD RE-1008.pdf",
    account_code: "310",
    tax_code: "TAX021",
    reason:
      "DirectLing Trade UG (DE), 'Balance Invoice RE-1008' for contract filling and labeling " +
      "services (per-pouch packing/labeling production work, order KRD-062601), EUR 1,355.34. " +
      "Not a shipping cost (different from #39/RE-1009's 425 Freight & Courier coding) - this " +
      "is per-unit production/packing work, coded 310 Cost of Goods Sold per Kayne's decision, " +
      "same logic as #48. Invoice explicitly states 'Reverse Charge 0%' / Steuerschuldnerschaft " +
      "des Leistungsempfangers -> TAX021 (EU reverse charge), same treatment as #39.",
  },
  {
    id: 59,
    filename: "KRD RE-1010.pdf",
    account_code: "425",
    tax_code: "TAX021",
    reason:
      "DirectLing Trade UG (DE), 'RE-1010' - reimbursement of FedEx customs & import charges " +
      "for the same shipment as #39/RE-1009 (order KRD-062601), EUR 40.90. Coded 425 Freight & " +
      "Courier per Kayne's decision, same account as #39 (RE-1009's 'Shipping Costs' invoice) " +
      "- the account-coding.ts keyword list (shipping/freight/courier/...) doesn't literally " +
      "match 'customs'/'import', which is why this fell to Needs Review despite being the same " +
      "cost bucket as #39. Invoice explicitly states Reverse Charge / Steuerschuldnerschaft des " +
      "Leistungsempfangers -> TAX021 (EU reverse charge), same treatment as #39.",
  },
];

const backupRecords = corrections.map((c) => ({
  id: c.id,
  filename: c.filename,
  previous_bills_status: "incoming",
  previous_folder: NEEDS_REVIEW,
  new_bills_status: "ready_for_xero",
  new_folder: READY_FOR_XERO,
  account_code: c.account_code,
  tax_code: c.tax_code,
  reason: c.reason,
  by: "Kayne",
  timestamp: new Date().toISOString(),
}));
await writeFile(
  `/opt/projects/gopure/bills_management/backups/doc48_58_59_correction_${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`,
  JSON.stringify(backupRecords, null, 2),
  "utf8"
);
console.log("Backed up correction records for #48, #58, #59.");

const nc = new NextcloudWebDavClient();
for (const c of corrections) {
  await execute(`UPDATE mailbox_invoice_files SET bills_status='ready_for_xero', bills_status_reason=? WHERE id=?`, [
    c.reason,
    c.id,
  ]);
  console.log(`Persisted DB correction: #${c.id} bills_status -> ready_for_xero`);

  await nc.moveFile(`${NEEDS_REVIEW}/${c.id}_${c.filename}`, `${READY_FOR_XERO}/${c.id}_${c.filename}`);
  console.log(`Moved #${c.id} in Nextcloud.`);
}

const nrAfter = await nc.listFolder(NEEDS_REVIEW);
const rfxAfter = await nc.listFolder(READY_FOR_XERO);
for (const c of corrections) {
  console.log(`#${c.id}: still in Needs Review?`, nrAfter.some((f) => f.startsWith(`${c.id}_`)));
  console.log(`#${c.id}: now in Ready for Xero?`, rfxAfter.some((f) => f.startsWith(`${c.id}_`)));
}
console.log("Needs Review count:", nrAfter.length, "| Ready for Xero count:", rfxAfter.length);

await closePool();
