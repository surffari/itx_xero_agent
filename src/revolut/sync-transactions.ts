import { getPool } from "../db/mysql.js";
import { query } from "../db/mysql.js";
import { requireXeroConfig } from "../config.js";
import { RevolutClient, type RevolutTransaction } from "./client.js";

// Revolut account ID → Xero bank account mapping
const REVOLUT_ACCOUNTS: Array<{
  revolutAccountId: string;
  xeroAccountId: string;
  xeroAccountName: string;
  currency: string;
}> = [
  {
    revolutAccountId: "f558a3db-95aa-48c1-842d-b067719e9898",
    xeroAccountId: "f8c02cb4-1fa1-4e38-9e87-cd38229d8b78",
    xeroAccountName: "Revolut EUR Main",
    currency: "EUR",
  },
  {
    revolutAccountId: "8093651d-da8f-495a-9e20-9ff00e047060",
    xeroAccountId: "cad354c8-74ef-4adb-90af-0fc8c9cff6a4",
    xeroAccountName: "Revolut GBP Main",
    currency: "GBP",
  },
  {
    revolutAccountId: "8533070d-056b-469c-9d4f-7b2e957c445d",
    xeroAccountId: "8b2251e6-989c-4d00-84b1-ad0610b5b06b",
    xeroAccountName: "Revolut USD Main",
    currency: "USD",
  },
];

export interface RevolutSyncResult {
  synced: number;
  skipped: number;
  reconciledCount: number;
  unreconciledCount: number;
}

function extractAccountLeg(
  tx: RevolutTransaction,
  revolutAccountId: string
): { amount: number; currency: string; type: "Debit" | "Credit" } | null {
  for (const leg of tx.legs) {
    if (leg.account_id !== revolutAccountId || leg.amount === 0) continue;
    return {
      amount: Math.abs(leg.amount),
      currency: leg.currency,
      type: leg.amount < 0 ? "Debit" : "Credit",
    };
  }
  return null;
}

async function loadXeroBankTransactionIndex(
  fromDate: string,
  toDate: string
): Promise<(bankAccountId: string, type: "Debit" | "Credit", amount: number, date: string) => boolean> {
  const rows = await query<any[]>(
    `SELECT
       JSON_UNQUOTE(JSON_EXTRACT(payload, '$.BankAccount.AccountID')) AS accountId,
       JSON_UNQUOTE(JSON_EXTRACT(payload, '$.Type')) AS txType,
       CAST(JSON_EXTRACT(payload, '$.Total') AS DECIMAL(18,4)) AS amount,
       DATE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.DateString'))) AS txDate
     FROM xero_raw_objects
     WHERE object_type = 'BANKTRANSACTION'
       AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.Type')) IN ('SPEND','RECEIVE')
       AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.Status')) = 'AUTHORISED'
       AND DATE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.DateString')))
           BETWEEN DATE_SUB(?, INTERVAL 3 DAY) AND DATE_ADD(?, INTERVAL 3 DAY)`,
    [fromDate, toDate]
  );

  const byAccountTypeDate = new Map<string, number[]>();
  for (const r of rows) {
    const statementType = r.txType === "RECEIVE" ? "Credit" : "Debit";
    const key = `${r.accountId}|${statementType}|${String(r.txDate).substring(0, 10)}`;
    const list = byAccountTypeDate.get(key) ?? [];
    list.push(Number(r.amount));
    byAccountTypeDate.set(key, list);
  }

  return function isReconciled(
    bankAccountId: string,
    type: "Debit" | "Credit",
    amount: number,
    date: string
  ): boolean {
    const baseMs = new Date(date).getTime();
    for (let delta = -3; delta <= 3; delta++) {
      const d = new Date(baseMs + delta * 86400000).toISOString().substring(0, 10);
      const key = `${bankAccountId}|${type}|${d}`;
      const amounts = byAccountTypeDate.get(key);
      if (amounts?.some((a) => Math.abs(a - amount) < 0.02)) return true;
    }
    return false;
  }
}

