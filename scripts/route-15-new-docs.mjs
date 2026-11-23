#!/usr/bin/env node
// Bills Management: real-PDF review of the 15 documents that arrived since the last full
// route (2026-09-17) -- ids 66-80. Same methodology as the 2026-09-14 batch review: read
// every actual PDF (downloaded read-only over IMAP, cached locally for this run), determine
// genuine invoice vs not, verify against live Xero (get_bills/get_contacts) for duplicates
// -- not assumed -- and route with a real, recorded reason. No document was in Nextcloud yet
// (Incoming was verified empty before this ran), so every one is a first upload, not a move.
//
// Real findings from this review:
//   - #72 (Cloudflare, July 4, $25 USD) is a CONFIRMED DUPLICATE of an already-paid Xero
//     bill (99fd89d2-..., same date/amount/contact) -- caught only because this review
//     checked live Xero per-supplier, not just the mailbox-internal duplicate check.
//   - #79 (ESA 7908.pdf) is the SAME invoice already fixed as #51/#65 (SHA-256 verified) --
//     a fourth copy of #32's already-paid bill.
//   - #67 has the same invoice number as #66 (INV-850884, a template bug on Kayne's own
//     invoice) but is a genuinely different billing period -- however its own total is
//     broken (#VALUE! formula error in the source document), so the billed amount can't be
//     confirmed from the document as issued.
//   - #69/#71 are CURO Payments receivables paperwork (Statement/Settlement), same
//     non-actionable pattern as the 12 already-parked docs (Q10). #70 is the genuine
//     processing-fee payable, same "no rule-register match" gap as #45/#63.
//   - #78 (Sanoma Media Finland) is billed directly to Mari Oksala's personal address, not
//     Intactix B.V. -- same pattern as #56 (Q6).
//   - #73/#74 (Cloudflare Aug/Sep) and #75/#76/#77 (DigitalOcean Jul/Aug/Sep) and #80
//     (Brevo Sep) are all verified genuinely new via live Xero lookup -- no existing bill
//     matches their date, so not duplicates of the recurring-but-different-month pattern
//     (Q9/D17: a different date never flags a duplicate on its own).
//
// Uses applyBillsStatus() throughout so bills_status_changed_at is set correctly (D24).
import "dotenv/config";
import { execute, closePool } from "../src/db/mysql.js";
import { applyBillsStatus } from "../src/bills/apply-status.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { syncReviewLog } from "../src/bills/review-log.js";
import { readFile, writeFile } from "node:fs/promises";

const SCRATCH = "/tmp/claude-1007/-opt-projects-gopure-bills-management/b096a96b-90b0-4df1-bdef-4255b9d9c440/scratchpad/new15";

const FOLDER = {
  incoming: "📥 01 - Incoming",
  needs_review: "⚠️ 02 - Needs Review",
  ready_for_xero: "✅ 03 - Ready for Xero",
  uploaded_to_xero: "📤 04 - Uploaded to Xero",
  exceptions: "🚨 05 - Exceptions",
};

