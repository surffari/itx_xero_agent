#!/usr/bin/env node
// Bills Management: routes the 12 documents stuck at bills_status='incoming' (11 of them
// since 2026-08-28, 1 genuinely new #86 from 2026-09-28). Real PDFs read via IMAP
// (downloadAttachment, read-only), every supplier cross-checked against live Xero
// (xero_invoice_balances, freshly synced) before any routing decision.
//
// Finding: 11 of the 12 (#4,#8,#11,#13,#15,#19,#22,#25,#28,#36,#37) already have an
// EXACT invoice_number+amount+contact match to a live Xero ACCPAY bill (AUTHORISED or
// PAID) -- these were billed through some other route (not this mailbox pipeline) and
// the mailbox_invoice_files row was simply never told the bill already existed. This is
// NOT a duplicate-creation case (nothing new gets written to Xero) -- it's a tracking
// correction, same shape as the "already has a live Xero bill" branch in routing.ts.
// None of the 12 ever made it to the Nextcloud Incoming folder either (confirmed empty),
// so this uploads each PDF directly to its corrected target folder rather than moving it.
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { applyBillsStatus } from "../src/bills/apply-status.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { syncReviewLog } from "../src/bills/review-log.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const nc = new NextcloudWebDavClient();
const FOLDER = {
  needs_review: "⚠️ 02 - Needs Review",
  uploaded_to_xero: "📤 04 - Uploaded to Xero",
};
const SCRATCH = "/opt/projects/openclaw/gopure/intactix/scratch-incoming-review";

const docs = [
  { id: 4, filename: "Invoice C268.19578.210514534.pdf", saved: "4_Invoice_C268.19578.210514534.pdf",
    bills_status: "uploaded_to_xero", xero_id: "c77bbdc0-b566-4a55-84f7-ff89007cc82d",
    reason: "CURO Payments B.V. transaction-cost invoice C268.19578.210514534, EUR1.09, 09-08-2026 -- already exists as a live Xero AUTHORISED bill (exact invoice number/amount/contact match), created through some other route. Tracking status corrected to reflect reality; no new bill created." },
  { id: 8, filename: "Inv707545 Kayne.pdf", saved: "8_Inv707545_Kayne.pdf",
    bills_status: "uploaded_to_xero", xero_id: "6d54e387-aa46-418f-84e6-5de66fb24610",
    reason: "Kayne Joelle Pecha INV-707545, USD70.00, Aug 10 2026 -- already exists as a live Xero PAID bill (exact match). Tracking status corrected; no new bill created." },
  { id: 11, filename: "Invoice-Q2IYL8NI-0009.pdf", saved: "11_Invoice-Q2IYL8NI-0009.pdf",
    bills_status: "uploaded_to_xero", xero_id: "d6008293-41eb-4783-913e-825b63ed25fa",
    reason: "Anthropic Q2IYL8NI-0009, EUR18.00, Aug 5 2026 (Claude Pro) -- already exists as a live Xero PAID bill (exact match). Tracking status corrected; no new bill created." },
  { id: 13, filename: "Nicole - Invoice (1).pdf", saved: "13_Nicole_-_Invoice__1_.pdf",
    bills_status: "uploaded_to_xero", xero_id: "4f062e0a-1dc7-4fd9-9afa-25c29b9bf313",
    reason: "Keith Nicole V. Sarsaba INV-KNS-2026-002, USD56.00, Aug 3 2026 -- already exists as a live Xero AUTHORISED bill (exact match). Tracking status corrected; no new bill created." },
  { id: 15, filename: "Invoice C267.19578.210512652.pdf", saved: "15_Invoice_C267.19578.210512652.pdf",
    bills_status: "uploaded_to_xero", xero_id: "b278a3f6-dc0f-4396-9eee-846f61e468be",
    reason: "CURO Payments B.V. C267.19578.210512652, EUR10.77, 31-07-2026 -- already exists as a live Xero AUTHORISED bill (exact match). Tracking status corrected; no new bill created." },
  { id: 19, filename: "Invoice C267.19578.210511032.pdf", saved: "19_Invoice_C267.19578.210511032.pdf",
    bills_status: "uploaded_to_xero", xero_id: "a518186d-c6cc-4a60-ac30-ad3488c16b88",
    reason: "CURO Payments B.V. C267.19578.210511032, EUR25.56, 26-07-2026 -- already exists as a live Xero AUTHORISED bill (exact match). Tracking status corrected; no new bill created." },
  { id: 22, filename: "ESA 7695.pdf", saved: "22_ESA_7695.pdf",
    bills_status: "uploaded_to_xero", xero_id: "6cbf0a5e-542c-4bf3-8556-f07fb1d86787",
    reason: "Easystart Office Amsterdam B.V. ESA 7695, EUR95.59, 22-07-2026 (Registratieadres KvK, Jul21-Aug20 period) -- already exists as a live Xero AUTHORISED bill (exact match). Tracking status corrected; no new bill created." },
  { id: 25, filename: "KAYNE JOELLE PECHA– INVOICE 703935 - Invoice Template.pdf", saved: "25_KAYNE_JOELLE_PECHA__INVOICE_703935_-_Invoice_Template.pdf",
    bills_status: "uploaded_to_xero", xero_id: "481ebe32-2875-4cea-9b7b-0afcfa9a2dfa",
    reason: "Kayne Joelle Pecha INV-703935, USD70.00, Aug 17 2026 -- already exists as a live Xero AUTHORISED bill (exact match). Tracking status corrected; no new bill created." },
  { id: 28, filename: "Invoice C268.19578.210515556.pdf", saved: "28_Invoice_C268.19578.210515556.pdf",
    bills_status: "uploaded_to_xero", xero_id: "3dfdc8cc-fdf3-4bfb-b323-4e0bfa007bab",
    reason: "CURO Payments B.V. C268.19578.210515556, EUR1.09, 16-08-2026 -- already exists as a live Xero AUTHORISED bill (exact match). Tracking status corrected; no new bill created." },
  { id: 36, filename: "GP Invoice 24-08-2026.pdf", saved: "36_GP_Invoice_24-08-2026.pdf",
    bills_status: "uploaded_to_xero", xero_id: "60182b02-9107-4f1d-9053-2dece5624e82",
    reason: "Paulo Tomas, ref 24-08-2026, USD260.00, week Aug17-23 2026 -- already exists as a live Xero AUTHORISED bill (exact match). Tracking status corrected; no new bill created." },
  { id: 37, filename: "Nicole - Invoice 5 (1).pdf", saved: "37_Nicole_-_Invoice_5__1_.pdf",
    bills_status: "uploaded_to_xero", xero_id: "b4ff53ba-8848-4a92-a46b-fa9fbd47e04a",
    reason: "Keith Nicole V. Sarsaba INV-KNS-2026-005, USD58.00, Aug 24 2026 -- already exists as a live Xero AUTHORISED bill (exact match). Tracking status corrected; no new bill created." },
  { id: 86, filename: "P2026098.pdf", saved: "86_P2026098.pdf",
    bills_status: "needs_review", xero_id: null,
    reason: "Tax and Law Spain (Erica Eced) P2026098, EUR75.00, 21-09-2026 -- German Q3 2026 tax representation fee, billed to Mari-Annina Oksala personally rather than Intactix B.V. directly (same pattern as #56/#78, Q6). No existing Xero bill found (genuinely new) and no prior CURO/Tax-and-Law-Spain account-code precedent to code it confidently against. ALSO FLAGGED FOR KAYNE: the PDF body contains embedded instructions directed at whoever opens it (a YouTube link, an urgent 48h request to download and attach bank transaction/VAT-refund data) -- read but not acted on; needs a human look before any reply or download, not routine review." },
];

