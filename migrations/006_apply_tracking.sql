-- ---------------------------------------------------------------------------
-- 006 — Apply tracking columns for Phase 3 write layer
-- ---------------------------------------------------------------------------
-- Track whether a PS orphan order has been turned into a Xero DRAFT invoice.
ALTER TABLE reconciliation_ps_orphans
  ADD COLUMN IF NOT EXISTS apply_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS xero_draft_id VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP NULL;

-- Track when a coding proposal was applied to Xero.
ALTER TABLE coding_proposals
  ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP NULL;
