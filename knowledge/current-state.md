# Intactix Accounting Current State

Snapshot date: 2026-05-10 (accounting context)
Agent status updated: 2026-06-21

## Agent Status (2026-06-24)

The `intactix_accounting_agent` is operational at Phase 3/4. Xero writes are enabled (`XERO_WRITE_ENABLED=true`). OAuth token has write scopes and `files.read`. Xero Finance API statement-line access is gated and not available for this tenant/app, so unreconciled bank/card visibility now comes from direct Wise/Revolut feeds.

**Warehouse**: `intactix_agent_db` on local MySQL. Synced via MCP sync tools. Contains: contacts, invoices (ACCREC + ACCPAY), bank transactions, payments, tax rates, reconciliation runs/results, spend orphans, inbox files, and bank statement/feed lines imported from Wise/Revolut.

**Session start protocol**: call `list_sync_runs` first. Run `sync_incremental` if no sync in the last 24 hours or if the warehouse is empty. Then run `detect_missing_supplier_receipts` (replaces the old two-step `detect_spend_orphans` + manual statement check) and `poll_mailbox_inbox` to catch up.

**Bills Management mailbox (2026-08-20)**: `xero@intactix.io` (MXRoute IMAP, read-only) is now the PRIMARY supplier-invoice entry point, replacing the Xero Files inbox as the controlled source. `poll_mailbox_inbox` discovers new PDF attachments (deduped by IMAP UID in `mailbox_invoice_files`, never marks/moves/deletes mail), `download_mailbox_attachment` reads one, `create_bill_from_mailbox_file` creates the DRAFT ACCPAY bill and attaches the PDF — always draft-first, human review required in Xero before posting. `poll_xero_inbox` / `xero_inbox_files` / the Xero Files inbox remain as a legacy fallback only; do not treat it as the primary source going forward.

**Write capabilities (all draft-first)**:
- `apply_proposals` with `accrec:N` — creates DRAFT ACCREC invoice in Xero for PS orphan orders, attaches PS invoice PDF
- `apply_proposals` with `accpay:N` — recodes an existing ACCPAY bill to proposed account/tax code
- `create_bill_from_mailbox_file` — creates DRAFT ACCPAY bill directly from a mailbox-sourced supplier invoice PDF
- `apply_inbox_match` — creates DRAFT ACCPAY bill from a legacy Xero Files inbox receipt matched to a spend orphan

