-- Bills Management (Phase 1, R7/R9/R10/R11): adds a business-facing lifecycle status
-- alongside the existing `status` column, which is left untouched. This column tracks
-- what the Bills Management dashboard shows the human, not the agent's internal
-- processing state.

ALTER TABLE mailbox_invoice_files
  ADD COLUMN bills_status ENUM(
    'incoming',          -- discovered, not yet routed by Bills Management logic
    'ready_for_xero',    -- validated; staged for Xero DRAFT bill creation
    'uploaded_to_xero',  -- Xero DRAFT bill created successfully
    'needs_review',      -- uncertain/incomplete data — routed to a human, never guessed
    'exceptions'         -- non-invoice, confirmed duplicate, or a processing failure
  ) NOT NULL DEFAULT 'incoming' AFTER status,
  ADD COLUMN bills_status_reason VARCHAR(500) NULL AFTER bills_status,
  ADD COLUMN bills_status_changed_at DATETIME NULL AFTER bills_status_reason,
  ADD COLUMN duplicate_check_result ENUM('not_checked','unique','duplicate') NOT NULL DEFAULT 'not_checked' AFTER bills_status_changed_at,
  ADD COLUMN duplicate_check_reference VARCHAR(64) NULL AFTER duplicate_check_result,
  ADD INDEX idx_bills_status (bills_status);
