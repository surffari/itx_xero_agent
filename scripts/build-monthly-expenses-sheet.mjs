#!/usr/bin/env node
// Bills Management: builds "Monthly Supplier Expenses.xlsx" in the Nextcloud /Xero-Bills
// root (separate file from "Documents Review Log.xlsx" -- see D32/D21). Meant to run on
// a schedule (weekly), so every figure is pulled fresh: (1) incremental Xero sync into
// the local xero_invoice_balances warehouse (read-only), (2) a live GROUP BY query over
// that table, org-wide -- not just documents that passed through the mailbox pipeline.
// The mailbox pipeline is only ONE of several ways bills reach Xero (bank-feed spend,
// direct manual entry, etc.), so anything filtered to mailbox_invoice_files misses real
// suppliers -- this was exactly the gap Kayne caught with Monta Enschede (2026-09-24).
//
// Categorisation: contractor names are a small hardcoded list (individuals doing
// weekly-ish work -- genuinely a different kind of expense, not reliably inferable from
// amounts alone). Everything else is data-driven: >=3 bills with low amount variance
// (stddev/avg < 15%) -> Fixed Subscription; otherwise -> Variable/Project-based. A
// "Watch List" sheet flags (a) suppliers who WERE recurring (>=2 bills) but have gone
// quiet for 60+ days -- the Monta pattern -- and (b) a small known-duplicate-contact
// list, so Kayne can see both at a glance without re-deriving them each time.
import "dotenv/config";
import ExcelJS from "exceljs";
import { query, execute, closePool } from "../src/db/mysql.js";
import { syncTransactions } from "../src/xero/sync.js";
import { syncWiseActivities } from "../src/wise/sync-activities.js";
import { detectStatementOrphans } from "../src/reconcile/statement-orphans.js";
import { isoDateDaysAgo, todayIsoDate } from "../src/lib/dates.js";
import { config } from "../src/config.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { writeFile, mkdir } from "node:fs/promises";

const nc = new NextcloudWebDavClient();
const WORKBOOK_PATH = "Monthly Supplier Expenses.xlsx";

// Individuals doing recurring weekly-ish contract work -- a real business fact, not
// something amount-variance alone can reliably tell apart from a subscription.
const KNOWN_CONTRACTORS = new Set([
  "Paulo Tomas", "Paulo Thomas",
  "Keith Nicole V. Sarsaba",
  "Kayne Joelle Pecha",
  "Darlene L. Aberin", "Darlene Aberin",
]);

// Known duplicate/near-duplicate Xero contacts found by cross-checking bill history
// this session and in the 2026-09-24 uploads. Extend this list by hand when another one
// turns up -- it is not auto-detected.
const KNOWN_DUPLICATE_CONTACTS = [
  { names: "Paulo Tomas / Paulo Thomas", note: "Only \"Paulo Tomas\" has ever been billed; \"Paulo Thomas\" looks like an unused duplicate contact." },
  { names: "Kuura Solutions LLC / Kuurasolutions.com", note: "Only \"Kuura Solutions LLC\" has ever been billed." },
  { names: "DigitalOcean LLC / Digitalocean EU B.V.", note: "Only \"DigitalOcean LLC\" has ever been billed." },
  { names: "Xero (NZ) Limited / Xero (NZ) Ltd", note: "\"Ltd\" variant only used Jan-Mar 2025; \"Limited\" used since — looks like a renamed/re-created contact, not a live duplicate." },
  { names: "Canva Design and Publishing / Canva Pro", note: "Two contacts for the same €27/month subscription — check which one is meant to be used going forward." },
  { names: "Atlassian Pty Ltd / Atlassian", note: "Only \"Atlassian Pty Ltd\" has ever been billed." },
  { names: "Anthropic / Anthropic, PBC", note: "Only \"Anthropic, PBC\" has ever been billed." },
  { names: "FrontApp variants (Front, Front Starter-12/13, FrontApp, Inc.)", note: "Only \"FrontApp, Inc.\" has ever been billed." },
  { names: "Tradethno variants (4 spellings)", note: "Only \"Tradethno pte. ltd.\" has ever been billed." },
];

console.log("=== Refreshing local Xero warehouse (incremental, read-only) ===");
const start = isoDateDaysAgo(180);
const end = todayIsoDate();
await syncTransactions(start, end);
console.log(`Synced ${start} -> ${end}\n`);

