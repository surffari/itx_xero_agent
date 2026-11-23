-- Supplier tax profiles: verified facts about each supplier used to determine
-- purchase bill coding. Takes precedence over agent_rules when confidence is sufficient.
-- Profiles are created by the agent from answered decision_queue items; never hardcoded.

CREATE TABLE IF NOT EXISTS supplier_tax_profiles (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  contact_name        VARCHAR(255)                                     NOT NULL,
  country_iso         CHAR(2)                                          NULL     COMMENT 'Supplier''s country of registration',
  vat_id              VARCHAR(50)                                      NULL     COMMENT 'EU VAT registration number',
  entity_type         ENUM('company','individual','platform')          NOT NULL DEFAULT 'company',
  supply_type         ENUM('goods','services','mixed')                 NOT NULL DEFAULT 'services',
  default_tax_code    VARCHAR(20)                                      NULL     COMMENT 'Xero TaxType to apply (e.g. TAX021 for EU reverse charge)',
  default_account_code VARCHAR(20)                                     NULL     COMMENT 'Xero account code (e.g. 480)',
  notes               TEXT                                             NULL,
  confidence          DECIMAL(3,2)                                     NOT NULL DEFAULT 0.50,
  vies_validated_at   DATETIME                                         NULL,
  vies_valid          BOOLEAN                                          NULL,
  created_at          DATETIME                                         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME                                         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_contact_name (contact_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
