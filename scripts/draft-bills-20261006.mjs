#!/usr/bin/env node
// One-off: draft Kayne Pecha (#87), Paulo Tomas (#88), Kuura Solutions (#104) bills.
// Mirrors create_bill_from_mailbox_file in src/mcp/server.ts (same guards, same createBill/attachPdf).
// Usage: DRY=1 node --import tsx scripts/draft-bills-20261006.mjs   (preview)
//        DRY=0 node --import tsx scripts/draft-bills-20261006.mjs   (create DRAFT bills)
import "dotenv/config";
import { createHash } from "node:crypto";
import { query, execute, closePool } from "../src/db/mysql.js";
import { config } from "../src/config.js";
import { XeroWriteClient } from "../src/xero/write-client.js";
import { MailboxClient } from "../src/email/imap-client.js";
import { checkCuroDocument } from "../src/bills/curo-document-guard.js";
import { checkDuplicate } from "../src/bills/routing.js";
import { checkAccountCodeForBill } from "../src/bills/account-code-guard.js";
import { resolveContactForBill } from "../src/bills/contact-resolution-guard.js";

const DRY = process.env.DRY !== "0";
const tenant_id = config.XERO_TENANT_ID;
const shortHash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const wc = new XeroWriteClient();
const mc = new MailboxClient();

const BILLS = [
  {
    mailbox_file_id: 87, supplier_name: "Kayne Joelle Pecha", contact_id: "a796ccca-be2a-43d7-b8ce-659c9828e270",
    amount: 70.0, currency: "USD", date: "2026-09-28", invoice_number: "INV-131954",
    description: "Bookkeeping & Accounting Support and Stock & Operations Management, 21-27 Sep 2026 (20 h @ USD 3.50)",
    account_code: "480", tax_code: "TAX023", // contractor/freelance, same as all prior Pecha bills
  },
  {
    mailbox_file_id: 88, supplier_name: "Paulo Tomas", contact_id: "3d295abd-27ca-4a22-9595-f70f8ffe8ec7",
    amount: 260.0, currency: "USD", date: "2026-09-28", invoice_number: "28-09-2026",
    description: "Virtual Assistant services, week 22-27 Sep 2026 (40 h)",
    account_code: "480", tax_code: "TAX023", // IAR contractor rule: Paulo Tomas -> 480 / TAX023
  },
  {
    mailbox_file_id: 104, supplier_name: "Kuura Solutions LLC", contact_id: "08cb1a8b-97d9-4590-877a-f92876ca0e92",
    amount: 200.0, currency: "USD", date: "2026-10-02", invoice_number: "KS00020",
    description: "Ecommerce Management",
    account_code: "429", tax_code: "TAX023", // follows KS00019 (USD 200, Sep) -- 429 is a catch-all; flagged for review
  },
];

const chart = await query(`SELECT code, name, type, status FROM xero_accounts WHERE tenant_id=? AND code IS NOT NULL`, [tenant_id]);
const contacts = await query(`SELECT contact_id, name, status FROM xero_contacts WHERE tenant_id=? AND is_supplier=1`, [tenant_id]);

for (const b of BILLS) {
  console.log(`\n=== #${b.mailbox_file_id} ${b.supplier_name} ${b.currency}${b.amount} ${b.invoice_number} (${DRY ? "DRY RUN" : "LIVE"}) ===`);
  const [file] = await query(`SELECT id, uid, attachment_filename, status, matched_invoice_id FROM mailbox_invoice_files WHERE id=?`, [b.mailbox_file_id]);
  if (!file) { console.log("STOP: mailbox file not found"); continue; }
  if (file.matched_invoice_id) { console.log("STOP: already matched to invoice", file.matched_invoice_id); continue; }

  const curo = checkCuroDocument(b.supplier_name, file.attachment_filename);
  if (!curo.ok) { console.log("NEEDS REVIEW (CURO):", curo.reason); continue; }

  const dup = await checkDuplicate(
    { id: file.id, status: file.status, matched_orphan_id: null, matched_invoice_id: file.matched_invoice_id,
      extracted_supplier: b.supplier_name, extracted_amount: b.amount, extracted_currency: b.currency, extracted_date: b.date },
    { tenantId: tenant_id, reference: null, invoiceNumber: b.invoice_number },
    (sql, args) => query(sql, args)
  );
  if (dup.result === "duplicate") { console.log("NEEDS REVIEW (duplicate):", JSON.stringify(dup.match)); continue; }

  const acct = checkAccountCodeForBill(b.account_code, undefined, chart);
  if (!acct.ok) { console.log("NEEDS REVIEW (account code):", acct.reason); continue; }

  const cr = resolveContactForBill(b.supplier_name, b.contact_id, contacts);
  if (!cr.ok) { console.log("NEEDS REVIEW (contact):", cr.reason); continue; }

  const payload = {
    Type: "ACCPAY",
    Contact: cr.contactId ? { ContactID: cr.contactId } : { Name: b.supplier_name },
    Date: b.date, DueDate: b.date, LineAmountTypes: "Inclusive", CurrencyCode: b.currency,
    LineItems: [{ Description: b.description, Quantity: 1, UnitAmount: b.amount, AccountCode: b.account_code, TaxType: b.tax_code }],
    InvoiceNumber: b.invoice_number,
  };
  console.log("guards passed; payload:", JSON.stringify(payload));

  const key = `mailbox-bill:${shortHash(`${tenant_id}:${b.mailbox_file_id}::${b.invoice_number}:${b.date}:${b.amount}:${b.currency}`)}`;
  const created = await wc.createBill(tenant_id, payload, key, b.invoice_number, DRY);
  if (DRY) { console.log("dry-run ok (nothing created in Xero)"); continue; }

  const buf = await mc.downloadAttachment(Number(file.uid), file.attachment_filename);
  const attach = await wc.attachPdf(tenant_id, created.InvoiceID, file.attachment_filename, buf, false);
  await execute(
    `UPDATE mailbox_invoice_files SET status='matched', extracted_supplier=?, extracted_amount=?, extracted_currency=?, extracted_date=?, matched_invoice_id=? WHERE id=?`,
    [b.supplier_name, b.amount, b.currency, b.date, created.InvoiceID, b.mailbox_file_id]
  );
  console.log("CREATED", JSON.stringify({ InvoiceID: created.InvoiceID, InvoiceNumber: created.InvoiceNumber, Status: created.Status, Total: created.Total, attachment: attach }));
}
await closePool();
process.exit(0);
