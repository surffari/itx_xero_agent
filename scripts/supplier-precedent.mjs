#!/usr/bin/env node
// Read-only: coding precedent (account/tax/contact) for given supplier name fragments. Usage: node ... supplier-precedent.mjs pecha tomas tradethno kuura
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { config } from "../src/config.js";

const t = config.XERO_TENANT_ID;
const ymd = (x) => (x ? new Date(x).toISOString().slice(0, 10) : "-");
for (const frag of process.argv.slice(2)) {
  const like = `%${frag.toLowerCase()}%`;
  console.log(`\n######## ${frag}`);
  const contacts = await query(`SELECT contact_id, name, status FROM xero_contacts WHERE tenant_id=? AND LOWER(name) LIKE ?`, [t, like]);
  contacts.forEach((c) => console.log(`  contact ${c.contact_id} ${c.name} [${c.status}]`));
  const lines = await query(
    `SELECT contact_id, contact_name, invoice_number, DATE(transaction_date) dt, account_code, account_name, tax_type, currency_code, gross_amount, status, description
     FROM finance_transaction_lines
     WHERE tenant_id=? AND source_type='BILL' AND status NOT IN ('DELETED','VOIDED') AND LOWER(contact_name) LIKE ?
     ORDER BY transaction_date DESC LIMIT 8`,
    [t, like]
  );
  lines.forEach((l) =>
    console.log(`  ${ymd(l.dt)} ${String(l.invoice_number ?? "-").padEnd(16)} ${l.currency_code} ${Number(l.gross_amount).toFixed(2).padStart(9)} acct ${l.account_code} ${String(l.account_name).slice(0, 26).padEnd(26)} ${String(l.tax_type).padEnd(8)} ${l.status} [${String(l.contact_id).slice(0, 8)}] ${String(l.description ?? "").slice(0, 40)}`)
  );
}
await closePool();
process.exit(0);
