# Intactix Accounting Agent — Project Instructions

## Scope

This is a standalone TypeScript project. The implementation plan is in `PLAN.md`.

## Permissions model

Within this repository (`/opt/projects/openclaw/gopure/intactix/`): full autonomous access — create, edit, delete, move files and run any development command without asking.

Outside this repository: **no destructive actions** (rm, mv, overwriting files) unless the file or directory was created by Claude in the current session and needs to be corrected. If in doubt, stop and ask.

The `gp_xero_cfo` project at `~/koodi/gp_xero_cfo/` may be **read** for bootstrapping patterns, but never modified or deleted.

## Bootstrap source

`~/koodi/gp_xero_cfo/` contains the existing Xero read client, migrations, and `docs/accounting/intactix/` knowledge base. Copy what is useful; never import it at runtime.

## Database

Agent-owned DB: `intactix_agent_db` (local MySQL). PrestaShop GP EU DB: read-only via creds in `/var/www/gopure.shop/app/config/parameters.php` (live) or the staging equivalent.

## Key constraints from PLAN.md

- No Xero write scopes until Phase 3.
- All writes: draft-first, idempotency key, immutable audit log, confidence gate, kill switch.
- PrestaShop is authoritative for ship-to country and product/shipping split — Xero has neither.
- Auto-apply requires backtesting before any threshold is treated as a probability.