// --- Missing invoices: bank statement vs Xero (draft/awaiting payment/paid) vs mailbox ---
// Kayne's explicit instruction (2026-09-24): "before flagging missing invoices do check
// awaiting payments in xero, paid, draft, mail box, xero folders all folders then if you
// havent seen its the time you put a mark missing invoices". A raw is-this-bank-line-
// reconciled-in-Xero check is too narrow -- it misses bills that exist as DRAFT, or as a
// mailbox document never yet turned into a bill, or where the Wise EUR debit is a
// currency-converted amount of a bill booked in USD. This block does the fuller check
// before anything is called "missing": refresh the raw Wise feed, run the existing
// orphan detector, then re-verify every still-flagged line against Xero bills in EVERY
// status (not just reconciled) and against mailbox_invoice_files in every folder, with a
// small alias map for payee names that don't literally match the Xero contact name
// (e.g. "Claude" on the statement vs "Anthropic, PBC" in Xero) and an amount tolerance
// for same-currency comparisons. Anything that turns out to already exist gets its
// bank_spend_orphans row corrected to 'coded' so it isn't re-flagged next week either.
if (process.env.WISE_API_TOKEN) {
  try {
    await syncWiseActivities(start, end);
  } catch (err) {
    console.warn(`Wise activity sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
await detectStatementOrphans(config.XERO_TENANT_ID, null, { lookbackDays: 200 });

const MISSING_ALIASES = { claude: ["anthropic"], chatgpt: ["openai"] };
function missingInvoiceTokens(payee) {
  const base = (payee ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 4 && !["subscription", "starter", "design", "publishing", "paypal", "gopure"].includes(t));
  const expanded = new Set(base);
  for (const t of base) if (MISSING_ALIASES[t]) MISSING_ALIASES[t].forEach((a) => expanded.add(a));
  return [...expanded];
}
function daysApart(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

// Scoped to Wise EUR only for now -- that's the account Kayne asked about and the one
// this verification methodology was manually spot-checked against (2026-09-24). Revolut
// EUR/GBP/USD and Wise USD show far larger unverified totals (mostly legitimate
// inventory/COGS payments, not missing supplier invoices) and need the same manual
// spot-check before they're trustworthy here -- extend WISE_EUR_ONLY when that's done.
const WISE_EUR_ONLY = true;
const candidateOrphans = await query(`
  SELECT bso.id, bso.transaction_date, bso.amount, bso.currency, bso.payee, bso.cardholder,
         sl.bank_account_name
  FROM bank_spend_orphans bso
  JOIN xero_bank_statement_lines sl ON sl.tenant_id = bso.tenant_id AND sl.statement_line_id = bso.xero_bank_tx_id
  WHERE bso.source_type = 'STATEMENT_LINE' AND bso.status IN ('flagged', 'chasing')
    ${WISE_EUR_ONLY ? "AND sl.bank_account_name = 'Wise EUR'" : ""}
  ORDER BY bso.transaction_date DESC
`);
const allBills = await query(`SELECT contact_name, invoice_date, total, currency_code, status, invoice_number, reference
  FROM xero_invoice_balances WHERE invoice_type = 'ACCPAY' AND status NOT IN ('DELETED', 'VOIDED')`);
const allMailbox = await query(`SELECT id, attachment_filename, extracted_supplier, extracted_amount, extracted_currency, extracted_date, bills_status
  FROM mailbox_invoice_files`);

const missingInvoices = [];
for (const o of candidateOrphans) {
  const tokens = missingInvoiceTokens(o.payee);

  const billMatch = allBills.find((b) => {
    const name = (b.contact_name ?? "").toLowerCase();
    if (!tokens.some((t) => name.includes(t))) return false;
    if (daysApart(b.invoice_date, o.transaction_date) > 20) return false;
    if (b.currency_code === o.currency) {
      const tol = Math.max(1.0, Number(o.amount) * 0.1);
      return Math.abs(Number(b.total) - Number(o.amount)) <= tol;
    }
    return true; // cross-currency: date + contact match is the signal (FX conversion)
  });

  const mailboxMatch = !billMatch && allMailbox.find((m) => {
    const supplier = (m.extracted_supplier ?? "").toLowerCase();
    const filename = (m.attachment_filename ?? "").toLowerCase();
    if (!tokens.some((t) => supplier.includes(t) || filename.includes(t))) return false;
    if (!m.extracted_date) return true;
    if (daysApart(m.extracted_date, o.transaction_date) > 20) return false;
    if (m.extracted_currency === o.currency && m.extracted_amount != null) {
      const tol = Math.max(1.0, Number(o.amount) * 0.1);
      return Math.abs(Number(m.extracted_amount) - Number(o.amount)) <= tol;
    }
    return true;
  });

  if (billMatch || mailboxMatch) {
    const note = billMatch
      ? `Verified ${todayIsoDate()}: matches Xero bill ${billMatch.contact_name} ${billMatch.currency_code}${billMatch.total} (${billMatch.status}, ref ${billMatch.invoice_number || billMatch.reference || "n/a"})`
      : `Verified ${todayIsoDate()}: matches mailbox doc #${mailboxMatch.id} (${mailboxMatch.bills_status})`;
    await execute(`UPDATE bank_spend_orphans SET status='coded', notes=? WHERE id=?`, [note.slice(0, 490), o.id]);
  } else {
    missingInvoices.push(o);
  }
}
console.log(`Missing-invoice check: ${candidateOrphans.length} flagged, ${candidateOrphans.length - missingInvoices.length} verified as already existing, ${missingInvoices.length} genuinely missing\n`);

const rows = await query(`
  SELECT contact_name,
         COUNT(*) AS n,
         MIN(invoice_date) AS first_date,
         MAX(invoice_date) AS last_date,
         GROUP_CONCAT(DISTINCT currency_code) AS currencies,
         MIN(total) AS min_total,
         MAX(total) AS max_total,
         AVG(total) AS avg_total,
         STDDEV_POP(total) AS stddev_total
  FROM xero_invoice_balances
  WHERE invoice_type = 'ACCPAY' AND status NOT IN ('DELETED', 'VOIDED') AND contact_name IS NOT NULL
  GROUP BY contact_name
  HAVING n >= 1
  ORDER BY last_date DESC
`);

const todayMs = Date.now();
const daysSince = (d) => Math.floor((todayMs - new Date(d).getTime()) / 86400000);

const fixed = [];
const contractors = [];
const variable = [];
const goneQuiet = [];

for (const r of rows) {
  const lastGap = daysSince(r.last_date);
  const variancePct = r.avg_total > 0 ? (r.stddev_total / r.avg_total) * 100 : 0;
  const isRecurring = r.n >= 2;

  if (isRecurring && lastGap > 60) {
    goneQuiet.push({ ...r, lastGap });
    continue; // don't also list it as active in the main sheets
  }
  if (lastGap > 120) continue; // stale, not currently active -- skip from main sheets entirely

  if (KNOWN_CONTRACTORS.has(r.contact_name)) {
    contractors.push(r);
  } else if (r.n >= 3 && variancePct < 15) {
    fixed.push({ ...r, variancePct });
  } else {
    variable.push({ ...r, variancePct });
  }
}

const wb = new ExcelJS.Workbook();
wb.creator = "Bills Management (xero-agent)";
wb.created = new Date();

function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };
    cell.alignment = { vertical: "middle" };
  });
}
function autoWidth(sheet, widths) {
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
}
function fmtDate(d) { return new Date(d).toISOString().slice(0, 10); }
function fmtAmt(v) { return Math.round(Number(v) * 100) / 100; }

