#!/usr/bin/env node
// Read-only: for each missing-document bank line, look for a candidate document by supplier keyword in the
// mailbox_invoice_files table (filename/subject/sender/extracted supplier) and in the 5 Nextcloud status folders.
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { config } from "../src/config.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";

const t = config.XERO_TENANT_ID;
const D = (x) => new Date(x);
const ymd = (x) => (x ? D(x).toISOString().slice(0, 10) : "-");

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
  if (/RE-1008|RE-1009|RE-1010/.test(w)) return true;
  if (/shipstation/i.test(w) && a === 9.9) return true;
  if (/cloudways/i.test(w) && a === 63.1) return true;
  if (/cloudflare/i.test(w) && a === 22.32) return true;
  if (/^brevo$/i.test(w) && a === 55) return true;
  if (/canva/i.test(w) && a === 27) return true;
  if (/cloudways/i.test(w) && (dt === "2026-08-01" || dt === "2026-09-01")) return true;
  return false;
};
const refund = (r) => /payment from .*return/i.test(String(r.who));
const miss = rows.filter((r) => !covered(r) && !refund(r));

const KEYS = {
  "TagadaPay": ["tagada"], "Anthropic Claude": ["anthropic", "claude"], "Finnair": ["finnair"], "KVK": ["kvk", "kamer van koophandel"],
  "OpenAI ChatGPT": ["openai", "chatgpt"], "DirectLing Trade UG (RE-1004 / RE-1007)": ["re-1004", "re-1007", "re1004", "re1007"],
  "Amazon": ["amazon"], "Joker.com": ["joker"], "Atlassian": ["atlassian"], "ShipStation": ["shipstation"], "NS": ["ns.nl", "nederlandse spoorwegen", "ns reis", "ns-"],
  "Deepseerwea": ["deepseerwea", "deepseek"], "eBay": ["ebay"], "Alibaba": ["alibaba"], "van Gogh Hotel Bv": ["gogh"], "Upwork": ["upwork"],
  "NordVPN": ["nordvpn", "nord"], "Vof Visser De Roo": ["visser"], "Xero": ["xero (nz)", "xero limited", "invoice from xero", "xero invoice"],
  "MXroute": ["mxroute"], "Blushing": ["blushing"], "Uber": ["uber"], "Ventraip Australia": ["ventraip"], "Smoke Shop": ["smoke"],
  "Finavia": ["finavia"], "Stamps.com": ["stamps"],
};

const mailbox = await query(
  `SELECT id, attachment_filename f, subject, from_address, extracted_supplier, received_at, bills_status
   FROM mailbox_invoice_files`, []
);
const nc = new NextcloudWebDavClient();
const folders = ["📥 01 - Incoming", "⚠️ 02 - Needs Review", "✅ 03 - Ready for Xero", "📤 04 - Uploaded to Xero", "🚨 05 - Exceptions"];
const ncFiles = [];
for (const f of folders) for (const n of await nc.listFolder(f)) ncFiles.push({ folder: f, name: n });
console.log(`mailbox docs: ${mailbox.length} | nextcloud files: ${ncFiles.length}`);

const groups = {};
miss.forEach((r) => (groups[norm(r.who)] ??= []).push(r));

const nothing = [];
const something = [];
for (const [s, arr] of Object.entries(groups)) {
  const keys = KEYS[s] ?? [s.toLowerCase().split(/\s+/)[0]];
  const hit = (txt) => keys.some((k) => String(txt ?? "").toLowerCase().includes(k));
  const mb = mailbox.filter((m) => hit(`${m.f} ${m.subject} ${m.from_address} ${m.extracted_supplier}`));
  const nf = ncFiles.filter((x) => hit(x.name));
  const total = arr.reduce((a, r) => a + Math.abs(Number(r.amount)), 0);
  const cur = arr[0].cur;
  (mb.length || nf.length ? something : nothing).push({ s, n: arr.length, total: total.toFixed(2), cur, mb, nf });
}

console.log("\n=== NOTHING in mailbox or Nextcloud (must be requested from supplier) ===");
nothing.sort((a, b) => b.n - a.n).forEach((x) => console.log(`  ${x.s.padEnd(42)} ${String(x.n).padStart(2)} lines  ${x.cur} ${x.total}`));
console.log("\n=== Some document exists for the supplier (check whether it covers these lines) ===");
something.sort((a, b) => b.n - a.n).forEach((x) => {
  console.log(`  ${x.s} -- ${x.n} lines, ${x.cur} ${x.total}`);
  x.mb.slice(0, 6).forEach((m) => console.log(`      mailbox #${m.id} ${ymd(m.received_at)} ${m.bills_status} ${String(m.f).slice(0, 60)}`));
  x.nf.slice(0, 3).forEach((n) => console.log(`      nextcloud ${n.folder} / ${n.name.slice(0, 60)}`));
});
await closePool();
process.exit(0);
