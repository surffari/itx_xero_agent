-- Migration 003: Write audit log table
-- Immutable append-only record of every write attempted to Xero.

CREATE TABLE IF NOT EXISTS xero_write_log (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       VARCHAR(64) NOT NULL,
  operation       VARCHAR(64) NOT NULL,          -- e.g. CREATE_INVOICE, UPDATE_INVOICE
  idempotency_key VARCHAR(255) NOT NULL,         -- deterministic: reference + operation
  dry_run         TINYINT(1) NOT NULL DEFAULT 0,
  status          VARCHAR(32) NOT NULL,          -- pending, success, skipped, error, flagged
  flag_reason     VARCHAR(512) DEFAULT NULL,     -- why creation was flagged/skipped
  request_payload LONGTEXT NOT NULL,             -- JSON sent to Xero (or would have been)
  response_payload LONGTEXT DEFAULT NULL,        -- JSON response from Xero API (null for dry_run)
  xero_object_id  VARCHAR(64) DEFAULT NULL,      -- Xero entity ID returned on success
  ps_reference    VARCHAR(64) DEFAULT NULL,      -- PS order reference (for index/lookup)
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_idempotency (idempotency_key, dry_run),
  INDEX idx_ps_reference (ps_reference),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
