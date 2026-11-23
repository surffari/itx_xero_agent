#!/usr/bin/env node
// Bills Management: second Xero upload batch (2026-09-24), "upload the rest of the
// batch". Covers the remaining Ready for Xero docs after pulling out #41 (duplicate of
// #75), #52 (possible duplicate/correction of #66, held for Kayne), and #53 (duplicate
// of a live Xero bill) -- see fix-41-52-53.mjs. Every fact below was read directly from
// the real PDF this run. Contact IDs resolved live via get_contacts/get_bills, picking
// whichever contact each supplier's real bill history already uses (Atlassian Pty Ltd
// not "Atlassian"; Tradethno pte. ltd. not the 3 other near-duplicate spellings;
// Anthropic, PBC not "Anthropic"; FrontApp, Inc. not the 3 other Front variants).
// #17/#21 share the exact literal placeholder invoice number "[INV-2026-001]" from a
// third-party invoice-template default (same class of bug as #67's broken #VALUE!
// total) -- left blank rather than passed to Xero, where it could false-match against
// each other in the duplicate-reference check. Darlene Aberin (#57) has no existing
// Xero contact; created via Name.
import "dotenv/config";
import { createHash } from "node:crypto";
import { query, execute, closePool } from "../src/db/mysql.js";
import { config, requireMailboxConfig } from "../src/config.js";
import { MailboxClient } from "../src/email/imap-client.js";
import { XeroWriteClient } from "../src/xero/write-client.js";
import { markUploadedAfterDraftCreated } from "../src/bills/apply-status.js";

const tenantId = config.XERO_TENANT_ID;
const writeClient = new XeroWriteClient();
const mailboxClient = new MailboxClient(requireMailboxConfig());

