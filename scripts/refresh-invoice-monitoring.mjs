#!/usr/bin/env node
// Bills Management: recomputes the Wise EUR line-by-line reconciliation behind the
// "Invoice Monitoring Report" Claude Artifact (https://claude.ai/artifact/BXZtqLEY3QSsrXwjpMXq5p).
// This script only COMPUTES the rows and writes them to JSON -- it cannot write to the
// artifact's database itself (that's a Claude-tool capability, ArtifactData, not a public
// API). The scheduled task that runs this script also reads the JSON output and pushes it
// via ArtifactData in the same run. See PLAN.md decision on the 2026-09-25 automation.
//
// Matching methodology mirrors build-monthly-expenses-sheet.mjs's missing-invoice check
// (itself built from Kayne's 2026-09-24 standing rule: check Xero DRAFT/awaiting
// payment/PAID, mailbox, and Nextcloud-folder state via mailbox_invoice_files before ever
// marking a bank line "Missing"). This script additionally does 1:1 GREEDY matching
// between bank lines and Xero bills so each bill is claimed by at most one bank line --
// the original ungated version double-matched two different ClickUp charges to one bill.
import "dotenv/config";
import { query, execute, closePool } from "../src/db/mysql.js";
import { syncTransactions } from "../src/xero/sync.js";
import { syncWiseActivities } from "../src/wise/sync-activities.js";
import { detectStatementOrphans } from "../src/reconcile/statement-orphans.js";
import { isoDateDaysAgo, todayIsoDate } from "../src/lib/dates.js";
import { config } from "../src/config.js";
import { writeFile } from "node:fs/promises";

const OUTPUT_PATH = process.env.INVOICE_MONITORING_OUTPUT || "/tmp/invoice-monitoring-rows.json";
const LOOKBACK_DAYS = 200;
const start = isoDateDaysAgo(LOOKBACK_DAYS);
const end = todayIsoDate();

