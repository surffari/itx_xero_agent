# Intactix Accounting Change Log

## 2026-07-30 - Supplier Coding Defaults Corrected

Jani corrected the recurring supplier defaults and these now supersede conflicting older profile/rule notes:

- Brevo/Sendinblue: `000 Marketing Expense`, `TAX021` EU reverse charge.
- Atlassian, Cloudways/DigitalOcean, OpenAI/ChatGPT, Canva: outside-EU reverse charge (`INPUT`); Canva uses `000 Marketing Expense`.
- Front, Stamps.com, ShipStation, Cloudflare, ClickUp, Anthropic, VentraIP: `TAX023 No VAT`; Stamps.com and ShipStation use `409 Fulfillment Costs`.
- Microsoft: `422 Software/Service expense`, `TAX057` NL Standard VAT.
- Monta NL: `409 Fulfillment Costs`, `TAX057`; Monta DE remains review until exact German purchase VAT TaxType is confirmed/configured.
- GoCardless small fees and Revolut Company Pro plan: `404 Bank Fees`, `NONE Tax Exempt`; review GoCardless if future recurring fees look like payment gateway costs.
- DSV, Extremexports, and Tradethno are invoice-dependent review items. Active Ants is inactive.

## 2026-07-23 - Stamps.com Supplier Coding Corrected

Jani corrected the Stamps.com coding rule:

- Superseded 2026-07-30: use `409 Fulfillment Costs`
- Tax rate: `TAX023 No VAT`
- Do not use the previous prepayment treatment (`620 Prepayments` / `NONE`) for Stamps.com.

## 2026-06-22 - Phase 3 Complete: Write Layer

Write layer built. All writes are DRAFT-first; human approves in Xero UI. No auto-apply yet (Phase 4).

- `migrations/006_apply_tracking.sql` applied: `apply_status`, `xero_draft_id`, `applied_at` added to `reconciliation_ps_orphans`; `applied_at` added to `coding_proposals`.
- `src/presta/rest-pdf.ts`: PS webservice PDF client. Fetches `GET /api/order_invoices/{id}?output_format=PDF`. Non-blocking — returns null on any failure so invoice creation is never blocked.
- `src/xero/write-client.ts`: extended with `getInvoice`, `createBill`, `updateInvoiceCoding`, `attachPdf`, `checkPeriodLock`. All writes enforce kill switch (`XERO_WRITE_ENABLED`) and idempotency; period lock is warning-only for DRAFTs.
- `src/apply/orchestrator.ts`: `applyProposals(tenantId, proposalIds, opts)`. Proposal ID format: `accrec:<orphan_id>` → create DRAFT ACCREC invoice + attach PDF; `accpay:<coding_proposal_id>` → recode existing Xero bill. Existence check via live Xero API before every ACCREC create.
- `src/mcp/server.ts`: 4 new MCP tools: `apply_proposals`, `get_write_log`, `lookup_xero_contacts`, `attach_pdf_to_invoice`.
- `src/config.ts`: added `PS_WEBSERVICE_KEY`, `PS_WEBSERVICE_BASE_URL`.
- `.env.example`: updated with PS webservice vars and Phase 3 Xero scope instructions.

Prerequisites still required (user actions before first live write):
1. Create PS webservice key on gp_live (Admin → Advanced Parameters → Webservice → Add; needs `order_invoices` GET permission).
2. Add write scopes to Xero OAuth app: `accounting.transactions accounting.contacts accounting.attachments`.
3. Re-run OAuth consent flow to mint a new refresh token with write scopes.
4. Set `XERO_WRITE_ENABLED=true` in `.env`.

## 2026-06-21 - Phase 1 Complete: Reconciliation Engine + Learning Loop

Implemented the full Phase 1 learning loop. No Xero writes; all changes are local warehouse only.

- `migrations/004_learning_loop.sql` applied: `agent_rules`, `decision_queue`, `coding_proposals` tables created; `reconciliation_results` extended with confidence scores, proposed coding columns, bank-receipt linkage, and decision pointer.
- 16 active seed rules loaded (IAR-001 through IAR-014 from `rule-register.md`). Two ACCREC/SALES rules seeded but deactivated — `processOnlineSales()` uses `SALES_COUNTRY_RULES` directly; `applyRules()` is not called for ACCREC. All purchase rules (priority 100–130) locked to `ACCPAY` to prevent accidental ACCREC firing.
- `src/learn/rules.ts`: in-memory JS RegExp rule matching with 60 s TTL cache; `enqueueDecision` (idempotent INSERT IGNORE + SELECT), `answerDecision`, `promoteToRule` (invalidates cache).
- `src/reconcile/engine.ts`: `processOnlineSales()` — two-confidence scoring (match_confidence, tax_confidence), bank-receipt lookup via `xero_payments`; `processPurchaseBills()` — ACCPAY rule application, coding proposals written, low-confidence items enqueued.
- `src/mcp/server.ts`: 9 new MCP tools: `list_decision_queue`, `get_decision`, `answer_decision`, `promote_to_rule`, `list_rules`, `add_rule`, `deactivate_rule`, `test_rule_match`, `list_coding_proposals`.
- First smoke-test run (2026-01-01 → 2026-06-21): 221 ACCREC invoices, all matched (0 XERO_ONLY, 0 TAX_CODE queue items — data clean for the period), 1 ACCPAY coding proposal (Tradethno, conf 0.85, status proposed).

