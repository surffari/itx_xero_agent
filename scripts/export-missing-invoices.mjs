#!/usr/bin/env node
// Read-only: export the open missing-document bank lines (minus lines covered by bills/drafts and customer refunds) to CSV.
import "dotenv/config";
import fs from "node:fs";
import { query, closePool } from "../src/db/mysql.js";
import { config } from "../src/config.js";

const t = config.XERO_TENANT_ID;
const ymd = (x) => new Date(x).toISOString().slice(0, 10);
const rows = await query(
  `SELECT id, DATE(transaction_date) dt, amount, currency cur, COALESCE(payee,contact_name,description) who, cardholder
   FROM bank_spend_orphans WHERE tenant_id=? AND status IN ('flagged','chasing') ORDER BY transaction_date`,
  [t]
);

const norm = (w) => {
  w = String(w);
  if (/RE-100[47]/.test(w)) return "DirectLing Trade UG (RE-1004 / RE-1007)";
  return w.replace(/^Ccv\*/i, "").replace(/ - PayPal| Subscription/gi, "").replace(/^Claude$/i, "Anthropic Claude")
    .replace(/Tagadapay Gopure/i, "TagadaPay").replace(/^Kvk\.nl$/i, "KVK").replace(/^OpenAI.*/i, "OpenAI ChatGPT").trim().slice(0, 40);
};
const covered = (r) => {
  const w = String(r.who), a = Math.abs(Number(r.amount)), dt = ymd(r.dt);
  if (/RE-1008|RE-1009|RE-1010/.test(w)) return "DirectLing bill paid in Xero";
  if (/shipstation/i.test(w) && a === 9.9) return "draft bill 16487339";
  if (/cloudways/i.test(w) && a === 63.1) return "draft bill 2440746";
  if (/cloudflare/i.test(w) && a === 22.32) return "draft bill IN-82103680";
  if (/^brevo$/i.test(w) && a === 55) return "Xero bill SIB-5890005";
  if (/canva/i.test(w) && a === 27) return "Xero bill 04946-18824445";
  if (/cloudways/i.test(w) && (dt === "2026-08-01" || dt === "2026-09-01")) return "DigitalOcean bill (verify)";
  return null;
};
const refund = (r) => /payment from .*return/i.test(String(r.who));

const miss = rows.filter((r) => !covered(r) && !refund(r));
const groups = {};
miss.forEach((r) => (groups[norm(r.who)] ??= []).push(r));
const order = Object.entries(groups).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

let csv = "supplier,date,currency,amount,cardholder,bank_description\n";
for (const [s, arr] of order) {
  for (const r of arr) {
    csv += `"${s}",${ymd(r.dt)},${r.cur},${Math.abs(Number(r.amount)).toFixed(2)},${r.cardholder || ""},"${String(r.who).replace(/"/g, "'")}"\n`;
  }
}
const out = "/opt/projects/gopure/bills_management/missing-invoices-20261006.csv";
fs.writeFileSync(out, csv);
console.log("wrote", out);
console.log("missing lines:", miss.length, "suppliers:", order.length, "| excluded covered:", rows.filter(covered).length, "refunds:", rows.filter(refund).length, "| queue total:", rows.length);
await closePool();
process.exit(0);
