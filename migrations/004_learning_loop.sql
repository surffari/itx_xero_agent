-- Migration 004: Learning loop — rule store, decision queue, coding proposals
-- Phase 1 core. Nothing in this file writes to Xero.

-- ---------------------------------------------------------------------------
-- agent_rules: durable, machine-executable reconciliation/coding rules.
-- Populated by seeds (SEED source), human answers (HUMAN), or agent (AGENT).
-- The engine applies rules in priority order (lower = higher priority).
-- All match_* columns are nullable; a rule fires when ALL non-null conditions hit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_rules (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  priority              INT NOT NULL DEFAULT 1000,
  rule_name             VARCHAR(255) NOT NULL UNIQUE,
  scope                 VARCHAR(64) NOT NULL DEFAULT 'ALL',
  -- match dimensions (all nullable; NULL = don't-care)
  match_transaction_type VARCHAR(32) NULL,      -- ACCPAY / ACCREC / BANK_SPEND / BANK_RECEIVE / NULL=any
  match_contact_name_re  VARCHAR(512) NULL,      -- JS-compatible REGEXP, case-insensitive
  match_account_code     VARCHAR(64) NULL,       -- exact Xero account code on existing line
  match_description_re   VARCHAR(512) NULL,      -- REGEXP against line description
  match_ship_country_iso VARCHAR(8) NULL,        -- ISO-2 country, 'EU', or 'NON_EU' (sales only)
  match_currency         VARCHAR(8) NULL,        -- EUR / GBP / USD
  -- proposed outputs (all nullable; rule may assign only some)
  assigned_account_code  VARCHAR(64) NULL,
  assigned_account_name  VARCHAR(255) NULL,
  assigned_tax_code      VARCHAR(64) NULL,
  assigned_contact_name  VARCHAR(255) NULL,      -- for contact splits (e.g. Tradethno roles)
  -- meta
  confidence    DECIMAL(5,4) NOT NULL DEFAULT 0.8000,
  source        ENUM('SEED','HUMAN','AGENT') NOT NULL DEFAULT 'SEED',
  decision_id   BIGINT NULL,   -- set when promoted from decision_queue
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_rules_active_priority (active, priority),
  INDEX idx_rules_scope_type (scope, match_transaction_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- decision_queue: items the engine could not resolve, waiting for a human answer.
-- queue_key is deterministic from evidence inputs (prevents duplicates on re-run).
-- Once answered, call promote_to_rule to create a durable rule.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_queue (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  queue_key        VARCHAR(255) NOT NULL UNIQUE,
  domain           ENUM('MATCH','TAX_CODE','ACCOUNT_CODE','SUPPLIER_PROFILE','OTHER') NOT NULL,
  transaction_type VARCHAR(32) NULL,
  contact_name     VARCHAR(255) NULL,
  xero_invoice_id  VARCHAR(64) NULL,
  ps_order_id      INT NULL,
  run_id           BIGINT NULL,
  evidence         JSON NOT NULL,
  question         TEXT NOT NULL,
  status           ENUM('open','answered','promoted','dismissed') NOT NULL DEFAULT 'open',
  answer           TEXT NULL,
  answered_by      VARCHAR(64) NULL,     -- 'human' or 'agent'
  answered_at      TIMESTAMP NULL,
  promoted_rule_id BIGINT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_dq_status (status),
  INDEX idx_dq_domain (domain),
  INDEX idx_dq_run (run_id),
  CONSTRAINT fk_dq_promoted_rule FOREIGN KEY (promoted_rule_id) REFERENCES agent_rules(id),
  CONSTRAINT fk_dq_run FOREIGN KEY (run_id) REFERENCES reconciliation_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- coding_proposals: per-bill or per-bank-tx coding proposals from the engine.
-- One row per (run, source object). Records current Xero coding + proposed coding.
-- The agent reviews these and approves, rejects, or queues each item.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coding_proposals (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id               BIGINT NOT NULL,
  source_ref           VARCHAR(128) NOT NULL,   -- 'ACCPAY:{uuid}' or 'BANK:{uuid}'
  source_type          VARCHAR(32) NOT NULL,    -- ACCPAY / BILL / BANK_SPEND
  xero_invoice_id      VARCHAR(64) NULL,
  contact_name         VARCHAR(255) NULL,
  transaction_date     DATE NULL,
  currency_code        VARCHAR(8) NULL,
  total                DECIMAL(18,4) NULL,
  -- existing Xero coding (from the most common/first line)
  current_account_code VARCHAR(64) NULL,
  current_account_name VARCHAR(255) NULL,
  current_tax_code     VARCHAR(64) NULL,
  -- proposed coding from rules
  proposed_account_code VARCHAR(64) NULL,
  proposed_account_name VARCHAR(255) NULL,
  proposed_tax_code     VARCHAR(64) NULL,
  matched_rule_id       BIGINT NULL,
  matched_rule_name     VARCHAR(255) NULL,
  coding_confidence     DECIMAL(5,4) NULL,
  proposal_status       VARCHAR(32) NOT NULL DEFAULT 'proposed',
  decision_id           BIGINT NULL,
  notes                 TEXT NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_coding_proposal (run_id, source_ref),
  INDEX idx_coding_run (run_id),
  INDEX idx_coding_status (proposal_status),
  CONSTRAINT fk_coding_run FOREIGN KEY (run_id) REFERENCES reconciliation_runs(id),
  CONSTRAINT fk_coding_rule FOREIGN KEY (matched_rule_id) REFERENCES agent_rules(id),
  CONSTRAINT fk_coding_decision FOREIGN KEY (decision_id) REFERENCES decision_queue(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Extend reconciliation_results with confidence scores, proposed coding,
-- bank receipt linkage, and decision queue pointer.
-- ---------------------------------------------------------------------------
ALTER TABLE reconciliation_results
  ADD COLUMN IF NOT EXISTS proposed_account_code VARCHAR(64) NULL AFTER ps_vat_inputs,
  ADD COLUMN IF NOT EXISTS proposed_tax_code      VARCHAR(64) NULL AFTER proposed_account_code,
  ADD COLUMN IF NOT EXISTS matched_rule_id        BIGINT NULL       AFTER proposed_tax_code,
  ADD COLUMN IF NOT EXISTS match_confidence       DECIMAL(5,4) NULL AFTER matched_rule_id,
  ADD COLUMN IF NOT EXISTS tax_confidence         DECIMAL(5,4) NULL AFTER match_confidence,
  ADD COLUMN IF NOT EXISTS xero_payment_id        VARCHAR(64) NULL  AFTER tax_confidence,
  ADD COLUMN IF NOT EXISTS xero_payment_date      DATE NULL         AFTER xero_payment_id,
  ADD COLUMN IF NOT EXISTS xero_payment_amount    DECIMAL(18,4) NULL AFTER xero_payment_date,
  ADD COLUMN IF NOT EXISTS decision_id            BIGINT NULL       AFTER xero_payment_amount;

-- ---------------------------------------------------------------------------
-- Seed rules derived from IAR-001 through IAR-014 and verified Xero data.
-- Priority scheme: 100-199 = contact-exact, 200-299 = account code, 300+ = keyword.
-- Confidence < 0.75 will trigger enqueue; confidence >= 0.75 is auto-proposed.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO agent_rules
  (priority, rule_name, scope, match_transaction_type,
   match_contact_name_re, assigned_account_code, assigned_account_name, assigned_tax_code,
   confidence, source, notes)
VALUES
  -- IAR-001/003/004: Tradethno product purchases (non-EU related party, goods/raw materials)
  (100, 'Tradethno product purchases', 'PURCHASES', 'ACCPAY',
   'tradethno', '310', 'Cost of Goods Sold', 'TAX023',
   0.85, 'SEED',
   'IAR-001/003/004. Non-EU related party; product/raw material purchases to COGS, no VAT.'),

  -- IAR-003: VespaEx product purchases
  (101, 'VespaEx product purchases', 'PURCHASES', 'ACCPAY',
   'vespaex', '310', 'Cost of Goods Sold', 'TAX023',
   0.88, 'SEED',
   'IAR-003. NL-based supplier of raw materials; typically no VAT on B2B product imports from non-EU context. Confirm tax code with accountant if VespaEx is NL VAT registered.'),

  -- IAR-005: Active Ants fulfilment (NL domestic — tax code uncertain, needs accountant)
  (102, 'Active Ants fulfilment costs', 'PURCHASES', 'ACCPAY',
   'active ants', '409', 'Fulfillment Costs', NULL,
   0.65, 'SEED',
   'IAR-005. NL domestic supplier; account=409 confirmed. Tax code uncertain: NL domestic input VAT or exempt? Queue for accountant.'),

  -- IAR-005: Monta fulfilment
  (103, 'Monta fulfilment costs', 'PURCHASES', 'ACCPAY',
   'monta|montapacking|montapor', '409', 'Fulfillment Costs', NULL,
   0.65, 'SEED',
   'IAR-005. NL domestic fulfilment supplier; account=409 confirmed. Tax code needs accountant confirmation.'),

  -- IAR-005: DSV freight/courier
  (104, 'DSV freight and courier', 'PURCHASES', 'ACCPAY',
   'dsv', '425', 'Freight & Courier', NULL,
   0.72, 'SEED',
   'IAR-005. DSV provides international freight; account=425 confirmed. Tax code depends on route/origin — queue for review.'),

  -- IAR-006: Paulo Tomas — non-EU contractor
  (110, 'Paulo Tomas contractor', 'PURCHASES', 'ACCPAY',
   'paulo tomas|paulo', '480', 'Contractor & Freelance Services', 'TAX023',
   0.85, 'SEED',
   'IAR-006. Non-EU contractor; No VAT (TAX023). Upwork/Fiverr platform treatment may differ — this rule is for direct Paulo invoices.'),

  -- IAR-006: Suhenny/Henny — non-EU contractor
  (111, 'Suhenny Henny contractor', 'PURCHASES', 'ACCPAY',
   'suhenny|dwi purwasih|henny', '480', 'Contractor & Freelance Services', 'TAX023',
   0.85, 'SEED',
   'IAR-006. Non-EU contractor; No VAT (TAX023).'),

  -- IAR-006: Upwork — platform, tax treatment open question
  (112, 'Upwork contractor platform', 'PURCHASES', 'ACCPAY',
   'upwork', '480', 'Contractor & Freelance Services', 'TAX023',
   0.62, 'SEED',
   'IAR-006. Open question: Upwork may now be EU VAT registered (self-billing). Confidence low until accountant confirms EU vs non-EU reverse charge treatment.'),

  -- IAR-006: Fiverr — platform, tax treatment open question
  (113, 'Fiverr contractor platform', 'PURCHASES', 'ACCPAY',
   'fiverr', '480', 'Contractor & Freelance Services', 'TAX023',
   0.62, 'SEED',
   'IAR-006. Same open question as Upwork re EU VAT registration and self-billing.'),

  -- IAR-007: Green Goddess Consulting — Finnish entity, EU reverse charge
  (120, 'Green Goddess owner billing', 'PURCHASES', 'ACCPAY',
   'green goddess', '705', 'Owner / Related Entity Services', 'TAX021',
   0.88, 'SEED',
   'IAR-007. Finnish entity; EU reverse charge (TAX021) confirmed. Account=705 Owner/Related Entity Services.'),

  -- IAR-007: Extremexports — non-EU entity, no VAT
  (121, 'Extremexports owner billing', 'PURCHASES', 'ACCPAY',
   'extremexports', '705', 'Owner / Related Entity Services', 'TAX023',
   0.85, 'SEED',
   'IAR-007. Non-EU entity (AU); No VAT (TAX023). Account=705 Owner/Related Entity Services.'),

  -- IAR-008: Mollie payment processing fees
  (130, 'Mollie payment processing fees', 'PURCHASES', 'ACCPAY',
   'mollie', '405', 'Payment GW Fees', 'TAX021',
   0.90, 'SEED',
   'IAR-008. Mollie is a Dutch payment processor; NL domestic VAT applies (treating as TAX021 EU input VAT pending accountant confirmation of exact Dutch input code). Now inactive after account closure.'),

  -- IAR-002: EU sales via PrestaShop — coding handled by COUNTRY_RULES in invoice-builder.
  -- Not seeded here to avoid dual sources of truth for ACCREC coding.

  -- IAR-001: Export sales (non-EU) confirmation — seeded but inactive.
  -- processOnlineSales() uses SALES_COUNTRY_RULES directly; this rule never fires via applyRules.
  -- Re-activate only if ACCREC is wired through applyRules in future.
  (200, 'Export sales account validation', 'SALES', 'ACCREC',
   NULL, '200', 'Export Sales', 'TAX011',
   0.80, 'SEED',
   'IAR-001. Non-EU sales account validation. Seeded inactive — ACCREC coding uses SALES_COUNTRY_RULES directly, not applyRules. Activate if ACCREC rule path is ever wired.'),

  -- IAR-010: Travel spend — queue for specific coding
  (310, 'Travel expense flag', 'PURCHASES', NULL,
   'finnair|airline|hotel|booking\\.com|airbnb|uber|bolt|taxi|finavia|klm|ryanair',
   NULL, NULL, NULL,
   0.30, 'SEED',
   'IAR-010. Travel suppliers should be coded to 493 or 494, not 429. Queue for precise coding.'),

  -- IAR-010: Meals and entertainment flag
  (311, 'Meals and entertainment flag', 'PURCHASES', NULL,
   'cafe|restaurant|visser|blushing|bck',
   NULL, NULL, NULL,
   0.30, 'SEED',
   'IAR-010. Meals and entertainment should be coded to 421, not 429. Queue for business-purpose review.'),

  -- IAR-004: Tradethno sales contact assignment — seeded but inactive.
  -- Same reason as Export sales account validation above: ACCREC never calls applyRules.
  (400, 'Tradethno customer sales', 'SALES', 'ACCREC',
   'tradethno.*customer', '200', 'Export Sales', 'TAX011',
   0.82, 'SEED',
   'IAR-004. Tradethno in customer role: sales to 200 Export Sales with TAX011. Inactive — ACCREC coding uses SALES_COUNTRY_RULES directly.');

-- Suspense and 429 rules need match_account_code which requires a separate INSERT form.
-- These fire only when the existing line is already coded to those accounts.
INSERT IGNORE INTO agent_rules
  (priority, rule_name, scope, match_account_code, assigned_account_code, assigned_tax_code, confidence, source, notes)
VALUES
  (300, 'Suspense account flag', 'ALL', '850', NULL, NULL, 0.10, 'SEED',
   'IAR-009. Existing 850 Suspense coding must be reviewed monthly. Confidence low to force queue.'),
  (320, 'General business expenses review', 'PURCHASES', '429', '429', NULL, 0.40, 'SEED',
   'IAR-010. Existing 429 catch-all coding should be recoded to specific accounts. Queue for review.');

-- Deactivate ACCREC/SALES rules that are seeded as documentation only.
-- processOnlineSales() uses SALES_COUNTRY_RULES directly; applyRules() is never called for ACCREC.
-- Re-activate if the ACCREC path is ever wired through applyRules.
UPDATE agent_rules
SET active = FALSE
WHERE rule_name IN ('Export sales account validation', 'Tradethno customer sales');
