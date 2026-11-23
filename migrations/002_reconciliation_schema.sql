CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  summary JSON NULL,
  error_message TEXT NULL,
  INDEX idx_recon_runs_period (period_start, period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per Xero ACCREC invoice processed in a run.
-- match_status values:
--   MATCHED            - reference + invoice_number both match a PS order
--   REF_MATCH_INV_DIFF - reference matches but invoice_number differs (INV-XXXX vs numeric)
--   XERO_ONLY          - no PS order found by reference
CREATE TABLE IF NOT EXISTS reconciliation_results (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT NOT NULL,
  xero_invoice_id VARCHAR(64) NOT NULL,
  xero_reference VARCHAR(255) NULL,
  xero_invoice_number VARCHAR(255) NULL,
  xero_date DATE NULL,
  xero_status VARCHAR(64) NULL,
  xero_currency VARCHAR(8) NULL,
  xero_total DECIMAL(18,4) NULL,
  xero_tax_amount DECIMAL(18,4) NULL,
  xero_tax_type VARCHAR(64) NULL,
  match_status VARCHAR(32) NOT NULL,
  ps_order_id INT NULL,
  ps_invoice_number VARCHAR(64) NULL,
  ps_date DATETIME NULL,
  ps_currency_id INT NULL,
  ps_total_incl DECIMAL(18,4) NULL,
  ps_total_excl DECIMAL(18,4) NULL,
  ps_shipping_incl DECIMAL(18,4) NULL,
  ps_ship_country VARCHAR(8) NULL,
  ps_order_state VARCHAR(64) NULL,
  ps_vat_inputs JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_recon_result (run_id, xero_invoice_id),
  INDEX idx_recon_results_run (run_id),
  INDEX idx_recon_results_status (match_status),
  CONSTRAINT fk_recon_results_run FOREIGN KEY (run_id) REFERENCES reconciliation_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PS orders in the period that have invoice=1 state but no corresponding Xero invoice.
CREATE TABLE IF NOT EXISTS reconciliation_ps_orphans (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT NOT NULL,
  ps_order_id INT NOT NULL,
  ps_reference VARCHAR(64) NULL,
  ps_invoice_number VARCHAR(64) NULL,
  ps_state VARCHAR(64) NULL,
  ps_date DATETIME NULL,
  ps_currency_id INT NULL,
  ps_total_incl DECIMAL(18,4) NULL,
  ps_ship_country VARCHAR(8) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ps_orphan (run_id, ps_order_id),
  INDEX idx_ps_orphans_run (run_id),
  CONSTRAINT fk_ps_orphans_run FOREIGN KEY (run_id) REFERENCES reconciliation_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
