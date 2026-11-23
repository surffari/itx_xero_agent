import { getPool } from "../db/mysql.js";
import { query } from "../db/mysql.js";
import { requireXeroConfig } from "../config.js";
import { WiseClient, type WiseActivity } from "./client.js";

// Wise business profile ID for Intactix B.V.
const WISE_PROFILE_ID = Number(process.env.WISE_PROFILE_ID ?? "36756352");

// Maps Wise account currency → Xero bank account UUID + name
const CURRENCY_TO_XERO: Record<string, { accountId: string; accountName: string }> = {
  EUR: { accountId: "90da793e-42be-480b-b6c6-d610fb60c9b4", accountName: "Wise EUR" },
  USD: { accountId: "0b8fbb1e-36b6-4813-a68b-3daae645e4b9", accountName: "Wise USD" },
  GBP: { accountId: "8fbef334-4f71-4e11-b369-305d67d72d3b", accountName: "Wise GBP" },
};

// Card last-4 digits — cardholder attribution from description
const CARD_HOLDER_PATTERNS: Array<{ pattern: RegExp; name: string; last4: string }> = [
  { pattern: /Mari-Annina/i, name: "Mari-Annina Oksala", last4: "3826" },
];
const JANI_LAST4 = "7237";

export interface WiseSyncResult {
  synced: number;
  skipped: number;
  reconciledCount: number;
  unreconciledCount: number;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
}

/**
 * Parse "45 EUR" or "2,458.19 EUR" → { amount, currency }.
 * Returns null for unparseable strings or credit markers (<positive>).
 */
function parseAmountString(s: string): { amount: number; currency: string } | null {
  if (!s || s.includes("<positive>")) return null;
  const m = s.trim().match(/^([\d,]+\.?\d*)\s+([A-Z]{3})$/);
  if (!m) return null;
  return { amount: parseFloat(m[1].replace(/,/g, "")), currency: m[2] };
}

/**
 * Determine the debit amount and currency for an activity.
 * For cross-currency card payments, the secondaryAmount is the EUR actually debited.
 * Returns null for credit activities.
 */
function parseDebit(
  activity: WiseActivity
): { amount: number; currency: string } | null {
  // Credits have <positive> in primaryAmount
  if (activity.primaryAmount.includes("<positive>")) return null;
  if (activity.status === "CANCELLED") return null;

  const primary = parseAmountString(activity.primaryAmount);
  if (!primary || primary.amount === 0) return null;

  // For cross-currency: secondaryAmount = the account-currency amount (what was actually debited)
  if (activity.secondaryAmount && activity.secondaryAmount.trim()) {
    const secondary = parseAmountString(activity.secondaryAmount);
    if (secondary && CURRENCY_TO_XERO[secondary.currency]) {
      return secondary;
    }
  }

  return primary;
}

function detectCardholder(
  activity: WiseActivity
): { cardholder: "jani" | "mari" | null; last4: string | null } {
  const combined = [activity.description, activity.title].join(" ");
  for (const { pattern, last4 } of CARD_HOLDER_PATTERNS) {
    if (pattern.test(combined)) return { cardholder: "mari", last4 };
  }
  // Card payments with no "Spent by Mari" annotation → primary cardholder = Jani
  if (activity.type === "CARD_PAYMENT") {
    return { cardholder: "jani", last4: JANI_LAST4 };
  }
  return { cardholder: null, last4: null };
}

interface XeroSpendTx {
  accountId: string;
  amount: number;
  date: string;
  reference: string | null;
}

/**
 * Batch-load all SPEND bank transactions for the date window from xero_raw_objects.
 * Returns a lookup function that checks if a given debit is already coded in Xero.
 * One DB round-trip for the whole sync instead of one per activity.
 */
async function loadXeroSpendIndex(
  fromDate: string,
  toDate: string
): Promise<(bankAccountId: string, amount: number, date: string, cardActivityId?: string) => boolean> {
  const rows = await query<any[]>(
    `SELECT
       JSON_UNQUOTE(JSON_EXTRACT(payload, '$.BankAccount.AccountID')) AS accountId,
       CAST(JSON_EXTRACT(payload, '$.Total') AS DECIMAL(18,4)) AS amount,
       DATE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.DateString'))) AS txDate,
       NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.Reference')), 'null') AS reference
     FROM xero_raw_objects
     WHERE object_type = 'BANKTRANSACTION'
       AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.Type')) = 'SPEND'
       AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.Status')) = 'AUTHORISED'
       AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.IsReconciled')) = 'true'
       AND DATE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.DateString')))
           BETWEEN DATE_SUB(?, INTERVAL 3 DAY) AND DATE_ADD(?, INTERVAL 3 DAY)`,
    [fromDate, toDate]
  );

  // Index by accountId+date for fast lookup
  const byAccountDate = new Map<string, XeroSpendTx[]>();
  for (const r of rows) {
    const key = `${r.accountId}|${String(r.txDate).substring(0, 10)}`;
    const list = byAccountDate.get(key) ?? [];
    list.push({
      accountId: r.accountId,
      amount: Number(r.amount),
      date: String(r.txDate).substring(0, 10),
      reference: r.reference ?? null,
    });
    byAccountDate.set(key, list);
  }

  return function isReconciled(
    bankAccountId: string,
    amount: number,
    date: string,
    cardActivityId?: string
  ): boolean {
    // Check date ±3 days window
    const baseMs = new Date(date).getTime();
    for (let delta = -3; delta <= 3; delta++) {
      const d = new Date(baseMs + delta * 86400000).toISOString().substring(0, 10);
      const key = `${bankAccountId}|${d}`;
      const txs = byAccountDate.get(key);
      if (txs?.some((tx) => Math.abs(tx.amount - amount) < 0.02)) return true;

      // Wise gross card activity can be split in Xero into supplier spend + a
      // separate reconciled FEE-CARD:<activityId> bank transaction.
      if (txs && cardActivityId) {
        const fee = txs.find((tx) => tx.reference === `FEE-CARD-${cardActivityId}`);
        if (fee) {
          const hasNetSpend = txs.some(
            (tx) =>
              tx !== fee &&
              tx.reference !== `FEE-CARD-${cardActivityId}` &&
              Math.abs(tx.amount + fee.amount - amount) < 0.02
          );
          if (hasNetSpend) return true;
        }
      }
    }
    return false;
  };
}

