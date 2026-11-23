import { getPool } from "../db/mysql.js";
import { query } from "../db/mysql.js";
import { requireXeroConfig } from "../config.js";
import { XeroClient } from "./client.js";

const client = new XeroClient();

export interface StatementSyncResult {
  tenantId: string;
  synced: number;
  accountsProcessed: number;
  accountsSkipped: number;
  scopeError: boolean;
  scopeErrorMessage?: string;
}

export async function syncBankStatementLines(
  fromDate: string,
  toDate: string
): Promise<StatementSyncResult> {
  const { tenantId } = requireXeroConfig();
  if (!tenantId) throw new Error("XERO_TENANT_ID must be set in .env to sync bank statement lines");

  const bankAccounts = await query<any[]>(
    `SELECT account_id, code, name FROM xero_accounts
     WHERE tenant_id = ? AND type = 'BANK' AND status = 'ACTIVE'
     ORDER BY code`,
    [tenantId]
  );

  if (bankAccounts.length === 0) {
    return {
      tenantId,
      synced: 0,
      accountsProcessed: 0,
      accountsSkipped: 0,
      scopeError: false,
      scopeErrorMessage: "No active bank accounts found in warehouse. Run sync_reference first."
    };
  }

  let totalSynced = 0;
  let accountsProcessed = 0;
  let accountsSkipped = 0;

  for (const account of bankAccounts) {
    try {
      const result = await client.getFinanceApi(tenantId, "BankStatementsPlus/statements", {
        BankAccountID: account.account_id,
        FromDate: fromDate,
        ToDate: toDate,
        SummaryOnly: "false"
      });

      const statements = Array.isArray(result.statements) ? result.statements : [];
      const bankName = result.bankAccountName ?? account.name ?? null;
      const bankCurrency = result.bankAccountCurrencyCode ?? null;

      for (const stmt of statements) {
        const lines = Array.isArray(stmt.statementLines) ? stmt.statementLines : [];
        for (const line of lines) {
          if (!line.statementLineId) continue;
          await upsertStatementLine(
            tenantId, account.account_id, bankName, bankCurrency,
            stmt.statementId ?? null, stmt.importSource ?? null, line
          );
          totalSynced++;
        }
      }
      accountsProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("finance.bankstatementsplus.read") ||
        (msg.includes("Finance API") && msg.includes("Bank Statements Plus"))
      ) {
        return {
          tenantId,
          synced: totalSynced,
          accountsProcessed,
          accountsSkipped: bankAccounts.length - accountsProcessed,
          scopeError: true,
          scopeErrorMessage: msg
        };
      }
      console.warn(`Statement sync: account ${account.code} ${account.name} skipped — ${msg}`);
      accountsSkipped++;
    }
  }

  return { tenantId, synced: totalSynced, accountsProcessed, accountsSkipped, scopeError: false };
}

async function upsertStatementLine(
  tenantId: string,
  bankAccountId: string,
  bankAccountName: string | null,
  bankAccountCurrency: string | null,
  statementId: string | null,
  importSource: string | null,
  line: any
): Promise<void> {
  await getPool().execute(
    `INSERT INTO xero_bank_statement_lines
       (tenant_id, bank_account_id, bank_account_name, bank_account_currency,
        statement_id, statement_line_id, posted_date, transaction_date,
        payee, reference, notes, cheque_no, amount, type,
        is_reconciled, is_duplicate, is_deleted, import_source, raw_payload, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       bank_account_name     = VALUES(bank_account_name),
       bank_account_currency = VALUES(bank_account_currency),
       statement_id          = VALUES(statement_id),
       posted_date           = VALUES(posted_date),
       transaction_date      = VALUES(transaction_date),
       payee                 = VALUES(payee),
       reference             = VALUES(reference),
       notes                 = VALUES(notes),
       cheque_no             = VALUES(cheque_no),
       amount                = VALUES(amount),
       type                  = VALUES(type),
       is_reconciled         = VALUES(is_reconciled),
       is_duplicate          = VALUES(is_duplicate),
       is_deleted            = VALUES(is_deleted),
       import_source         = VALUES(import_source),
       raw_payload           = VALUES(raw_payload),
       synced_at             = NOW()`,
    [
      tenantId, bankAccountId, bankAccountName, bankAccountCurrency,
      statementId, line.statementLineId,
      line.postedDate ?? null,
      line.transactionDate ?? null,
      line.payee ?? null,
      line.reference ?? null,
      line.notes ?? null,
      line.chequeNo ?? null,
      Number(line.amount ?? 0),
      line.type ?? "Debit",
      line.isReconciled ? 1 : 0,
      line.isDuplicate ? 1 : 0,
      line.isDeleted ? 1 : 0,
      importSource,
      JSON.stringify(line),
    ]
  );
}
