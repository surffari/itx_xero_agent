#!/usr/bin/env node
// One-off: draft Monta Enschede B.V. July (#114) and August (#112) 2026 invoices as DRAFT ACCPAY bills.
// Same guards and createBill/attachPdf as create_bill_from_mailbox_file; multi-line because each invoice has a VAT-exempt part.
// Usage: DRY=1|0 node --import tsx scripts/draft-monta-nl-20261006.mjs
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
const CONTACT = "f414463e-3af0-4869-a579-e8919315b052"; // "Monta Enschede": contact on all earlier Monta NL bills

const BILLS = [
  {
    mailbox_file_id: 114, invoice_number: "26481906", date: "2026-07-31", due: "2026-08-14", total: 1603.33,
    desc: "Fulfilment 01-07-2026 t/m 31-07-2026",
    lines: [
      { Description: "Monta fulfilment Jul 2026 (handling, storage, packing, shipments, returns) - 21% VAT part", UnitAmount: 1581.07, TaxType: "TAX057", TaxAmount: 274.42 },
      { Description: "Monta fulfilment Jul 2026 - shipments VAT exempt (UPS BTW)", UnitAmount: 22.26, TaxType: "TAX023", TaxAmount: 0 },
    ],
  },
  {
    mailbox_file_id: 112, invoice_number: "26482177", date: "2026-08-31", due: "2026-09-14", total: 1706.32,
    desc: "Fulfilment 01-08-2026 t/m 31-08-2026",
    lines: [
      { Description: "Monta fulfilment Aug 2026 (handling, storage, packing, shipments, returns) - 21% VAT part", UnitAmount: 1696.66, TaxType: "TAX057", TaxAmount: 294.5 },
      { Description: "Monta fulfilment Aug 2026 - shipments VAT exempt", UnitAmount: 9.66, TaxType: "TAX023", TaxAmount: 0 },
    ],
  },
];

const chart = await query(`SELECT code, name, type, status FROM xero_accounts WHERE tenant_id=? AND code IS NOT NULL`, [tenant_id]);
const contacts = await query(`SELECT contact_id, name, status FROM xero_contacts WHERE tenant_id=? AND is_supplier=1`, [tenant_id]);
const ACCOUNT = "409"; // IAR-005: Monta Enschede -> 409 Fulfillment Costs, same as all earlier Monta NL bills

for (const b of BILLS) {
  console.log(`\n=== #${b.mailbox_file_id} Monta Enschede EUR${b.total} ${b.invoice_number} (${DRY ? "DRY RUN" : "LIVE"}) ===`);
  const sum = Math.round(b.lines.reduce((a, l) => a + l.UnitAmount, 0) * 100) / 100;
  if (sum !== b.total) { console.log("STOP: line sum", sum, "!= invoice total", b.total); continue; }
  const [file] = await query(`SELECT id, uid, attachment_filename, status, matched_invoice_id FROM mailbox_invoice_files WHERE id=?`, [b.mailbox_file_id]);
  if (!file) { console.log("STOP: mailbox file not found"); continue; }
  if (file.matched_invoice_id) { console.log("STOP: already matched", file.matched_invoice_id); continue; }

  const curo = checkCuroDocument("Monta Enschede B.V.", file.attachment_filename);
  if (!curo.ok) { console.log("NEEDS REVIEW (CURO):", curo.reason); continue; }
  const dup = await checkDuplicate(
    { id: file.id, status: file.status, matched_orphan_id: null, matched_invoice_id: null,
      extracted_supplier: "Monta Enschede B.V.", extracted_amount: b.total, extracted_currency: "EUR", extracted_date: b.date },
    { tenantId: tenant_id, reference: null, invoiceNumber: b.invoice_number },
    (sql, args) => query(sql, args)
  );
  if (dup.result === "duplicate") { console.log("NEEDS REVIEW (duplicate):", JSON.stringify(dup.match)); continue; }
  const acct = checkAccountCodeForBill(ACCOUNT, undefined, chart);
  if (!acct.ok) { console.log("NEEDS REVIEW (account code):", acct.reason); continue; }
  const cr = resolveContactForBill("Monta Enschede B.V.", CONTACT, contacts);
  if (!cr.ok) { console.log("NEEDS REVIEW (contact):", cr.reason); continue; }

  const payload = {
    Type: "ACCPAY",
    Contact: { ContactID: cr.contactId },
    Date: b.date, DueDate: b.due, LineAmountTypes: "Inclusive", CurrencyCode: "EUR",
    InvoiceNumber: b.invoice_number, Reference: b.desc,
    LineItems: b.lines.map((l) => ({ ...l, Quantity: 1, AccountCode: ACCOUNT })),
  };
  console.log("guards passed; payload:", JSON.stringify(payload));

  const key = `mailbox-bill:${shortHash(`${tenant_id}:${b.mailbox_file_id}::${b.invoice_number}:${b.date}:${b.total}:EUR`)}`;
  const created = await wc.createBill(tenant_id, payload, key, b.invoice_number, DRY);
  if (DRY) { console.log("dry-run ok (nothing created in Xero)"); continue; }

  const buf = await mc.downloadAttachment(Number(file.uid), file.attachment_filename);
  const attach = await wc.attachPdf(tenant_id, created.InvoiceID, file.attachment_filename, buf, false);
  await execute(
    `UPDATE mailbox_invoice_files SET status='matched', extracted_supplier=?, extracted_amount=?, extracted_currency='EUR', extracted_date=?, matched_invoice_id=? WHERE id=?`,
    ["Monta Enschede B.V.", b.total, b.date, created.InvoiceID, b.mailbox_file_id]
  );
  console.log("CREATED", JSON.stringify({ InvoiceID: created.InvoiceID, InvoiceNumber: created.InvoiceNumber, Status: created.Status, Total: created.Total, TotalTax: created.TotalTax, attachment: attach }));
}
await closePool();
process.exit(0);