async function upsertStatementLine(
  tenantId: string,
  bankAccountId: string,
  bankAccountName: string,
  currency: string,
  activity: WiseActivity,
  amount: number,
  isReconciled: boolean,
  cardholder: "jani" | "mari" | null,
  last4: string | null
): Promise<void> {
  const txDate = activity.createdOn.substring(0, 10);
  const payee = stripHtml(activity.title) || null;
  const cardRef = last4 ? `Wise card payment - Card last 4 digits: ${last4}` : null;
  const notes = activity.description || null;

  // Use a short namespaced ID: "CARD:3944018300" or "TFR:2198402720"
  // Wise activity IDs (base64) exceed VARCHAR(64); resource IDs are short numeric strings.
  const typePrefix = activity.type === "CARD_PAYMENT" ? "CARD" : "TFR";
  const statementLineId = `${typePrefix}:${activity.resource.id}`;

  await getPool().execute(
    `INSERT INTO xero_bank_statement_lines
       (tenant_id, bank_account_id, bank_account_name, bank_account_currency,
        statement_id, statement_line_id, posted_date, transaction_date,
        payee, reference, notes, cheque_no, amount, type,
        is_reconciled, is_duplicate, is_deleted, import_source, raw_payload, synced_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, 'Debit', ?, 0, 0, 'wise', ?, NOW())
     ON DUPLICATE KEY UPDATE
       bank_account_name     = VALUES(bank_account_name),
       bank_account_currency = VALUES(bank_account_currency),
       payee                 = VALUES(payee),
       reference             = VALUES(reference),
       notes                 = VALUES(notes),
       amount                = VALUES(amount),
       is_reconciled         = VALUES(is_reconciled),
       import_source         = VALUES(import_source),
       raw_payload           = VALUES(raw_payload),
       synced_at             = NOW()`,
    [
      tenantId,
      bankAccountId,
      bankAccountName,
      currency,
      statementLineId,
      txDate,
      txDate,
      payee,
      cardRef,
      notes,
      amount,
      isReconciled ? 1 : 0,
      JSON.stringify(activity),
    ]
  );
}

export async function syncWiseActivities(
  fromDate: string,
  toDate: string
): Promise<WiseSyncResult> {
  const cfg = requireXeroConfig();
  const tenantId = cfg.tenantId;
  if (!tenantId) throw new Error("XERO_TENANT_ID must be set in .env to sync Wise activities");
  const client = new WiseClient();

  // Load Xero SPEND transactions for the period in one DB round-trip
  const isReconciled = await loadXeroSpendIndex(fromDate, toDate);

  // Wise activities API uses a streaming/polling cursor model — it does NOT paginate
  // historical data in order. The same recent activities are returned on every page
  // after the initial fetch. We track seen IDs and stop when a full page yields no new ones.
  const since = `${fromDate}T00:00:00.000Z`;
  const until = `${toDate}T23:59:59.000Z`;
  const MAX_PAGES = 20; // safety cap

  let cursor: string | undefined;
  let synced = 0;
  let skipped = 0;
  let reconciledCount = 0;
  let unreconciledCount = 0;
  let pagesProcessed = 0;
  const seenIds = new Set<string>();

  do {
    const page = await client.getActivities(WISE_PROFILE_ID, since, until, cursor);
    pagesProcessed++;

    let newOnPage = 0;

    for (const activity of page.activities) {
      // De-duplicate across pages (cursor pagination repeats recent activities)
      if (seenIds.has(activity.id)) continue;
      seenIds.add(activity.id);
      newOnPage++;

      const actDate = activity.createdOn?.substring(0, 10) ?? "";
      if (actDate > toDate || actDate < fromDate) continue;

      // Only process CARD_PAYMENT (and outgoing TRANSFER — future)
      if (activity.type !== "CARD_PAYMENT") {
        skipped++;
        continue;
      }

      const debit = parseDebit(activity);
      if (!debit) {
        skipped++;
        continue;
      }

      const xeroAccount = CURRENCY_TO_XERO[debit.currency];
      if (!xeroAccount) {
        skipped++;
        continue;
      }

      const { cardholder, last4 } = detectCardholder(activity);
      const txDate = activity.createdOn.substring(0, 10);
      const reconciled = isReconciled(
        xeroAccount.accountId,
        debit.amount,
        txDate,
        activity.resource.id
      );

      await upsertStatementLine(
        tenantId,
        xeroAccount.accountId,
        xeroAccount.accountName,
        debit.currency,
        activity,
        debit.amount,
        reconciled,
        cardholder,
        last4
      );

      synced++;
      if (reconciled) reconciledCount++;
      else unreconciledCount++;
    }

    // Stop when a page yields no new unique activity IDs
    if (newOnPage === 0) break;

    cursor = page.cursor ?? undefined;
  } while (cursor && pagesProcessed < MAX_PAGES);

  return { synced, skipped, reconciledCount, unreconciledCount };
}