console.log(`=== Routing 12 stuck Incoming documents ===\n`);

const backup = [];
for (const d of docs) {
  const rows = await query(`SELECT * FROM mailbox_invoice_files WHERE id=?`, [d.id]);
  backup.push(rows[0]);
}
await mkdir("/opt/projects/gopure/bills_management/backups", { recursive: true });
const backupPath = `/opt/projects/gopure/bills_management/backups/route_12_incoming_docs_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(backupPath, JSON.stringify(backup, null, 2));
console.log(`Backed up -> ${backupPath}\n`);

for (const d of docs) {
  const result = {
    bills_status: d.bills_status,
    bills_status_reason: d.reason,
    duplicate_check_result: "not_checked",
    duplicate_check_reference: d.xero_id,
    account_code: null,
    tax_code: null,
  };
  await applyBillsStatus(d.id, result, { execute: (await import("../src/db/mysql.js")).execute }, true);

  const buf = await readFile(`${SCRATCH}/${d.saved}`);
  const target = FOLDER[d.bills_status];
  const ncPath = `${target}/${d.id}_${d.filename}`;
  await nc.uploadFile(ncPath, buf, "application/pdf");
  console.log(`#${d.id}: -> ${target}`);
}

console.log("\n=== Syncing Documents Review Log.xlsx ===");
const supplierNames = { 4: "CURO Payments B.V.", 8: "Kayne Joelle Pecha", 11: "Anthropic, PBC",
  13: "Keith Nicole V. Sarsaba", 15: "CURO Payments B.V.", 19: "CURO Payments B.V.",
  22: "Easystart Office Amsterdam B.V.", 25: "Kayne Joelle Pecha", 28: "CURO Payments B.V.",
  36: "Paulo Tomas", 37: "Keith Nicole V. Sarsaba", 86: "Tax and Law Spain (Erica Eced)" };
const invoiceNumbers = { 4: "C268.19578.210514534", 8: "INV-707545", 11: "Q2IYL8NI-0009",
  13: "INV-KNS-2026-002", 15: "C267.19578.210512652", 19: "C267.19578.210511032",
  22: "ESA 7695", 25: "INV-703935", 28: "C268.19578.210515556", 36: "24-08-2026",
  37: "INV-KNS-2026-005", 86: "P2026098" };
const newRowInfo = Object.fromEntries(docs.map((d) => [d.id, { invoice: invoiceNumbers[d.id], supplier: supplierNames[d.id] }]));
const syncResult = await syncReviewLog(nc, query, newRowInfo);
console.log(`${syncResult.changed} updated, ${syncResult.added} added, ${syncResult.unchanged} unchanged.`);

await closePool();
