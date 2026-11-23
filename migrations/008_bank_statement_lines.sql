-- 008: Bank statement/provider feed line ingestion
-- Stores raw bank/card feed lines from direct providers (Wise/Revolut) and,
-- if ever enabled for the app, the restricted Xero Finance API.
-- Current supported fallback: Xero Accounting API for coded BankTransactions
-- plus direct provider feeds for raw activity.
-- Add that scope to XERO_AUTH_SCOPES in .env and re-run: node dist/cli.js auth
-- API endpoint: GET https://api.xero.com/finance.xro/1.0/BankStatementsPlus/statements
-- Parameters: BankAccountID (required), FromDate, ToDate, SummaryOnly=false
-- Max date range per request: 12 months.

-- Raw bank feed statement lines per bank account
CREATE TABLE IF NOT EXISTS xero_bank_statement_lines (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id             VARCHAR(64)   NOT NULL,
  bank_account_id       VARCHAR(64)   NOT NULL,
  bank_account_name     VARCHAR(255)  NULL,
  bank_account_currency VARCHAR(8)    NULL,
  statement_id          VARCHAR(64)   NULL,
  statement_line_id     VARCHAR(64)   NOT NULL,
  posted_date           DATE          NULL,
  transaction_date      DATE          NULL,
  payee                 VARCHAR(512)  NULL,
  reference             VARCHAR(512)  NULL,
  notes                 TEXT          NULL,
  cheque_no             VARCHAR(64)   NULL,
  amount                DECIMAL(18,4) NOT NULL,
  type                  VARCHAR(16)   NOT NULL,  -- 'Debit' | 'Credit'
  is_reconciled         BOOLEAN       NOT NULL DEFAULT FALSE,
  is_duplicate          BOOLEAN       NOT NULL DEFAULT FALSE,
  is_deleted            BOOLEAN       NOT NULL DEFAULT FALSE,
  import_source         VARCHAR(64)   NULL,      -- STMTIMPORTSRC/CBAFEED, YODLEE, CSV, MANUAL
  raw_payload           JSON          NOT NULL,
  synced_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stmt_line (tenant_id, bank_account_id, statement_line_id),
  INDEX idx_stmt_date (tenant_id, transaction_date),
  INDEX idx_stmt_unreconciled (tenant_id, is_reconciled, is_deleted, transaction_date),
  INDEX idx_stmt_type_date (tenant_id, type, transaction_date),
  INDEX idx_stmt_account (tenant_id, bank_account_id, transaction_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Extend bank_spend_orphans so STATEMENT_LINE source rows can coexist with BANKTRANSACTION rows.
-- All existing rows keep their default source_type = 'BANKTRANSACTION'.
ALTER TABLE bank_spend_orphans
  ADD COLUMN source_type ENUM('BANKTRANSACTION','STATEMENT_LINE') NOT NULL DEFAULT 'BANKTRANSACTION'
    AFTER tenant_id,
  ADD COLUMN payee VARCHAR(512) NULL
    AFTER contact_name;

-- Rebuild unique key to include source_type.
ALTER TABLE bank_spend_orphans DROP KEY uq_spend_orphan;
ALTER TABLE bank_spend_orphans
  ADD UNIQUE KEY uq_spend_orphan (tenant_id, source_type, xero_bank_tx_id);