**Spend / receipt workflow (UPDATED — mailbox is now primary; still covers raw bank feed lines)**:
1. `sync_incremental` pulls Xero plus Wise/Revolut feeds. Use `sync_wise_activities` or `sync_revolut_transactions` individually when testing one provider.
2. `detect_missing_supplier_receipts` — unified detection across BOTH Xero bank transactions and statement lines
3. `list_supporting_document_missing_queue` — view all debit lines needing a receipt
4. User/cardholder emails receipt to `xero@intactix.io` → `poll_mailbox_inbox`
5. `download_mailbox_attachment`, extract supplier/amount/currency/date, check for duplicates (built into `create_bill_from_mailbox_file`'s reference/invoice_number lookup)
6. `create_bill_from_mailbox_file` (dry_run=true first) — create DRAFT ACCPAY bill; pass `reference="SPEND:<xero_bank_tx_id>"` when chasing a specific card-spend line so it matches `bank_spend_orphans`/dedup conventions

Wise cardholders: Jani (card 7237), Mari (card 3826) — see `knowledge/cardholder-profiles.md`.

**Active seed rules**: 16 ACCPAY rules covering Tradethno, VespaEx, Active Ants, Monta, DSV, Paulo Tomas, Suhenny/Henny, Upwork, Fiverr, Green Goddess, Extremexports, Mollie, Suspense-850 flag, General-429-review flag, Travel flag, Meals flag.

## Bank Feed Statement Lines (2026-06-24)

**Problem solved**: The standard Xero Accounting API `BankTransactions` endpoint only returns transactions that have been **coded** in Xero. Raw unreconciled bank-feed lines sitting in the reconciliation screen (e.g. the Kvk.nl EUR 3.10 card spend from 2026-04-21) are NOT returned by that endpoint, so the old `detect_spend_orphans` tool falsely reported zero unmatched spend.

**Current solution**: Direct bank-provider feeds populate the same local `xero_bank_statement_lines` table:
- Wise: `sync_wise_activities` imports card payments.
- Revolut: `sync_revolut_transactions` imports EUR/GBP/USD Main transactions through the broker HMAC token flow.
- `sync_incremental` now runs Xero, Wise, and Revolut together when the required provider credentials are available.
- Xero remains the accounting system for draft bills/invoices/attachments. Human accepts the proposed matches in Xero manually for now.

**Revolut note**: the code uses `REVOLUT_BROKER_HMAC`; the broker manages access tokens and refresh-token rotation. If the Revolut refresh token is stale, re-authorise in the Revolut Business portal or generate a new refresh token. The fixed broker should persist future rotated refresh tokens to `~/private_html/revolut_refresh_token.txt`.

**What does NOT work**:
- `GET /api.xro/2.0/BankStatements` — 404, no such Accounting API endpoint
- `GET /api.xro/2.0/Reports/BankStatement` — 401, requires `accounting.reports.read` scope (different from the three specific report scopes we hold)
- Xero Finance API / Bank Statements Plus is gated for this tenant/app, so it is not a dependable source for unreconciled lines here.

**Warehouse table**: `xero_bank_statement_lines` (migration 008). Columns include `statement_line_id`, `bank_account_id`, `transaction_date`, `payee`, `reference`, `notes`, `amount`, `type` (Debit/Credit), `is_reconciled`, `import_source`, `raw_payload`.

**Classification logic** (`src/reconcile/statement-orphans.ts`):
- `no_doc_required` — payee/reference/notes matches fee patterns (bank fee, card fee, FX conversion fee, etc.) → auto-dismissed
- `document_missing` → enqueued in decision queue as `STMT_ORPHAN:{statementLineId}`, status `chasing`
- `already_tracked` — orphan exists in non-open status

**Bank accounts in Xero** (for provider-feed mapping):
- Wise EUR: `90da793e-42be-480b-b6c6-d610fb60c9b4`
- Wise USD: `0b8fbb1e-36b6-4813-a68b-3daae645e4b9`
- Wise GBP: `8fbef334-4f71-4e11-b369-305d67d72d3b`
- Revolut EUR Main: `f8c02cb4-1fa1-4e38-9e87-cd38229d8b78`
- Revolut USD Main: `8b2251e6-989c-4d00-84b1-ad0610b5b06b`
- Revolut GBP Main: `cad354c8-74ef-4adb-90af-0fc8c9cff6a4`
- Finsei: `376c81fd-31c6-4da5-8e51-b486a379cd42`

Primary source: `reports/intactix-accounting-qa-review-2026-05-10.md` plus local read-only SQL investigation.

## Context

Intactix B.V. sells ecommerce goods inside and outside the EU. EU sales use OSS/country-specific VAT rates. Non-EU sales are treated as export sales.

Tradethno is both a customer and supplier/related party. Green Goddess Consulting, Tradethno, and Extremexports are owner-related entities used to bill project work or business services to Intactix. The business wants to keep external workforce spend visibly separate from owner/entity project billing.

Recommended operational control for Tradethno: split Xero contacts prospectively into `Tradethno pte. ltd. - Customer` and `Tradethno pte. ltd. - Supplier` to reduce account/tax miscoding risk. Keep legal identity details clear on both contacts and do not rewrite history just for the contact split unless the accountant requests it.

Mollie was the card processor until it recently shut Intactix down. Intactix currently has no card processing. Historical Mollie activity remains important for comparing payment processing fees to sales and for choosing a replacement processor.

Bank transfer customers are usually handled one-to-one: the customer pays by bank transfer, the online shop invoice is attached, and the payment is reconciled to that invoice. Historical Mollie settlements were weekly lump settlements covering many processed orders, reconciled against multiple invoices.

Bank ledger account codes are now set for Wise, Revolut, and Finsei (AltPay): `100` Wise EUR, `101` Wise USD, `102` Wise GBP, `110` Revolut EUR Main, `111` Revolut USD Main, `112` Revolut GBP Main, and `120` Finsei (AltPay). Finsei is a new seldom used bank account.

## Current Reporting Cautions

The 2026-05-10 QA report mixed current and historical/deleted Xero objects in some sections. The local warehouse contains `DELETED` and `VOIDED` objects for auditability. That is useful evidence, but it can make reports look worse than current Xero.

Important example: the old unreconciled Wise EUR total in the report was mostly deleted rows:

- Wise EUR unreconciled total in local warehouse: 126 lines, EUR 29,353.41.
- Of that, deleted rows: 119 lines, EUR 27,172.84.
- Current authorised unreconciled Wise EUR rows in the local warehouse: 7 lines, EUR 1,580.57, oldest 2024-07-25.

If Xero currently shows those periods fully reconciled, Xero is the reconciliation source of truth. The local warehouse should be resynced or the report logic should filter out `DELETED` and `VOIDED` rows for current-state QA.

## Reconciliation Practice

No urgent concern is normally assigned to unreconciled transactions that are within the current financial quarter plus one month. These are expected to be reconciled by Dutch OSS/BTW/VAT filing deadlines.

Older unreconciled items should be investigated only if they are still unreconciled in live Xero and are not deleted/voided historical artifacts in the warehouse.

## Current Account Usage Principles

Product/raw material purchases for resale should not be posted to revenue. Current practical policy is simple accounting without Xero inventory tracking: purchases go to `310 Cost of Goods Sold`, with accountant review only on whether periodic stock-on-hand adjustments are needed for material unsold inventory.

Fulfilment centre operating fees are currently treated as fulfilment costs. Shipping goods from one fulfilment centre to another is usually treated as freight/courier.

External VAs, freelancers, Upwork, Fiverr, Paulo Tomas, and Henny/Suhenny-style support work are contractor/freelancer costs. The old `002 Freelancer & Contractor Costs` account has been changed to `480 Contractor & Freelance Services`.

Owner-related project work is currently grouped in `705 Owner Billing` when billed through owner-related entities. The approved target name is `705 Owner / Related Entity Services`. Earlier Green Goddess lines were sometimes posted to former `002` / current `480 Contractor & Freelance Services`; this should be treated as historical drift unless the accountant wants the split changed.

`850 Suspense` is intended for temporary clearing only, especially matched card checks, refunds, and reversed/pending transactions. It should not hold recurring operating activity. Current reviewed `850` items are considered okay as of now; future anomalies should be reported when they are not obvious matched refunds, card checks, or short-lived pending reversals.

`429 General Business Expenses` is a catch-all. It is acceptable only when a more specific account is not available or the amount is immaterial. Travel and meals should still be coded precisely for tax deductibility and management reporting. Recurring software, travel, meals, freight, office/compliance, hosting, and product development should be coded to specific accounts.

## Current Tax Principles To Confirm

EU ecommerce sales use OSS/country-specific VAT rates. Therefore, `207 EU Sales` using many different country VAT tax codes is expected and not automatically an error. Tax rates are currently set manually based on shipping country; this is a candidate for automation.

Non-EU sales use export/no-VAT treatment.

Green Goddess is a Finnish EU VAT registered entity and currently uses EU reverse charge purchase treatment (`TAX021`) when billing Intactix.

Tradethno is a Singapore entity and Extremexports is an Australian entity. They currently use no-VAT/export/no-VAT style treatment depending on whether the transaction is sales or purchases.

Most non-EU contractor purchases currently use `TAX023 No VAT`; Upwork/Fiverr examples use `INPUT Tax on Purchases under Reverse charge (Outside EU)`. This is inconsistent and needs accountant confirmation.