const docs = [
  {
    id: 66, filename: "KAYNE JOELLE PECHA– INVOICE 850884 - Invoice Template.pdf",
    invoice: "INV-850884", supplier: "Kayne Joelle Pecha",
    bills_status: "ready_for_xero", account_code: "480", tax_code: "TAX023",
    reason: "Kayne Joelle Pecha (Philippines, non-EU individual), INV-850884, USD 70.00, " +
      "2026-09-07, billing period Aug 31-Sep 6. Related-party contractor invoice, same " +
      "pattern as #21/#34/#38. No VAT shown -> 480/TAX023 (IAR-006). Verified not a " +
      "duplicate: most recent existing Xero bill for this contact is dated 2026-08-31.",
  },
  {
    id: 67, filename: "KAYNE JOELLE PECHA– INVOICE 850884 - Invoice Template (1).pdf",
    invoice: "INV-850884 (dup#, see reason)", supplier: "Kayne Joelle Pecha",
    bills_status: "needs_review", account_code: null, tax_code: null,
    reason: "Kayne Joelle Pecha, same invoice number as #66 (INV-850884, a template bug -- " +
      "genuinely different billing period, Sep 7-13) but the source document's own total is " +
      "broken -- '#VALUE!' formula error on Subtotal/Total Due, billed amount can't be " +
      "confirmed from the invoice as issued. Verified not a duplicate of any existing bill.",
  },
  {
    id: 68, filename: "GP Invoice 14-09-2026.pdf",
    invoice: "14-09-2026", supplier: "Paulo Tomas",
    bills_status: "ready_for_xero", account_code: "480", tax_code: "TAX023",
    reason: "Paulo Tomas (Philippines, non-EU individual), Virtual Assistant, USD 260.00, " +
      "invoice ref 14-09-2026, week of 7-14 Sept 2026. Same VA contractor pattern as the " +
      "existing Aug 24 precedent (480/TAX023, IAR-006). Verified not a duplicate.",
  },
  {
    id: 69, filename: "Statement S269.19578.210520866.pdf",
    invoice: "S269.19578.210520866", supplier: "CURO Payments B.V.",
    bills_status: "needs_review", account_code: null, tax_code: null,
    reason: "CURO Payments B.V. Statement S269.19578.210520866, EUR 330.19, 2026-09-13. " +
      "Not a vendor bill -- Intactix's own outgoing Request for Payment to CURO, same " +
      "receivables/settlement pattern as the 12 already-parked docs (Q10). New instance, " +
      "same treatment: held pending Kayne's conversation with Jani.",
  },
  {
    id: 70, filename: "Invoice C269.19578.210520866.pdf",
    invoice: "C269.19578.210520866", supplier: "CURO Payments B.V.",
    bills_status: "needs_review", account_code: null, tax_code: null,
    reason: "CURO Payments B.V. processing-fee invoice C269.19578.210520866, EUR 9.21, " +
      "2026-09-13 -- the genuine payable in this batch (unlike #69/#71). Same honest gap as " +
      "#45/#63: 'payment processing fees' has no rule-register account-code match.",
  },
  {
    id: 71, filename: "Settlement R269.19578.210520866.pdf",
    invoice: "R269.19578.210520866", supplier: "CURO Payments B.V.",
    bills_status: "needs_review", account_code: null, tax_code: null,
    reason: "CURO Payments B.V. Settlement R269.19578.210520866, EUR 320.98 net payout, " +
      "2026-09-13. Receivables-side settlement summary, same non-actionable pattern as the " +
      "12 already-parked Statement/Settlement docs (Q10). Held pending same conversation.",
  },
  {
    id: 72, filename: "d475303e-b5c3-5a39-ac31-0fd91b179121.pdf",
    invoice: "IN-70385484", supplier: "Cloudflare, Inc.",
    bills_status: "exceptions", account_code: null, tax_code: null, duplicate: "99fd89d2-2a69-4648-870d-8113dfdf868f",
    reason: "Cloudflare, Inc., invoice IN-70385484, USD 25.00, 2026-07-04, Cloudflare Pro " +
      "Plan (gopure.shop). CONFIRMED DUPLICATE: already-paid Xero bill 99fd89d2-... matches " +
      "exactly on date/amount/currency/contact (checked live via get_bills). Never drafted " +
      "from this mailbox row -- no Xero write to undo, DB/Nextcloud correction only.",
  },
  {
    id: 73, filename: "016a3c8b-3443-5762-8061-242ce3f8f5e9.pdf",
    invoice: "IN-73972881", supplier: "Cloudflare, Inc.",
    bills_status: "ready_for_xero", account_code: "450", tax_code: "TAX023",
    reason: "Cloudflare, Inc. (US, non-EU), invoice IN-73972881, USD 25.00, 2026-08-04, " +
      "Cloudflare Pro Plan. $0 VAT shown, no reverse-charge statement -> No VAT (TAX023), " +
      "non-EU-no-VAT-shown SOP precedent. Coded 450 Hosting & Infrastructure (exact account " +
      "match). Verified not a duplicate: no Xero bill exists for August.",
  },
  {
    id: 74, filename: "df53374d-806a-5aae-8e12-0b5f90de7965.pdf",
    invoice: "IN-77829415", supplier: "Cloudflare, Inc.",
    bills_status: "ready_for_xero", account_code: "450", tax_code: "TAX023",
    reason: "Cloudflare, Inc. (US, non-EU), invoice IN-77829415, USD 25.00, 2026-09-04, " +
      "Cloudflare Pro Plan. Same reasoning as #73 (450/TAX023). Verified not a duplicate: " +
      "no Xero bill exists for September.",
  },
  {
    id: 75, filename: "Invoice_96ce84d0-d45a-4d86-9a3f-bdea6b32b1f8.pdf",
    invoice: "2278000", supplier: "DigitalOcean LLC",
    bills_status: "ready_for_xero", account_code: "485", tax_code: "TAX021",
    reason: "DigitalOcean LLC (Cloudways), invoice 2278000, USD 66.50, issued 2026-09-01, " +
      "August 2026 billing period. Invoice explicitly states 'VAT Netherlands (21.00%) ... " +
      "reverse charge $0.00' -> TAX021, same precedent as #41. Coded 485 Subscriptions & " +
      "Services. Verified not a duplicate: only existing DigitalOcean bill is dated 2026-06-01.",
  },
  {
    id: 76, filename: "Invoice_192ca868-f0b1-4ac5-9fac-301d78dc35a8.pdf",
    invoice: "2152154", supplier: "DigitalOcean LLC",
    bills_status: "ready_for_xero", account_code: "485", tax_code: "TAX021",
    reason: "DigitalOcean LLC (Cloudways), invoice 2152154, USD 66.50, issued 2026-08-01, " +
      "July 2026 billing period. Same explicit reverse-charge statement as #75/#41 -> " +
      "485/TAX021. Verified not a duplicate.",
  },
  {
    id: 77, filename: "Invoice_ab6f16c8-d773-4807-82b3-482fc132a7dd.pdf",
    invoice: "2039495", supplier: "DigitalOcean LLC",
    bills_status: "ready_for_xero", account_code: "485", tax_code: "TAX021",
    reason: "DigitalOcean LLC (Cloudways), invoice 2039495, USD 66.50, issued 2026-07-01, " +
      "June 2026 billing period. Same explicit reverse-charge statement as #75/#76/#41 -> " +
      "485/TAX021. Verified not a duplicate.",
  },
  {
    id: 78, filename: "2026-09-08-sanoma-media-finland-lasku49212608.pdf",
    invoice: "49212608", supplier: "Sanoma Media Finland Oy",
    bills_status: "exceptions", account_code: null, tax_code: null,
    reason: "Sanoma Media Finland Oy (Helsingin Sanomat digital subscription), invoice " +
      "49212608, EUR 89.40, billed directly to Mari Oksala's personal home address (Kampikatu " +
      "4 A 3, Lahti) -- not Intactix B.V. anywhere on the invoice. Same 'billed to a personal " +
      "individual' gap as #56 (Q6), next billing cycle of the same subscription.",
  },
  {
    id: 79, filename: "ESA 7908.pdf",
    invoice: "ESA 7908", supplier: "Easystart Office Amsterdam B.V.",
    bills_status: "exceptions", account_code: null, tax_code: null, duplicate: "4126a9d3-8061-467c-bdfa-d032c14de59e",
    reason: "Easystart Office Amsterdam B.V., ESA 7908, EUR 95.59, 2026-08-22. CONFIRMED " +
      "DUPLICATE: byte-for-byte identical (SHA-256) to #51/#65, already resolved as " +
      "duplicates of already-paid Xero bill 4126a9d3-... (D26). Fourth copy of the same " +
      "invoice. DB/Nextcloud correction only, never drafted from this row.",
  },
  {
    id: 80, filename: "SIB-5890005.pdf",
    invoice: "SIB-5890005", supplier: "Brevo (Sendinblue)",
    bills_status: "ready_for_xero", account_code: "000", tax_code: "TAX021",
    reason: "Brevo (Sendinblue, France, EU), invoice SIB-5890005, EUR 55.00, 2026-09-19, " +
      "marketing subscription + 20,000 recurring emails. Invoice explicitly states 'VAT is " +
      "not applicable ... reverse charge mechanism has been applied' -> TAX021. Coded 000 " +
      "Marketing Expense, matching the account code already used on Intactix's existing " +
      "Brevo bills (checked live). Verified not a duplicate: closest existing bill is dated " +
      "2026-07-19, a different billing period two months earlier.",
  },
];

