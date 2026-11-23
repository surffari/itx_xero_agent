#!/usr/bin/env node
// Read-only: for every missing-document bank line, look for a DRAFT / SUBMITTED / AUTHORISED (awaiting payment)
// ACCPAY bill in Xero by amount (currency-aware) within +/-60 days, regardless of supplier-name spelling.
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { config } from "../src/config.js";

const t = config.XERO_TENANT_ID;
const D = (x) => new Date(x);
const ymd = (x) => D(x).toISOString().slice(0, 10);

const rows = await query(
  `SELECT id, DATE(transaction_date) dt, amount, currency cur, COALESCE(payee,contact_name,description) who
   FROM bank_spend_orphans WHERE tenant_id=? AND status IN ('flagged','chasing') ORDER BY transaction_date`,
  [t]
);
const bills = await query(
  `SELECT invoice_number, contact_name, total, amount_due, currency_code cur, status, invoice_date
   FROM xero_invoice_balances
   WHERE tenant_id=? AND invoice_type='ACCPAY' AND status IN ('DRAFT','SUBMITTED','AUTHORISED')`,
  [t]
);
console.log("open bills (draft/submitted/authorised):", bills.length, "| queue lines:", rows.length);

const skip = (r) => /payment from .*return/i.test(String(r.who)) || /RE-1008|RE-1009|RE-1010/.test(String(r.who));
const key = (w) => String(w).toLowerCase().replace(/^ccv\*/, "").replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/)[0];

let found = 0;
for (const r of rows.filter((x) => !skip(x))) {
  const amt = Math.abs(Number(r.amount));
  const k = key(r.who);
  const near = bills.filter((b) => Math.abs((D(b.invoice_date) - D(r.dt)) / 864e5) <= 60);
  const byAmount = near.filter((b) => {
    const tot = Number(b.total);
    if (b.cur === r.cur) return Math.abs(tot - amt) < 0.02;
    return tot > 0 && amt / tot > 0.8 && amt / tot < 0.97;
  });
  const bySupplier = k.length >= 4 ? near.filter((b) => String(b.contact_name).toLowerCase().includes(k)) : [];
  const hits = [...new Map([...byAmount, ...bySupplier].map((b) => [b.invoice_number + b.contact_name + b.invoice_date, b])).values()];
  if (!hits.length) continue;
  found++;
  console.log(`\n${ymd(r.dt)} ${r.cur} ${amt.toFixed(2)} ${String(r.who).slice(0, 30)}`);
  hits.slice(0, 4).forEach((b) =>
    console.log(`   -> ${b.status} ${ymd(b.invoice_date)} ${(b.invoice_number || "-").padEnd(14)} ${String(b.contact_name).slice(0, 26).padEnd(26)} ${b.cur} ${Number(b.total).toFixed(2)} due ${Number(b.amount_due).toFixed(2)}${byAmount.includes(b) ? "  [amount match]" : "  [same supplier]"}`)
  );
}
console.log("\nlines with at least one open-bill candidate:", found);
await closePool();
process.exit(0);
