#!/usr/bin/env node
// One-off: draft Monta Germany GmbH August 2026 invoice (#111, 26610614) as a DRAFT ACCPAY bill.
// Same guards and createBill/attachPdf as create_bill_from_mailbox_file; single line: every category on the invoice is VAT reverse charge (ICL), same coding as July bill 26610546 (409 / TAX021).
// Usage: DRY=1|0 node --import tsx scripts/draft-monta-de-20261013.mjs
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
const CONTACT = "136ac226-5395-4b91-baf9-de19a42e8af1"; // "Monta Germany GmbH": contact on July bill 26610546

const BILLS = [
  {
    mailbox_file_id: 111, invoice_number: "26610614", date: "2026-08-31", due: "2026-09-14", total: 3691.81,
    desc: "Fulfilment 01-08-2026 t/m 31-08-2026",
    lines: [
      { Description: "Monta fulfilment Aug 2026 (handling, storage, packing, shipments, returns) - VAT reverse charge", UnitAmount: 3691.81, TaxType: "TAX021", TaxAmount: 0 },
    ],
  },
];
const SUPPLIER = "Monta Germany GmbH";

const chart = await query(`SELECT code, name, type, status FROM xero_accounts WHERE tenant_id=? AND code IS NOT NULL`, [tenant_id]);
const contacts = await query(`SELECT contact_id, name, status FROM xero_contacts WHERE tenant_id=? AND is_supplier=1`, [tenant_id]);
const ACCOUNT = "409"; // Fulfillment Costs, same as July Monta Germany bill 26610546

for (const b of BILLS) {
  console.log(`\n=== #${b.mailbox_file_id} Monta Germany EUR${b.total} ${b.invoice_number} (${DRY ? "DRY RUN" : "LIVE"}) ===`);
  const sum = Math.round(b.lines.reduce((a, l) => a + l.UnitAmount, 0) * 100) / 100;
  if (sum !== b.total) { console.log("STOP: line sum", sum, "!= invoice total", b.total); continue; }
  const [file] = await query(`SELECT id, uid, attachment_filename, status, matched_invoice_id FROM mailbox_invoice_files WHERE id=?`, [b.mailbox_file_id]);
  if (!file) { console.log("STOP: mailbox file not found"); continue; }
  if (file.matched_invoice_id) { console.log("STOP: already matched", file.matched_invoice_id); continue; }

  const curo = checkCuroDocument(SUPPLIER, file.attachment_filename);
  if (!curo.ok) { console.log("NEEDS REVIEW (CURO):", curo.reason); continue; }
  const dup = await checkDuplicate(
    { id: file.id, status: file.status, matched_orphan_id: null, matched_invoice_id: null,
      extracted_supplier: SUPPLIER, extracted_amount: b.total, extracted_currency: "EUR", extracted_date: b.date },
    { tenantId: tenant_id, reference: null, invoiceNumber: b.invoice_number },
    (sql, args) => query(sql, args)
  );
  if (dup.result === "duplicate") { console.log("NEEDS REVIEW (duplicate):", JSON.stringify(dup.match)); continue; }
  const acct = checkAccountCodeForBill(ACCOUNT, undefined, chart);
  if (!acct.ok) { console.log("NEEDS REVIEW (account code):", acct.reason); continue; }
  const cr = resolveContactForBill(SUPPLIER, CONTACT, contacts);
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
    [SUPPLIER, b.total, b.date, created.InvoiceID, b.mailbox_file_id]
  );
  console.log("CREATED", JSON.stringify({ InvoiceID: created.InvoiceID, InvoiceNumber: created.InvoiceNumber, Status: created.Status, Total: created.Total, TotalTax: created.TotalTax, attachment: attach }));
}
await closePool();
process.exit(0);
