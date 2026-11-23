-- Supplier invoice mailbox (xero@intactix.io via IMAP) — primary Bills Management source.
-- Mirrors the xero_inbox_files status machine but keyed on IMAP UID rather than a Xero file ID.

CREATE TABLE IF NOT EXISTS mailbox_poll_state (
  mailbox         VARCHAR(255) NOT NULL PRIMARY KEY,
  uid_validity    BIGINT UNSIGNED NOT NULL,
  last_uid        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_polled_at  DATETIME NULL
);

CREATE TABLE IF NOT EXISTS mailbox_invoice_files (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  mailbox             VARCHAR(255) NOT NULL,
  uid_validity        BIGINT UNSIGNED NOT NULL,
  uid                 BIGINT UNSIGNED NOT NULL,
  message_id          VARCHAR(998) NULL,
  from_address        VARCHAR(255) NULL,
  subject             VARCHAR(998) NULL,
  received_at         DATETIME NULL,
  attachment_filename VARCHAR(255) NOT NULL,
  attachment_size     INT NULL,
  status ENUM(
    'new',         -- just discovered, not yet processed
    'processing',  -- agent is working on matching
    'matched',     -- matched/coded and DRAFT bill created
    'no_match',    -- agent inspected, could not match
    'error'        -- processing failed
  ) NOT NULL DEFAULT 'new',
  matched_orphan_id   BIGINT UNSIGNED NULL,
  matched_invoice_id  VARCHAR(64) NULL,
  extracted_supplier  VARCHAR(255) NULL,
  extracted_amount    DECIMAL(18,4) NULL,
  extracted_currency  VARCHAR(3) NULL,
  extracted_date      DATE NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_mailbox_uid_attachment (mailbox, uid_validity, uid, attachment_filename)
);