function shortHash(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

const DRY_RUN = process.argv[2] !== "--real";

const KAYNE = "a796ccca-be2a-43d7-b8ce-659c9828e270";
const NICOLE = "5d952bda-05e2-4fcc-860f-f35af2513a65";

const DOCS = [
  { id: 7, supplier: "Keith Nicole V. Sarsaba", contactId: NICOLE,
    amount: 54.00, currency: "USD", date: "2026-08-10", ref: "INV-KNS-2026-003",
    description: "Customer Service (Aug 3-16, 2026)", accountCode: "480", taxCode: "TAX023" },
  { id: 17, supplier: "Keith Nicole V. Sarsaba", contactId: NICOLE,
    amount: 54.00, currency: "USD", date: "2026-07-27", ref: null,
    description: "Customer Service Representative (Jul 20-26, 2026)", accountCode: "480", taxCode: "TAX023" },
  { id: 21, supplier: "Kayne Joelle Pecha", contactId: KAYNE,
    amount: 70.00, currency: "USD", date: "2026-07-27", ref: null,
    description: "Bookkeeping & Accounting Support (Jul 20-26, 2026)", accountCode: "480", taxCode: "TAX023" },
  { id: 26, supplier: "Keith Nicole V. Sarsaba", contactId: NICOLE,
    amount: 56.00, currency: "USD", date: "2026-08-17", ref: "INV-KNS-2026-004",
    description: "Customer Service (Aug 10-16, 2026)", accountCode: "480", taxCode: "TAX023" },
  { id: 47, supplier: "Atlassian Pty Ltd", contactId: "1f6dc78f-81d8-40f1-999a-d611b485717e",
    amount: 10.00, currency: "USD", date: "2026-09-03", ref: "IN-EU-003-458-620",
    description: "Confluence subscription (Sep 2-Oct 2, 2026)", accountCode: "485", taxCode: "TAX021" },
  { id: 48, supplier: "Tradethno pte. ltd.", contactId: "b333bebc-a4dd-42f3-b582-aaa139e12dd1",
    amount: 3000.00, currency: "EUR", date: "2026-09-05", ref: "INV-0184",
    description: "Ecommerce Platform Development", accountCode: "310", taxCode: "TAX023" },
  { id: 49, supplier: "Anthropic, PBC", contactId: "87a05df7-c6b1-4d39-9b3a-970a8995a998",
    amount: 18.00, currency: "EUR", date: "2026-09-05", ref: "Q2IYL8NI-0010",
    description: "Claude Pro subscription (Sep 5-Oct 5, 2026)", accountCode: "485", taxCode: "TAX021" },
  { id: 54, supplier: "FrontApp, Inc.", contactId: "33845a51-03f8-4a66-9d8f-66a4b5440c92",
    amount: 58.00, currency: "USD", date: "2026-09-07", ref: "CD25D786-0049",
    description: "Front Starter Plan (Sep 7-Oct 7, 2026)", accountCode: "485", taxCode: "TAX023" },
  { id: 57, supplier: "Darlene L. Aberin", contactId: null,
    amount: 300.00, currency: "USD", date: "2026-08-28", ref: "10.8-28.8.2026",
    description: "Digital marketing services (10.8-28.8.2026)", accountCode: "480", taxCode: "TAX023" },
  { id: 58, supplier: "DirectLing Trade UG", contactId: "cc51014c-091d-4135-84a5-06c0769dcd87",
    amount: 1355.34, currency: "EUR", date: "2026-08-19", ref: "RE-1008",
    description: "Contract filling & labeling services, balance", accountCode: "310", taxCode: "TAX021" },
  { id: 59, supplier: "DirectLing Trade UG", contactId: "cc51014c-091d-4135-84a5-06c0769dcd87",
    amount: 40.90, currency: "EUR", date: "2026-09-03", ref: "RE-1010",
    description: "FedEx customs & import charges reimbursement", accountCode: "425", taxCode: "TAX021" },
  { id: 60, supplier: "Paulo Tomas", contactId: "3d295abd-27ca-4a22-9595-f70f8ffe8ec7",
    amount: 260.00, currency: "USD", date: "2026-09-07", ref: "01-09-2026",
    description: "Virtual Assistant (31 Aug-6 Sep 2026)", accountCode: "480", taxCode: "TAX023" },
  { id: 61, supplier: "Keith Nicole V. Sarsaba", contactId: NICOLE,
    amount: 60.00, currency: "USD", date: "2026-09-07", ref: "INV-KNS-2026-007",
    description: "Customer Service (Aug 31-Sep 7, 2026)", accountCode: "480", taxCode: "TAX023" },
  { id: 81, supplier: "Kayne Joelle Pecha", contactId: KAYNE,
    amount: 70.00, currency: "USD", date: "2026-09-21", ref: "INV-464375",
    description: "Bookkeeping & Accounting Support (Sep 13-20, 2026)", accountCode: "480", taxCode: "TAX023" },
  { id: 82, supplier: "Easystart Office Amsterdam B.V.", contactId: "37fdea5c-dfb7-4fd4-939c-df1b9ce777ff",
    amount: 95.59, currency: "EUR", date: "2026-09-22", ref: "ESA 8118",
    description: "Registratieadres KvK (21 Sep-20 Oct 2026)", accountCode: "453", taxCode: "TAX057" },
];

console.log(`=== Bills Management: uploading batch 2 (${DOCS.length} docs) to Xero as DRAFT bills — ${DRY_RUN ? "DRY RUN" : "REAL WRITE"} ===\n`);

for (const d of DOCS) {
  const rows = await query(`SELECT id, uid, attachment_filename FROM mailbox_invoice_files WHERE id=?`, [d.id]);
  const file = rows[0];
  if (!file) { console.log(`SKIP #${d.id}: not found in mailbox_invoice_files`); continue; }

  const payload = {
    Type: "ACCPAY",
    Contact: d.contactId ? { ContactID: d.contactId } : { Name: d.supplier },
    Date: d.date,
    DueDate: d.date,
    LineAmountTypes: "Inclusive",
    CurrencyCode: d.currency,
    LineItems: [{ Description: d.description, Quantity: 1, UnitAmount: d.amount, AccountCode: d.accountCode, TaxType: d.taxCode }],
  };
  if (d.ref) { payload.Reference = d.ref; payload.InvoiceNumber = d.ref; }

  const idempotencyKey = `mailbox-bill:${shortHash(`${tenantId}:${d.id}:${d.ref ?? ""}:${d.date}:${d.amount}:${d.currency}`)}`;

  try {
    const created = await writeClient.createBill(tenantId, payload, idempotencyKey, d.ref ?? `MAILBOX:${d.id}`, DRY_RUN);
    if (DRY_RUN) {
      console.log(`DRY-RUN #${d.id} (${d.supplier}, ${d.currency} ${d.amount}, ${d.date}, ${d.accountCode}/${d.taxCode}, ref ${d.ref ?? "(none)"}): payload OK`);
      continue;
    }
    console.log(`OK #${d.id}: Xero DRAFT bill created, InvoiceID=${created.InvoiceID}`);

    const buffer = await mailboxClient.downloadAttachment(Number(file.uid), file.attachment_filename);
    const attach = await writeClient.attachPdf(tenantId, created.InvoiceID, file.attachment_filename, buffer, false);
    console.log(`   attachment: ${attach.success ? "attached" : `FAILED (${attach.reason})`}`);

    await execute(
      `UPDATE mailbox_invoice_files
       SET status='matched', extracted_supplier=?, extracted_amount=?, extracted_currency=?, extracted_date=?, matched_invoice_id=?
       WHERE id=?`,
      [d.supplier, d.amount, d.currency, d.date, created.InvoiceID, d.id]
    );
    await markUploadedAfterDraftCreated(d.id, created.InvoiceID, { execute }, true, { accountCode: d.accountCode, taxCode: d.taxCode });
    console.log(`   mailbox_invoice_files updated (status=matched, bills_status=uploaded_to_xero)`);
  } catch (err) {
    console.log(`FAIL #${d.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await mailboxClient.close?.();
await closePool();