function detectCardholder(
  tx: RevolutTransaction
): { name: string | null; last4: string | null } {
  if (!tx.card) return { name: null, last4: null };
  const first = tx.card.first_name ?? "";
  const last = tx.card.last_name ?? "";
  const fullName = `${first} ${last}`.trim() || null;
  const digits = (tx.card.card_number ?? "").replace(/\D/g, "");
  const last4 = digits.length >= 4 ? digits.slice(-4) : null;
  return { name: fullName, last4 };
}

function extractPayee(tx: RevolutTransaction): string | null {
  if (tx.merchant?.name) return tx.merchant.name;
  // For transfers, use counterparty name from first leg
  for (const leg of tx.legs) {
    if (leg.counterparty?.name) return leg.counterparty.name;
  }
  return null;
}

function extractDescription(tx: RevolutTransaction): string | null {
  const parts: string[] = [];
  if (tx.reference) parts.push(tx.reference);
  for (const leg of tx.legs) {
    if (leg.description && !parts.includes(leg.description)) parts.push(leg.description);
  }
  return parts.join(" | ") || null;
}

async function upsertStatementLine(
  tenantId: string,
  xeroAccountId: string,
  xeroAccountName: string,
  currency: string,
  tx: RevolutTransaction,
  amount: number,
  type: "Debit" | "Credit",
  isReconciled: boolean,
  cardholderName: string | null,
  last4: string | null
): Promise<void> {
  const txDate = (tx.completed_at ?? tx.created_at).substring(0, 10);
  const payee = extractPayee(tx);
  const notes = extractDescription(tx);

  const cardRef = last4
    ? `Revolut card payment - Card last 4 digits: ${last4}`
    : cardholderName
    ? `Revolut card payment - ${cardholderName}`
    : null;

  // REVO:{uuid} = 5+36 = 41 chars — fits VARCHAR(64)
  const statementLineId = `REVO:${tx.id}`;

  await getPool().execute(
    `INSERT INTO xero_bank_statement_lines
       (tenant_id, bank_account_id, bank_account_name, bank_account_currency,
        statement_id, statement_line_id, posted_date, transaction_date,
        payee, reference, notes, cheque_no, amount, type,
        is_reconciled, is_duplicate, is_deleted, import_source, raw_payload, synced_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, 'revolut', ?, NOW())
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
      xeroAccountId,
      xeroAccountName,
      currency,
      statementLineId,
      txDate,
      txDate,
      payee,
      cardRef,
      notes,
      amount,
      type,
      isReconciled ? 1 : 0,
      JSON.stringify(tx),
    ]
  );
}

export async function syncRevolutTransactions(
  fromDate: string,
  toDate: string
): Promise<RevolutSyncResult> {
  const cfg = requireXeroConfig();
  const tenantId = cfg.tenantId;
  if (!tenantId) throw new Error("XERO_TENANT_ID must be set in .env to sync Revolut transactions");

  const client = new RevolutClient();
  const isReconciled = await loadXeroBankTransactionIndex(fromDate, toDate);

  let synced = 0;
  let skipped = 0;
  let reconciledCount = 0;
  let unreconciledCount = 0;

  for (const account of REVOLUT_ACCOUNTS) {
    const transactions = await client.getTransactions(
      account.revolutAccountId,
      fromDate,
      toDate
    );

    if (transactions.length >= 1000) {
      console.warn(
        `Revolut ${account.xeroAccountName}: hit 1000-transaction limit — ` +
          `consider syncing a smaller date window`
      );
    }

    for (const tx of transactions) {
      if (tx.state !== "completed") {
        skipped++;
        continue;
      }
      const accountLeg = extractAccountLeg(tx, account.revolutAccountId);
      if (!accountLeg) {
        skipped++; // zero / no movement on this account
        continue;
      }

      const { name: cardholderName, last4 } = detectCardholder(tx);
      const txDate = (tx.completed_at ?? tx.created_at).substring(0, 10);
      const reconciled = isReconciled(account.xeroAccountId, accountLeg.type, accountLeg.amount, txDate);

      await upsertStatementLine(
        tenantId,
        account.xeroAccountId,
        account.xeroAccountName,
        accountLeg.currency,
        tx,
        accountLeg.amount,
        accountLeg.type,
        reconciled,
        cardholderName,
        last4
      );

      synced++;
      if (reconciled) reconciledCount++;
      else unreconciledCount++;
    }
  }

  return { synced, skipped, reconciledCount, unreconciledCount };
}
