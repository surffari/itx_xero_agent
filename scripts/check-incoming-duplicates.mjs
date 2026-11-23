#!/usr/bin/env node
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { syncTransactions } from "../src/xero/sync.js";
import { isoDateDaysAgo, todayIsoDate } from "../src/lib/dates.js";

console.log("=== Syncing Xero (incremental, read-only) ===");
await syncTransactions(isoDateDaysAgo(200), todayIsoDate());

const checks = [
  { id: 4, invoiceNumber: "C268.19578.210514534", supplier: "CURO", amount: 1.09 },
  { id: 8, invoiceNumber: "INV-707545", supplier: "Kayne Joelle Pecha", amount: 70.00 },
  { id: 11, invoiceNumber: "Q2IYL8NI-0009", supplier: "Anthropic", amount: 18.00 },
  { id: 13, invoiceNumber: "INV-KNS-2026-002", supplier: "Keith Nicole", amount: 56.00 },
  { id: 15, invoiceNumber: "C267.19578.210512652", supplier: "CURO", amount: 10.77 },
  { id: 19, invoiceNumber: "C267.19578.210511032", supplier: "CURO", amount: 25.56 },
  { id: 22, invoiceNumber: "ESA 7695", supplier: "Easystart", amount: 95.59 },
  { id: 25, invoiceNumber: "INV-703935", supplier: "Kayne Joelle Pecha", amount: 70.00 },
  { id: 28, invoiceNumber: "C268.19578.210515556", supplier: "CURO", amount: 1.09 },
  { id: 36, invoiceNumber: "24-08-2026", supplier: "Paulo Tomas", amount: 260.00 },
  { id: 37, invoiceNumber: "INV-KNS-2026-005", supplier: "Keith Nicole", amount: 58.00 },
  { id: 86, invoiceNumber: "P2026098", supplier: "Tax and Law Spain", amount: 75.00 },
];

for (const c of checks) {
  const rows = await query(`
    SELECT invoice_id, invoice_number, reference, contact_name, total, currency_code, status, invoice_date
    FROM xero_invoice_balances
    WHERE invoice_type = 'ACCPAY' AND status NOT IN ('DELETED','VOIDED')
      AND (invoice_number = ? OR reference = ?)
  `, [c.invoiceNumber, c.invoiceNumber]);
  console.log(`\n#${c.id} (${c.supplier}, ${c.invoiceNumber}, ~${c.amount}):`);
  if (rows.length === 0) {
    console.log("  no exact invoice_number/reference match in xero_invoice_balances");
  } else {
    for (const r of rows) console.log(`  MATCH: ${r.contact_name} | ${r.invoice_number || r.reference} | ${r.currency_code}${r.total} | ${r.status} | ${String(r.invoice_date).slice(0,10)} | id=${r.invoice_id}`);
  }
}

console.log("\n=== Also checking contact/amount/date-window fuzzy matches for contractor invoices ===");
const fuzzy = [
  { id: 8, contact: "Kayne", amount: 70.00, date: "2026-08-10" },
  { id: 13, contact: "Sarsaba", amount: 56.00, date: "2026-08-03" },
  { id: 25, contact: "Kayne", amount: 70.00, date: "2026-08-17" },
  { id: 36, contact: "Tomas", amount: 260.00, date: "2026-08-24" },
  { id: 37, contact: "Sarsaba", amount: 58.00, date: "2026-08-24" },
];
for (const f of fuzzy) {
  const rows = await query(`
    SELECT invoice_id, invoice_number, contact_name, total, currency_code, status, invoice_date
    FROM xero_invoice_balances
    WHERE invoice_type='ACCPAY' AND status NOT IN ('DELETED','VOIDED')
      AND LOWER(contact_name) LIKE ? AND ABS(DATEDIFF(invoice_date, ?)) <= 10
  `, [`%${f.contact.toLowerCase()}%`, f.date]);
  console.log(`\n#${f.id} fuzzy (${f.contact} near ${f.date}):`);
  for (const r of rows) console.log(`  ${r.contact_name} | ${r.invoice_number} | ${r.currency_code}${r.total} | ${r.status} | ${String(r.invoice_date).slice(0,10)}`);
  if (rows.length === 0) console.log("  none");
}

await closePool();
