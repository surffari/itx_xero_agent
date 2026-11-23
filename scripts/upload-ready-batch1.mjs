#!/usr/bin/env node
// Bills Management: first real "Ready for Xero -> Uploaded to Xero" batch, run at Kayne's
// explicit request (2026-09-24). Creates DRAFT ACCPAY bills in Xero via the same logic as
// the existing create_bill_from_mailbox_file MCP tool (src/mcp/server.ts), reused here
// standalone since that MCP server isn't connected in this session. Always dry_run=true
// first for the whole batch, then only proceeds to real writes if explicitly told to via
// argv. Every fact below (amount/currency/date/invoice number/account/tax) is either
// already verified real-PDF-review data from bills_status_reason (2026-09-17/2026-09-22
// sessions), or freshly re-verified against the actual PDF (#6, re-read this run since its
// exact date/invoice number weren't in the stored reason). Contact IDs were resolved
// against live Xero get_contacts + get_bills history just now, picking the contact each
// supplier's PAID/AUTHORISED bill history already uses (Kuura Solutions LLC not
// Kuurasolutions.com; Paulo Tomas not Paulo Thomas -- a likely Xero duplicate-contact
// pair, flagged separately, not fixed here; DigitalOcean LLC not Digitalocean EU B.V.).
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

const DOCS = [
  { id: 6, supplier: "OnlineJobs.ph", contactId: "721df096-ceb3-474f-838d-0420b6e6b656",
    amount: 83.49, currency: "USD", date: "2026-07-15", ref: "873668",
    description: "OnlineJobs.ph Monthly Subscription", accountCode: "429", taxCode: "TAX057" },
  { id: 42, supplier: "Kuura Solutions LLC", contactId: "08cb1a8b-97d9-4590-877a-f92876ca0e92",
    amount: 200.00, currency: "USD", date: "2026-09-01", ref: "KS00019",
    description: "Ecommerce Management", accountCode: "429", taxCode: "TAX023" },
  { id: 66, supplier: "Kayne Joelle Pecha", contactId: "a796ccca-be2a-43d7-b8ce-659c9828e270",
    amount: 70.00, currency: "USD", date: "2026-09-07", ref: "INV-850884",
    description: "Bookkeeping & accounting support", accountCode: "480", taxCode: "TAX023" },
  { id: 68, supplier: "Paulo Tomas", contactId: "3d295abd-27ca-4a22-9595-f70f8ffe8ec7",
    amount: 260.00, currency: "USD", date: "2026-09-14", ref: "14-09-2026",
    description: "Virtual Assistant services", accountCode: "480", taxCode: "TAX023" },
  { id: 73, supplier: "Cloudflare, Inc.", contactId: "d1b17133-0239-49fa-bd0f-eb79fd16cffc",
    amount: 25.00, currency: "USD", date: "2026-08-04", ref: "IN-73972881",
    description: "Cloudflare Pro Plan", accountCode: "450", taxCode: "TAX023" },
  { id: 74, supplier: "Cloudflare, Inc.", contactId: "d1b17133-0239-49fa-bd0f-eb79fd16cffc",
    amount: 25.00, currency: "USD", date: "2026-09-04", ref: "IN-77829415",
    description: "Cloudflare Pro Plan", accountCode: "450", taxCode: "TAX023" },
  { id: 75, supplier: "DigitalOcean LLC", contactId: "ef8897e0-7442-4bb6-8ebb-ded344d0034a",
    amount: 66.50, currency: "USD", date: "2026-09-01", ref: "2278000",
    description: "Cloudways hosting - August 2026", accountCode: "485", taxCode: "TAX021" },
  { id: 76, supplier: "DigitalOcean LLC", contactId: "ef8897e0-7442-4bb6-8ebb-ded344d0034a",
    amount: 66.50, currency: "USD", date: "2026-08-01", ref: "2152154",
    description: "Cloudways hosting - July 2026", accountCode: "485", taxCode: "TAX021" },
  { id: 77, supplier: "DigitalOcean LLC", contactId: "ef8897e0-7442-4bb6-8ebb-ded344d0034a",
    amount: 66.50, currency: "USD", date: "2026-07-01", ref: "2039495",
    description: "Cloudways hosting - June 2026", accountCode: "485", taxCode: "TAX021" },
  { id: 80, supplier: "Brevo", contactId: "7c74074c-ff7e-400f-9103-9d65e22fb444",
    amount: 55.00, currency: "EUR", date: "2026-09-19", ref: "SIB-5890005",
    description: "Brevo marketing subscription", accountCode: "000", taxCode: "TAX021" },
];

console.log(`=== Bills Management: uploading batch 1 (${DOCS.length} docs) to Xero as DRAFT bills — ${DRY_RUN ? "DRY RUN" : "REAL WRITE"} ===\n`);

for (const d of DOCS) {
  const rows = await query(`SELECT id, uid, attachment_filename FROM mailbox_invoice_files WHERE id=?`, [d.id]);
  const file = rows[0];
  if (!file) { console.log(`SKIP #${d.id}: not found in mailbox_invoice_files`); continue; }

  const payload = {
    Type: "ACCPAY",
    Contact: { ContactID: d.contactId },
    Date: d.date,
    DueDate: d.date,
    LineAmountTypes: "Inclusive",
    CurrencyCode: d.currency,
    Reference: d.ref,
    InvoiceNumber: d.ref,
    LineItems: [{ Description: d.description, Quantity: 1, UnitAmount: d.amount, AccountCode: d.accountCode, TaxType: d.taxCode }],
  };
  const idempotencyKey = `mailbox-bill:${shortHash(`${tenantId}:${d.id}:${d.ref}:${d.date}:${d.amount}:${d.currency}`)}`;

  try {
    const created = await writeClient.createBill(tenantId, payload, idempotencyKey, d.ref, DRY_RUN);
    if (DRY_RUN) {
      console.log(`DRY-RUN #${d.id} (${d.supplier}, ${d.currency} ${d.amount}, ${d.date}, ${d.accountCode}/${d.taxCode}, ref ${d.ref}): payload OK`);
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