// --- Sheet 1: Fixed subscriptions ---
const s1 = wb.addWorksheet("Fixed Subscriptions");
s1.addRow(["Monthly Supplier Expenses — Fixed Subscriptions"]).font = { bold: true, size: 14 };
s1.addRow([`Rebuilt ${todayIsoDate()} — live from Xero (xero_invoice_balances, org-wide, read-only)`]).font = { italic: true, size: 9, color: { argb: "FF666666" } };
s1.addRow([]);
const h1 = s1.addRow(["Supplier", "Typical amount", "Currency", "# bills (180d)", "First seen", "Last billed", "Variance"]);
styleHeader(h1);
for (const r of fixed.sort((a, b) => b.avg_total - a.avg_total)) {
  s1.addRow([r.contact_name, fmtAmt(r.avg_total), r.currencies, r.n, fmtDate(r.first_date), fmtDate(r.last_date), `${r.variancePct.toFixed(0)}%`]);
}
autoWidth(s1, [34, 14, 10, 14, 14, 14, 10]);
s1.views = [{ state: "frozen", ySplit: 4 }];

// --- Sheet 2: Weekly contractors ---
const s2 = wb.addWorksheet("Weekly Contractors");
s2.addRow(["Monthly Supplier Expenses — Weekly Contractors"]).font = { bold: true, size: 14 };
s2.addRow([]);
const h2 = s2.addRow(["Supplier", "Amount range", "Currency", "# bills (180d)", "Last billed", "~Monthly (x4.33)"]);
styleHeader(h2);
for (const r of contractors.sort((a, b) => b.avg_total - a.avg_total)) {
  const approxMonthly = fmtAmt(r.avg_total * 4.33);
  const range = r.min_total === r.max_total ? fmtAmt(r.min_total) : `${fmtAmt(r.min_total)}-${fmtAmt(r.max_total)}`;
  s2.addRow([r.contact_name, range, r.currencies, r.n, fmtDate(r.last_date), approxMonthly]);
}
autoWidth(s2, [34, 16, 10, 14, 14, 16]);
s2.views = [{ state: "frozen", ySplit: 3 }];

