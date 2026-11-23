-- 007: Spend orphan detection + Xero inbox receipt matching
-- Adds transaction_subtype to finance_transaction_lines for SPEND_MONEY / RECEIVE_MONEY
-- Adds bank_spend_orphans (unmatched spend awaiting receipt)
-- Adds xero_inbox_files (files landed in Xero inbox, to be matched)

ALTER TABLE finance_transaction_lines
  ADD COLUMN transaction_subtype VARCHAR(32) NULL AFTER source_type,
  ADD INDEX idx_ftl_subtype (tenant_id, transaction_subtype, transaction_date);

-- Backfill BANKTRANSACTION rows from raw payload
UPDATE finance_transaction_lines ftl
JOIN xero_raw_objects ro ON ro.id = ftl.raw_object_id
SET ftl.transaction_subtype = JSON_UNQUOTE(JSON_EXTRACT(ro.payload, '$.Type'))
WHERE ftl.source_type = 'BANKTRANSACTION'
  AND ftl.transaction_subtype IS NULL;

-- Unmatched bank spend transactions awaiting a receipt / supplier invoice
CREATE TABLE IF NOT EXISTS bank_spend_orphans (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id           VARCHAR(64)  NOT NULL,
  run_id              BIGINT       NULL,
  xero_bank_tx_id     VARCHAR(64)  NOT NULL,
  transaction_date    DATE         NOT NULL,
  amount              DECIMAL(18,4) NOT NULL,
  currency            VARCHAR(3)   NOT NULL,
  description         TEXT,
  reference           TEXT,
  contact_name        VARCHAR(255),
  bank_account_code   VARCHAR(32),
  cardholder          VARCHAR(32)  NULL,  -- 'jani' | 'mari' | null
  card_last4          VARCHAR(4)   NULL,
  status ENUM(
    'flagged',    -- detected, queue entry not yet created
    'chasing',    -- decision queue entry exists
    'received',   -- a file arrived in Xero inbox (not yet matched)
    'matched',    -- inbox file matched to this spend
    'coded',      -- DRAFT ACCPAY bill created and file attached
    'dismissed'   -- confirmed no receipt needed
  ) NOT NULL DEFAULT 'flagged',
  matched_file_id     VARCHAR(64)  NULL,
  matched_invoice_id  VARCHAR(64)  NULL,
  notes               TEXT,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spend_orphan (tenant_id, xero_bank_tx_id)
);

-- Files received in the Xero inbox (bills@ email drop)
CREATE TABLE IF NOT EXISTS xero_inbox_files (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id           VARCHAR(64)  NOT NULL,
  file_id             VARCHAR(64)  NOT NULL,
  file_name           VARCHAR(255),
  mime_type           VARCHAR(128),
  size_bytes          INT,
  created_date_utc    DATETIME,
  status ENUM(
    'new',         -- just discovered, not yet processed
    'processing',  -- agent is working on matching
    'matched',     -- matched to a spend orphan and bill created
    'no_match',    -- agent inspected, could not match
    'error'        -- processing failed
  ) NOT NULL DEFAULT 'new',
  matched_orphan_id   BIGINT UNSIGNED NULL,
  matched_invoice_id  VARCHAR(64)  NULL,
  extracted_supplier  VARCHAR(255) NULL,
  extracted_amount    DECIMAL(18,4) NULL,
  extracted_currency  VARCHAR(3)   NULL,
  extracted_date      DATE         NULL,
  first_seen_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inbox_file (tenant_id, file_id)
);
