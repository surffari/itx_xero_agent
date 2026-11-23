#!/usr/bin/env node
// Bills Management: real-PDF review of the 5 mailbox documents that arrived since the
// 2026-09-22 15-doc pass (#81-85, from the 2026-09-24 poll_mailbox_inbox run). Same
// methodology as route-15-new-docs.mjs: every fact below was read directly from the real
// PDF, cross-checked against live Xero for duplicates via get_contacts/get_bills. Moves
// each document straight from Incoming (where route-to-nextcloud.mjs already placed it)
// to its target folder and persists bills_status via applyBillsStatus (D24 pattern).
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { applyBillsStatus } from "../src/bills/apply-status.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { syncReviewLog } from "../src/bills/review-log.js";

const nextcloud = new NextcloudWebDavClient();
const INCOMING = "📥 01 - Incoming";
const FOLDER = {
  needs_review: "⚠️ 02 - Needs Review",
  ready_for_xero: "✅ 03 - Ready for Xero",
};

const docs = [
  {
    id: 81, filename: "KAYNE JOELLE PECHA– INVOICE 464375 - Invoice Template.pdf",
    invoice: "INV-464375", supplier: "Kayne Joelle Pecha",
    bills_status: "ready_for_xero", account_code: "480", tax_code: "TAX023",
    reason: "Kayne Joelle Pecha (Philippines, non-EU individual), INV-464375, USD 70.00, 2026-09-21, billing period Sep 13-20. Same recurring related-party contractor pattern as #21/#34/#38/#66. No VAT shown -> 480/TAX023 (IAR-006). Verified not a duplicate: distinct billing period from existing bills incl. #66 (Sep 7).",
  },
  {
    id: 82, filename: "ESA 8118.pdf",
    invoice: "ESA 8118", supplier: "Easystart Office Amsterdam B.V.",
    bills_status: "ready_for_xero", account_code: "453", tax_code: "TAX057",
    reason: "ESA 8118 (Easystart Office Amsterdam B.V., NL), registered-address invoice, EUR 95.59, 2026-09-22, period 21 Sep-20 Oct 2026. Same monthly Registratieadres KvK pattern as #23/#32/precedent -> 453 Office & Compliance Costs. Domestic NL invoice, explicit 21% VAT shown -> TAX057. Verified not a duplicate: closest existing bill is ESA 7908, Aug 22, different period.",
  },
  {
    id: 83, filename: "Statement S269.19578.210521970.pdf",
    invoice: "S269.19578.210521970", supplier: "CURO Payments B.V.",
    bills_status: "needs_review", account_code: null, tax_code: null,
    reason: "CURO Payments B.V. Statement document. Not a vendor bill -- receivables/payment-processor paperwork, money owed TO Intactix (Bancontact payment received, EUR 82.50), not a purchase. Same pattern as the 14 CURO Statement/Settlement docs already held pending Kayne's conversation with Jani (Q10, 2026-09-15).",
  },
  {
    id: 84, filename: "Invoice C269.19578.210521970.pdf",
    invoice: "C269.19578.210521970", supplier: "CURO Payments B.V.",
    bills_status: "needs_review", account_code: null, tax_code: null,
    reason: "CURO Payments B.V. transaction-cost invoice, EUR 2.30 (Bancontact processing fee on order 44108). This IS a genuine payable, but has no account-code precedent yet -- same open gap as #45/#63/#70 (CURO processing fee coding undecided). Held for Kayne's coding decision, not for the Q10 receivables question.",
  },
  {
    id: 85, filename: "Settlement R269.19578.210521970.pdf",
    invoice: "R269.19578.210521970", supplier: "CURO Payments B.V.",
    bills_status: "needs_review", account_code: null, tax_code: null,
    reason: "CURO Payments B.V. Settlement document (net payout EUR 80.20 after fee, scheduled 2026-09-22). Not a vendor bill -- receivables/payment-processor paperwork. Same pattern as the 14 CURO Statement/Settlement docs already held pending Kayne's conversation with Jani (Q10, 2026-09-15).",
  },
];

console.log(`=== Bills Management: routing 5 new documents (#81-85) ===\n`);

const backup = [];
for (const d of docs) {
  const rows = await query(`SELECT * FROM mailbox_invoice_files WHERE id=?`, [d.id]);
  backup.push(rows[0]);
}
const { writeFile, mkdir } = await import("node:fs/promises");
await mkdir("/opt/projects/gopure/bills_management/backups", { recursive: true });
const backupPath = `/opt/projects/gopure/bills_management/backups/route_5_new_docs_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(backupPath, JSON.stringify(backup, null, 2));
console.log(`Backed up -> ${backupPath}\n`);

for (const d of docs) {
  const result = {
    bills_status: d.bills_status,
    bills_status_reason: d.reason,
    duplicate_check_result: "unique",
    duplicate_check_reference: null,
    account_code: d.account_code,
    tax_code: d.tax_code,
  };
  await applyBillsStatus(d.id, result, { execute: (await import("../src/db/mysql.js")).execute }, true);

  const target = FOLDER[d.bills_status];
  await nextcloud.moveFile(`${INCOMING}/${d.id}_${d.filename}`, `${target}/${d.id}_${d.filename}`);
  console.log(`#${d.id} (${d.supplier}): -> ${target}`);
}

console.log("\n=== Syncing Documents Review Log.xlsx ===");
const newRowInfo = Object.fromEntries(docs.map((d) => [d.id, { invoice: d.invoice, supplier: d.supplier }]));
const syncResult = await syncReviewLog(nextcloud, query, newRowInfo);
console.log(`${syncResult.changed} updated, ${syncResult.added} added, ${syncResult.unchanged} unchanged.`);

await closePool();
