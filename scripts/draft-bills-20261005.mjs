#!/usr/bin/env node
// One-off: draft ShipStation (#94), Cloudways/DigitalOcean (#93), Cloudflare (#105) bills.
// Mirrors create_bill_from_mailbox_file in src/mcp/server.ts (same guards, same createBill/attachPdf).
// Usage: DRY=1 node --import tsx scripts/draft-bills-20261005.mjs   (preview)
//        DRY=0 node --import tsx scripts/draft-bills-20261005.mjs   (create DRAFT bills)
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
    mailbox_file_id: 94, supplier_name: "ShipStation", contact_id: "8beeb029-0ac7-4c79-937d-bd010b0bad32",
    amount: 9.9, currency: "USD", date: "2026-10-01", invoice_number: "16487339",
    description: "ShipStation Standard - 50 plan, 1 Oct - 1 Nov 2026",
    account_code: "409", tax_code: "TAX023", // IAR-005: ShipStation corrected by Jani 2026-07-30 -> 409 / TAX023
  },
  {
    mailbox_file_id: 93, supplier_name: "DigitalOcean LLC", contact_id: "ef8897e0-7442-4bb6-8ebb-ded344d0034a",
    amount: 71.01, currency: "USD", date: "2026-10-01", invoice_number: "2440746",
    description: "Cloudways (DigitalOcean) hosting - September 2026 billing period",
    account_code: "485", tax_code: "TAX021", // same series as DO LLC bills 2152154 / 2278000
  },
  {
    mailbox_file_id: 105, supplier_name: "Cloudflare", contact_id: "d1b17133-0239-49fa-bd0f-eb79fd16cffc",
    amount: 25.0, currency: "USD", date: "2026-10-04", invoice_number: "IN-82103680",
    description: "Cloudflare Pro Plan (gopure.shop), 4 Oct - 3 Nov 2026",
    account_code: "450", tax_code: "TAX023", // IAR hosting -> 450; latest Cloudflare USD bills TAX023
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
