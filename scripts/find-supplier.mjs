#!/usr/bin/env node
// Read-only: find everything about a supplier keyword across mailbox docs, Nextcloud folders, Xero bills and the missing-document bank queue.
// Usage: node --import tsx scripts/find-supplier.mjs monta
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { config } from "../src/config.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";

const kw = (process.argv[2] ?? "").toLowerCase();
const like = `%${kw}%`;
const t = config.XERO_TENANT_ID;
const ymd = (x) => (x ? new Date(x).toISOString().slice(0, 10) : "-");

console.log(`## mailbox_invoice_files matching "${kw}"`);
const mb = await query(
  `SELECT id, received_at, attachment_filename f, subject, from_address, status, bills_status, matched_invoice_id, LEFT(bills_status_reason,120) reason
   FROM mailbox_invoice_files
   WHERE LOWER(CONCAT_WS(' ', attachment_filename, subject, from_address, extracted_supplier)) LIKE ? ORDER BY received_at`, [like]);
mb.forEach((m) => console.log(`  #${m.id} ${ymd(m.received_at)} ${String(m.f).slice(0, 50).padEnd(50)} ${m.bills_status} ${m.matched_invoice_id ? "[in Xero]" : ""} ${String(m.from_address ?? "").slice(0, 30)}`));
if (!mb.length) console.log("  none");

console.log(`\n## Nextcloud folders`);
const nc = new NextcloudWebDavClient();
for (const f of ["📥 01 - Incoming", "⚠️ 02 - Needs Review", "✅ 03 - Ready for Xero", "📤 04 - Uploaded to Xero", "🚨 05 - Exceptions"]) {
  const hit = (await nc.listFolder(f)).filter((n) => n.toLowerCase().includes(kw));
  if (hit.length) console.log(`  ${f}: ${hit.join(" | ")}`);
}

console.log(`\n## Xero bills (ACCPAY, any status)`);
const bills = await query(
  `SELECT invoice_number, contact_name, total, currency_code cur, status, invoice_date, amount_due FROM xero_invoice_balances
   WHERE tenant_id=? AND invoice_type='ACCPAY' AND LOWER(contact_name) LIKE ? ORDER BY invoice_date DESC LIMIT 25`, [t, like]);
bills.forEach((b) => console.log(`  ${ymd(b.invoice_date)} ${String(b.invoice_number ?? "-").padEnd(16)} ${String(b.contact_name).padEnd(24)} ${b.cur} ${Number(b.total).toFixed(2).padStart(10)} ${b.status} due ${Number(b.amount_due).toFixed(2)}`));
if (!bills.length) console.log("  none");
const contacts = await query(`SELECT contact_id, name, status FROM xero_contacts WHERE tenant_id=? AND LOWER(name) LIKE ?`, [t, like]);
contacts.forEach((c) => console.log(`  contact: ${c.name} [${c.status}] ${c.contact_id}`));

console.log(`\n## Bank lines (all statuses)`);
const bank = await query(
  `SELECT DATE(transaction_date) dt, amount, currency cur, COALESCE(payee,contact_name,description) who, status FROM bank_spend_orphans
   WHERE tenant_id=? AND LOWER(COALESCE(payee,contact_name,description,reference)) LIKE ? ORDER BY transaction_date`, [t, like]);
bank.forEach((b) => console.log(`  ${ymd(b.dt)} ${b.cur} ${Math.abs(Number(b.amount)).toFixed(2).padStart(10)} ${String(b.who).slice(0, 44)} [${b.status}]`));
if (!bank.length) console.log("  none");
await closePool();
process.exit(0);