console.log(`=== Refreshing Invoice Monitoring rows (${start} -> ${end}) ===`);
await syncTransactions(start, end);
if (process.env.WISE_API_TOKEN) {
  try {
    await syncWiseActivities(start, end);
  } catch (err) {
    console.warn(`Wise activity sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
await detectStatementOrphans(config.XERO_TENANT_ID, null, { lookbackDays: LOOKBACK_DAYS });

// Debit card holders (kept in sync with src/reconcile/statement-orphans.ts CARD_MAP)
const CARD_MAP = {
  "7237": { name: "Jani Goran Saarinen", key: "jani" },
  "3826": { name: "Mari-Annina Oksala", key: "mari" },
  "3699": { name: "Mari-Annina Oksala", key: "mari" },
};
function detectCardholder(reference, notes) {
  const combined = [reference, notes].filter(Boolean).join(" ");
  if (!combined) return null;
  const last4Match = combined.match(/Card last 4 digits:\s*([0-9*]+)/i);
  if (last4Match) {
    const maskedTail = last4Match[1].match(/(\d{4})$/);
    const last4 = maskedTail?.[1] ?? last4Match[1].replace(/\D/g, "").slice(-4);
    const profile = CARD_MAP[last4] ?? (combined.toLowerCase().includes("revolut card payment")
      ? { key: "mari" } : undefined);
    return profile?.key ?? null;
  }
  for (const [, profile] of Object.entries(CARD_MAP)) {
    if (combined.toLowerCase().includes(profile.name.toLowerCase())) return profile.key;
  }
  return null;
}

const ALIASES = { claude: ["anthropic"], chatgpt: ["openai"] };
const STOPWORDS = new Set(["subscription", "starter", "design", "publishing", "paypal", "gopure"]);
function tokens(text) {
  const base = (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  const expanded = new Set(base);
  for (const t of base) if (ALIASES[t]) ALIASES[t].forEach((a) => expanded.add(a));
  return [...expanded];
}
function daysApart(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

const lines = await query(`
  SELECT sl.id, sl.statement_line_id, sl.transaction_date, sl.amount,
         sl.bank_account_currency AS currency, sl.payee, sl.reference, sl.notes
  FROM xero_bank_statement_lines sl
  WHERE sl.tenant_id = ? AND sl.bank_account_name = 'Wise EUR' AND sl.type = 'Debit'
    AND sl.is_deleted = 0 AND sl.is_duplicate = 0
    AND sl.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
  ORDER BY sl.transaction_date DESC
`, [config.XERO_TENANT_ID, LOOKBACK_DAYS]);

const bills = await query(`
  SELECT contact_name, invoice_date, total, currency_code, status, invoice_number, reference
  FROM xero_invoice_balances
  WHERE invoice_type = 'ACCPAY' AND status NOT IN ('DELETED', 'VOIDED')
    AND invoice_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
`, [LOOKBACK_DAYS + 20]);

const mailbox = await query(`
  SELECT id, attachment_filename, extracted_supplier, extracted_amount, extracted_currency,
         extracted_date, bills_status
  FROM mailbox_invoice_files
`);

// --- 1:1 greedy match: score candidate (line, bill) pairs, assign closest-date first,
// never let one bill be claimed by two lines (the bug this replaced). ---
const candidates = [];
for (const line of lines) {
  const lineTokens = tokens(line.payee);
  for (const bill of bills) {
    if (!lineTokens.some((t) => (bill.contact_name ?? "").toLowerCase().includes(t))) continue;
    const dd = daysApart(bill.invoice_date, line.transaction_date);
    if (dd > 20) continue;
    candidates.push({ line, bill, dd });
  }
}
candidates.sort((a, b) => a.dd - b.dd);
const usedLines = new Set();
const usedBills = new Set();
const matchByLineId = new Map();
for (const c of candidates) {
  if (usedLines.has(c.line.id) || usedBills.has(c.bill)) continue;
  usedLines.add(c.line.id);
  usedBills.add(c.bill);
  matchByLineId.set(c.line.id, c.bill);
}

function isoDate(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

const rows = [];
let missingCount = 0;
for (const line of lines) {
  const date = isoDate(line.transaction_date);
  const supplier = line.payee ?? "(no payee)";
  const cardholder = detectCardholder(line.reference, line.notes) ?? "";
  const bank = `${line.currency}${Number(line.amount).toFixed(2)}`;
  const bill = matchByLineId.get(line.id);

  let xero = "";
  let remark;
  if (bill) {
    xero = `${bill.status}, ${bill.currency_code}${Number(bill.total).toFixed(2)}`;
    if (bill.currency_code !== line.currency) {
      remark = "Match (FX)";
    } else {
      const diff = Math.abs(Number(bill.total) - Number(line.amount));
      const tol = Math.max(0.05, Number(line.amount) * 0.02);
      remark = diff <= tol ? "Match" : `Variance (€${diff.toFixed(2)})`;
    }
  } else {
    // Wider verification before calling it Missing -- Kayne's 2026-09-24 standing rule:
    // check Xero in every status + mailbox in every folder before flagging.
    const lineTokens = tokens(line.payee);
    const wideBill = bills.find((b) => {
      const name = (b.contact_name ?? "").toLowerCase();
      if (!lineTokens.some((t) => name.includes(t))) return false;
      if (daysApart(b.invoice_date, line.transaction_date) > 20) return false;
      if (b.currency_code === line.currency) {
        const tol = Math.max(1.0, Number(line.amount) * 0.1);
        return Math.abs(Number(b.total) - Number(line.amount)) <= tol;
      }
      return true;
    });
    const mailboxMatch = !wideBill && mailbox.find((m) => {
      const supplierText = (m.extracted_supplier ?? "").toLowerCase();
      const filename = (m.attachment_filename ?? "").toLowerCase();
      if (!lineTokens.some((t) => supplierText.includes(t) || filename.includes(t))) return false;
      if (!m.extracted_date) return true;
      if (daysApart(m.extracted_date, line.transaction_date) > 20) return false;
      if (m.extracted_currency === line.currency && m.extracted_amount != null) {
        const tol = Math.max(1.0, Number(line.amount) * 0.1);
        return Math.abs(Number(m.extracted_amount) - Number(line.amount)) <= tol;
      }
      return true;
    });

    if (wideBill) {
      xero = `${wideBill.status}, ${wideBill.currency_code}${Number(wideBill.total).toFixed(2)}`;
      remark = wideBill.currency_code === line.currency ? "Match" : "Match (FX)";
    } else if (mailboxMatch) {
      remark = `In review (mailbox #${mailboxMatch.id}, ${mailboxMatch.bills_status})`;
    } else {
      remark = "Missing";
      missingCount++;
    }
  }

  rows.push({ doc_id: line.statement_line_id, date, supplier, xero, bank, remark, cardholder });
}

await writeFile(OUTPUT_PATH, JSON.stringify(rows, null, 2));
console.log(`Wrote ${rows.length} rows -> ${OUTPUT_PATH}`);
console.log(`Missing: ${missingCount}, Matched: ${rows.length - missingCount}`);

await closePool();