// --- Sheet 3: Variable / project-based ---
const s3 = wb.addWorksheet("Variable Suppliers");
s3.addRow(["Monthly Supplier Expenses — Variable / Project-based (recurring, not fixed)"]).font = { bold: true, size: 14 };
s3.addRow([]);
const h3 = s3.addRow(["Supplier", "Amount range", "Currency", "# bills (180d)", "Last billed", "Variance"]);
styleHeader(h3);
for (const r of variable.sort((a, b) => b.avg_total - a.avg_total)) {
  const range = r.min_total === r.max_total ? fmtAmt(r.min_total) : `${fmtAmt(r.min_total)}-${fmtAmt(r.max_total)}`;
  s3.addRow([r.contact_name, range, r.currencies, r.n, fmtDate(r.last_date), `${r.variancePct.toFixed(0)}%`]);
}
autoWidth(s3, [34, 20, 10, 14, 14, 10]);
s3.views = [{ state: "frozen", ySplit: 3 }];

// --- Sheet 4: Watch list ---
const s4 = wb.addWorksheet("Watch List");
s4.addRow(["Watch List — recurring suppliers gone quiet, and known duplicate Xero contacts"]).font = { bold: true, size: 14 };
s4.addRow([]);
s4.addRow(["Recurring suppliers with no bill in 60+ days"]).font = { bold: true, size: 12 };
const h4a = s4.addRow(["Supplier", "Was averaging", "Currency", "Last billed", "Days since"]);
styleHeader(h4a);
for (const r of goneQuiet.sort((a, b) => b.lastGap - a.lastGap)) {
  s4.addRow([r.contact_name, fmtAmt(r.avg_total), r.currencies, fmtDate(r.last_date), r.lastGap]);
}
s4.addRow([]);
s4.addRow(["Known duplicate / near-duplicate Xero contacts (manually curated, extend by hand)"]).font = { bold: true, size: 12 };
const h4b = s4.addRow(["Contact names", "Note"]);
styleHeader(h4b);
for (const d of KNOWN_DUPLICATE_CONTACTS) {
  s4.addRow([d.names, d.note]);
}
autoWidth(s4, [42, 16, 10, 14, 12]);
s4.getColumn(2).width = 45; // note column in the duplicates table is wider than "was averaging"

// --- Sheet 5: Missing invoices ---
const s5 = wb.addWorksheet("Missing Invoices");
s5.addRow(["Missing Invoices — real bank spend with no Xero bill (any status) or mailbox document found"]).font = { bold: true, size: 14 };
s5.addRow(["Checked before flagging: Xero DRAFT/AUTHORISED(awaiting payment)/PAID bills, and every mailbox_invoice_files record across every Nextcloud folder."]).font = { italic: true, size: 9, color: { argb: "FF666666" } };
s5.addRow([]);
const h5 = s5.addRow(["Date", "Payee (bank statement)", "Amount", "Currency", "Bank account", "Cardholder"]);
styleHeader(h5);
let missingTotal = 0;
for (const o of missingInvoices.sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date))) {
  missingTotal += Number(o.amount);
  s5.addRow([fmtDate(o.transaction_date), o.payee, fmtAmt(o.amount), o.currency, o.bank_account_name, o.cardholder ?? ""]);
}
s5.addRow([]);
s5.addRow(["Total missing", "", fmtAmt(missingTotal)]).font = { bold: true };
autoWidth(s5, [12, 32, 12, 10, 16, 12]);
s5.views = [{ state: "frozen", ySplit: 4 }];

const buffer = await wb.xlsx.writeBuffer();

await mkdir("/opt/projects/gopure/bills_management/backups", { recursive: true });
try {
  const existing = await nc.downloadFile(WORKBOOK_PATH);
  const backupPath = `/opt/projects/gopure/bills_management/backups/monthly_expenses_before_overwrite_${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`;
  await writeFile(backupPath, existing);
  console.log(`Existing file backed up -> ${backupPath}`);
} catch {
  console.log("No existing file at that path — first publish.");
}

await nc.uploadFile(
  WORKBOOK_PATH,
  Buffer.from(buffer),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
);
console.log(`Uploaded -> /Xero-Bills/${WORKBOOK_PATH}`);
console.log(`Fixed: ${fixed.length}, Contractors: ${contractors.length}, Variable: ${variable.length}, Gone quiet: ${goneQuiet.length}, Missing invoices: ${missingInvoices.length} (€${missingTotal.toFixed(2)})`);

await closePool();