console.log(`=== Routing ${docs.length} new real documents (first review, never in Nextcloud) ===\n`);

const backupDir = "/opt/projects/gopure/bills_management/backups";
await writeFile(
  `${backupDir}/route_15_new_docs_${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  JSON.stringify(docs, null, 2),
  "utf8"
);
console.log("Backed up correction records.\n");

const nc = new NextcloudWebDavClient();
const counts = {};
for (const d of docs) {
  await applyBillsStatus(
    d.id,
    {
      bills_status: d.bills_status,
      bills_status_reason: d.reason,
      duplicate_check_result: d.duplicate ? "duplicate" : "not_checked",
      duplicate_check_reference: d.duplicate ?? null,
      account_code: d.account_code,
      tax_code: d.tax_code,
    },
    { execute },
    true
  );
  const buffer = await readFile(`${SCRATCH}/${d.id}.pdf`);
  const targetName = `${d.id}_${d.filename}`;
  await nc.uploadFile(`${FOLDER[d.bills_status]}/${targetName}`, buffer);
  console.log(`OK   #${d.id} -> ${FOLDER[d.bills_status]}`);
  counts[d.bills_status] = (counts[d.bills_status] ?? 0) + 1;
}

console.log(`\nRouting counts: ${JSON.stringify(counts)}`);

console.log("\n=== Live folder verification (PROPFIND) ===");
for (const [status, folder] of Object.entries(FOLDER)) {
  const files = await nc.listFolder(folder);
  console.log(`${folder}: ${files.length} file(s)`);
}

console.log("\n=== Syncing Documents Review Log.xlsx ===");
const newRowInfo = Object.fromEntries(docs.map((d) => [d.id, { invoice: d.invoice, supplier: d.supplier }]));
const syncResult = await syncReviewLog(
  nc,
  (sql, args) => import("../src/db/mysql.js").then((m) => m.query(sql, args)),
  newRowInfo
);
console.log(`Backed up previous workbook -> ${syncResult.backupPath}`);
console.log(`${syncResult.changed} row(s) updated, ${syncResult.added} row(s) added, ${syncResult.unchanged} unchanged.`);
if (syncResult.addedIds.length > 0) console.log(`Added rows for: ${syncResult.addedIds.map((id) => `#${id}`).join(", ")}`);

await closePool();