## 2026-06-20 - Phase 0 Complete: Independent Agent Skeleton

Built the standalone `intactix_accounting_agent` project — zero runtime dependency on `gp_xero_cfo`.

- `package.json`, `tsconfig.json`, `src/config.ts`, `src/db/mysql.ts`, `src/presta/pool.ts`.
- Xero read client + OAuth token refresh (`src/xero/`): contacts, invoices, bank transactions, payments, tax rates synced to local warehouse.
- Migrations 001–003: core schema (contacts, invoices, invoice_balances, bank transactions, payments, tax rates, reconciliation tables, write-log/audit).
- `src/mcp/server.ts`: initial MCP server with `sync_xero`, `reconcile_period`, `get_reconciliation_status`, `list_reconciliation_runs` tools.
- Knowledge base ported from `gp_xero_cfo/docs/accounting/intactix/` into `knowledge/`.
- `src/xero/invoice-builder.ts`: COUNTRY_RULES verified against ~600 matched invoices.

## 2026-05-11 - Trade-Intactix Workbook Import Added

Added a repeatable import path for `docs/accounting/intactix/Trade-Intactix costs and sales.xlsx`.

- Workbook rows are imported into `external_management_adjustments` as management-only `TTW-*` rows, not into official Xero-derived tables.
- Source currency is preserved and every row is normalised to EUR using daily FX rates cached in `external_fx_rates`.
- Exact duplicate workbook rows are skipped; fulfilment payment rows are skipped when a payable invoice row represents the same economic item.
- VAT settlement rows remain non-P&L but are subtracted in the transition revenue overlay by inferred VAT period.
- Matching older `TTD-*` draft rows are marked `excluded` when superseded by workbook-backed rows.

## 2026-05-11 - Tradethno Transition Overlay Rule Added

Recorded the management-reporting rule for Tradethno transition-period activity:

- These rows must not be brought into official Intactix Xero accounting.
- Store them in `external_management_adjustments` only.
- Keep existing official/default analysis clean.
- Include them only through explicitly named management transition views.
- Treat VAT settlements and intercompany transfers as non-P&L unless a specific reviewed adjustment says otherwise.

## 2026-05-11 - Tradethno Transition Draft Rows Imported

Imported the user-provided Tradethno transition transaction list into `external_management_adjustments` as draft-only rows through `008_tradethno_transition_draft_import.sql`.

Recorded 72 draft rows covering customer refunds, VAT settlements, VAT filing services, the VAT fine, owner/professional services, intercompany settlements, and Monta fulfilment payments.

No rows were approved and no `pnl_amount` values were populated, so the transition overlay does not affect analysis until specific rows are reviewed and activated.

## 2026-05-10 - Initial Knowledge Base

Created the accounting documentation structure after reviewing `reports/intactix-accounting-qa-review-2026-05-10.md` and the user's notes.

Recorded:

- Current practice for export sales, EU OSS sales, owner billing, freelancers, fulfilment, freight, suspense, general expenses, payment processing, bank coding, and unused accounts.
- Known report caveat that current-state QA should exclude `DELETED` and `VOIDED` rows.
- Mollie recently shut Intactix down; Intactix currently has no card processing.
- Open accountant and business questions needed before changing tax treatment, inventory/COGS policy, related-party handling, and chart-of-accounts structure.

No Xero changes were made. No database mutations were made.

## 2026-05-10 - Biggest Setup Concerns Updated

Recorded owner answers for chart cleanup and inventory:

- Unused no-transaction accounts are likely not needed active.
- Likely unused expense accounts can be reviewed for archive/hide.
- Revolut is currently only used for B2C bank-transfer receipts, not merchant acquiring.
- Intactix does not currently use accounting-level inventory tracking in Xero.
- Near-term recommendation is simple COGS coding plus lightweight stock evidence outside Xero, with accountant review for periodic stock-on-hand adjustments if material.

## 2026-05-10 - Missing Account Coding Updated

Recorded owner decision for Tradethno `INV-0172` and raw material/product purchase coding:

- `INV-0172` / `M.Speciosa (GP0326EU)` was confirmed as a partly paid raw material/product purchase from Tradethno for kratom.
- It was not a sale to Tradethno, not an offset, and not an owner/related-party settlement.
- Xero action taken by owner: remove and redo to `310 Cost of Goods Sold` with `No VAT`.
- VA action pending: re-reconcile the partly paid bill.
- Operating rule: raw material/product purchases go to `310 Cost of Goods Sold` for now. Accountant review remains only for whether material unsold inventory needs periodic stock-on-hand adjustments.

## 2026-05-10 - Tradethno Contact Control Added

Recorded CFO recommendation for Tradethno's dual customer/supplier role:

- Split Xero contacts prospectively into `Tradethno pte. ltd. - Customer` and `Tradethno pte. ltd. - Supplier`, unless the accountant objects.
- Use the customer contact only for export sales and customer receipts.
- Use the supplier contact for raw material/product supplier bills, partial supplier payments, and related-party supplier reconciliations.
- Do not rewrite historical transactions only to split the contact.

## 2026-05-10 - Catch-All Account Policy Updated

Recorded concrete catch-all account decisions:

- Kuura `850 Suspense` rows on 2026-02-03 are not a P&L problem if the EUR 169.57 charge and refund fully offset. Do not recode one side only; confirm/match/annotate the refund pair.
- Travel and meals should be coded precisely for tax deductibility and management reporting, even when small.
- Existing accounts should be used for most `429` cleanup: `493 Travel - National`, `494 Travel - International`, `421 Meals and entertainment`, `450 Hosting & Infrastructure`, `422 Software/Service expense`, `485 Subscriptions & Services`, `453 Office & Compliance Costs`, `425 Freight & Courier`, and `430 Research and Product Development`.
- A new import duties/customs account is optional only if import duties become recurring/material and the accountant wants separate tracking.

## 2026-05-10 - Chart Decisions Updated

Recorded chart-of-accounts decisions:

- Do not reopen old 2024 unreconciled/suspense items from this local audit unless live Xero shows a real current issue.
- `200 Export Sales` is sales-only; purchases posted to `200` are always wrong.
- Old `002 Freelancer & Contractor Costs` has been changed to `480 Contractor & Freelance Services`.
- Contractor tax code variation is expected because supplier location and VAT registration status differ, and Fiverr/Upwork treatment changed recently.
- Rename `705 Owner Billing` to `705 Owner / Related Entity Services`.
- `850 Suspense` is okay as reviewed; future anomalies should still be reported.
- `429 General Business Expenses` cleanup is handled by the concrete recoding table.
- Created `accountant-questions-2026-05-10.md` to gather accountant/bookkeeper questions in one place.

## 2026-05-10 - Bank Account Codes Clarified

Recorded Xero approach for Wise/Revolut bank accounts without codes:

- This is chart/reporting hygiene, not a reconciliation or transaction recoding issue.
- Best practice is to assign codes to Bank-type accounts through Chart of Accounts export/import or individual account edit if available in the Xero UI.
- Recommended codes: `100` Wise EUR, `101` Wise USD, `102` Wise GBP, `110` Revolut EUR Main, `111` Revolut USD Main, `112` Revolut GBP Main.
- `Revolut EUR` has only one local transaction line and should be reviewed as possible duplicate/legacy before assigning `109` or archiving.

## 2026-05-10 - Bank Account Codes Updated In Xero

Recorded completed bank account code changes:

- `100` Wise EUR
- `101` Wise USD
- `102` Wise GBP
- `110` Revolut EUR Main
- `111` Revolut USD Main
- `112` Revolut GBP Main
- `120` Finsei (AltPay), new seldom used bank account

## 2026-05-10 - Tax And Contractor Updates

Recorded tax-code and chart updates:

- `207 EU Sales`: EU ecommerce tax rates are set manually based on shipping country; this is a candidate for automation.
- `705`: Green Goddess is Finnish and EU VAT registered, so EU reverse charge (`TAX021`) is current rule. Extremexports is Australian and Tradethno is Singaporean.
- `405`: Mollie charges Dutch VAT at 21%; future processor fees continue to use `405 Payment GW Fees` with provider-specific tax treatment.
- Old `002 Freelancer & Contractor Costs` has been changed to `480 Contractor & Freelance Services`.
- `TAX030` is `(DO NOT USE - OLD) VAT On Sales in EE 20%`, effective rate 20%.
- No active material uncoded supplier bills remain after filtering deleted/voided rows; current active no-code/no-tax material rows are bank transfer mechanics and zero-value rows are mostly ecommerce shipping placeholders.

## 2026-05-10 - VespaEx Coding Clarified

Recorded VespaEx supplier coding rule:

- VespaEx bill `2024000062` is the good pattern: products to `310`, shipping/insurance to `425`, packing/repacking service to `411`.
- VespaEx bank transaction `2024001215` on 2025-01-31 for EUR 2,126.35 is coded directly to `310`. This is not automatically wrong, but source invoice detail is missing from the ledger line.
- Action: find/attach invoice `2024001215`; leave as `310` if it is purely product/goods, split if it includes freight/insurance/packing.
- Future rule: enter supplier bills with line detail first, then reconcile bank payments to the bill.

## 2026-05-10 - Cost Structure And Future Actions Updated

Recorded cost-structure clarifications and future action artifacts:

- “Deleted Tradethno rows” in unclassified spend refers to the deleted USD 15,000 Tradethno bill and revenue rows incorrectly shown as spend by analytics. There is no current Xero correction from that wording.
- Green Goddess owner billing should not be questioned as marketing/ad spend.
- Shipping subsidy deferred until ecommerce order/payment/shipping data is imported.
- Priority action plan updated: `INV-0172`, bank codes, and current suspense review are done/current; supplier tax matrix, `429` cleanup, archive review, and ecommerce data import remain future work.
- Added `future-action-plan.md`.
- Added `order-payment-shipping-import-prompt.md`.
