# Intactix Accounting Open Questions

Snapshot date: 2026-05-10

## Accountant / Bookkeeper

1. Intactix currently has no Xero inventory tracking and uses simple purchase-to-sale accounting. Product/raw material purchases are now coded to `310 Cost of Goods Sold`; should periodic stock-on-hand adjustments be posted for material unsold inventory?
2. Should inbound freight, inter-fulfilment-centre freight, duties, and insurance be capitalised into landed cost, or kept separately in `425 Freight & Courier`?
3. `705 Owner Billing` will remain separate and be renamed to `Owner / Related Entity Services`. Accountant to confirm whether any additional related-party disclosure/tracking is needed.
4. Should owner-related entity transactions be tracked with additional related-party notes, tracking categories, or management reporting fields?
5. What tax code should be used for non-EU contractor/service suppliers such as Paulo, Henny/Suhenny, Designwithpash, and some Fiverr-style purchases: `TAX023 No VAT`, `INPUT Tax on Purchases under Reverse charge (Outside EU)`, or another code?
6. Should Upwork/Fiverr platform fees and freelancer labour use the same tax treatment, or should platform invoices be separated from direct non-EU contractor invoices?
7. For EU contractor/service suppliers, confirm `TAX021 Tax on purchases under Reverse Charge (EU)`.
8. For Green Goddess Consulting as a Finnish entity, confirm `TAX021` remains correct.
9. For Tradethno and Extremexports as non-EU entities, confirm `TAX023 No VAT`/outside-EU treatment for purchases and `TAX011 Export Sales - NA` for sales.
10. EU ecommerce tax rates on `207 EU Sales` are set manually based on shipping country. Candidate automation: set the Xero tax rate from shipping country before invoice creation/import review.
11. Intactix likely does not need unused active accounts. Which system/control accounts must remain active, and can unused default expense/special accounts be archived/hidden?
12. Bank account codes are now set for Wise, Revolut, and Finsei. No further action unless a duplicate/legacy bank account reappears.
13. Should `420 Entertainment` and `421 Meals and entertainment` remain separate for Dutch tax deductibility/business-purpose reasons?
14. Should an explicit import duties/customs account be created, or should import duties be included in product cost/freight?
15. The old `002 Freelancer & Contractor Costs` account has been changed to `480 Contractor & Freelance Services`. Accountant/bookkeeper to confirm whether any non-contractor lines inside the old account should be separately recoded by nature.

## Business Owners

1. For Tradethno invoice `INV-0172` / `M.Speciosa (GP0326EU)`, complete VA re-reconciliation after remove and redo to `310 Cost of Goods Sold` with `No VAT`.
2. Is the 2026-03-18 deleted USD 15,000 Tradethno bill only a deleted duplicate/mistake, or does an active equivalent still exist in Xero?
3. Implement separate prospective Xero contacts for Tradethno: `Tradethno pte. ltd. - Customer` and `Tradethno pte. ltd. - Supplier`, unless the accountant objects.
4. Should Green Goddess historical lines in the former `002` / now `480 Contractor & Freelance Services` remain historical, or should they be reclassified to `705` for comparability?
5. Should Paulo/Henny/Upwork/Fiverr work be analysed only as contractor labour, or split into roles such as customer support, fulfilment support, web development, creative, and admin?
6. Kuura normal ecommerce service spend is currently treated as `485 Subscriptions & Services`; the reviewed `850` charge/refund pair is okay if fully offset. Remaining decision only if Kuura services should be split into a more specific ecommerce/platform account later.
7. For `429 General Business Expenses`, travel and meals are decided: code precisely. Remaining business decision is whether any other recurring catch-all categories need new supplier rules or new accounts.
8. For marketing spend, what revenue or contribution-margin target should be used? Current reports cannot judge whether EUR 3,000/month is high without channel attribution, CAC, gross margin, or incremental revenue data.
9. For shipping subsidy, can monthly or order-level ecommerce data provide shipping charged to customers, carrier cost, fulfilment cost, order count, country, and carrier?
10. Which new card processor is being considered after Mollie, and can we capture processor/order/payment-method data from day one?

## Analytics / AI System

1. ~~Update current-state reports to exclude `DELETED` and `VOIDED` rows unless explicitly producing a historical audit trail.~~ **Done** — reconciliation engine filters `status NOT IN ('DELETED','VOIDED')` for all ACCREC and ACCPAY processing (2026-06-21).
2. ~~Add rule tests for current high-value supplier/account mappings: Tradethno, Green Goddess, Extremexports, Active Ants, Monta, DSV, VespaEx, Kuura, Mollie, Paulo, Upwork, Fiverr.~~ **Done** — 16 seed rules in `agent_rules` table covering all listed suppliers; testable via `test_rule_match` MCP tool (2026-06-21).
3. Add an account review report for `850 Suspense` and `429 General Business Expenses`. — Partially addressed: seed rules "Suspense account flag" (conf 0.10) and "General business expenses review" (conf 0.40) will enqueue these items in the decision queue when the agent encounters them. Formal report TBD.
4. Add a tax-code consistency report grouped by supplier/contact, account, and country. — Tax-code proposals are now generated per bill via `coding_proposals`; a formal summary report is Phase 2.
5. Add processor-level ecommerce imports before comparing payment fees to processed revenue.
6. Add order-level shipping/fulfilment imports before deciding if customers are charged enough for shipping.

## Phase 2 Investigations (complete 2026-06-21)

1. **OSS VAT in Xero** — **Resolved.** Xero Sales Tax Report is the OSS filing source. Per-country tax codes (TAX005, TAX008, etc.) in Xero are the correct and sufficient structure. No tracking categories or structural changes needed. See `knowledge/phase2-oss-vat.md`.

2. **Canonical PS↔Xero match key** — **Resolved.** Primary key: `ps_orders.reference` ↔ `xero_invoice_balances.reference`. Secondary: invoice number alignment. Payment link: `xero_payments.source_id = invoice_id`. Validated on 221 invoices (0 unresolved). See `knowledge/phase2-match-key.md`.

3. **PS PDF attach** — **Resolved.** DB for all structured data; PS Webservice REST (`/api/order_invoices/{id}?output_format=PDF&ws_key=KEY`) for invoice PDFs only. Requires `PS_WEBSERVICE_KEY` in .env and `accounting.attachments` Xero scope in Phase 3. See `knowledge/phase2-ps-access.md`.

4. **BANK_SPEND coding proposals**: `finance_transaction_lines` shape for bank transactions needs investigation before reliable BANK_SPEND coding queries can be written. — **Still open; deferred to Phase 3.**

## VAT Rate Open Questions (accountant required)

Found during 2026-06-21 Xero rate audit. 68 rates synced from Xero. Most EU countries now have both STD and RDC rates.

1. **Reduced vs standard rate for products** — Several countries have only RDC rates in Xero (FR 5.5%, DE 7%, AT 10%, BE 12%, IE 0%) and others have both STD and RDC (ES, IT, PT, SE, NL). Which VAT category do Intactix's products (botanicals/kratom) fall under per country? This determines whether the existing reduced-rate mappings are correct or should switch to STD.

2. **IE zero-rate** — TAX018 (0%) is the current IE mapping; TAX036 (23%) also exists. If products are not genuinely zero-rated in Ireland (e.g., not oral medicines/food), all IE invoices are understating VAT.

3. **EE ambiguity** — TAX060 (22%) and TAX061 (24% STD named) both exist in Xero. EE raised from 20%→22% Jan 2024; a further 24% increase may have taken effect in 2025. Accountant to confirm current rate and which taxType to use. EE is currently left `null` in code until resolved.

4. **SK Xero mismatch** — TAX046 "VAT On Sales SK STD 20%" has `effective_rate = 20%` but Slovak standard rate is 23% since Jan 2025. The Xero tax rate needs to be edited to 23%. Until fixed, `audit_vat_rates` will report XERO_PS_MISMATCH for any SK orders.

5. **HR standard rate missing** — Only TAX035 (RDC 13%) exists for Croatia; standard HR rate is 25%. Code uses TAX035 as fallback. If Intactix has standard-rate HR orders, a new Xero rate (HR STD 25%) should be created.

6. **LT historical invoices** — LT was coded as export (TAX011/account 200) prior to 2026-06-21. Xero now has LT STD TAX059 (21%). If any historical LT B2C sales were coded as export, OSS output VAT was under-reported and correction may be needed.

---

## Phase 2 Gaps Found (action required in Phase 3)

1. **COUNTRY_RULES incomplete** — ~~Only 13 EU countries mapped.~~ **Addressed (2026-06-21)**: `COUNTRY_VAT_RULES` in `src/vat/rates.ts` now covers all 27 EU members + GB. Countries without a Xero tax rate yet have `taxType: null`; the `audit_vat_rates` tool raises MISSING_XERO_RATE when PS orders are found for those countries. `knowledge/country-vat.md` has the full rate table with verification status.

2. **Lithuania (LT) miscoded as export** — LT was in `COUNTRY_RULES` as `TAX011` (export, account 200). **Corrected in code (2026-06-21)**: LT now has `taxType: null` / account 207 (EU OSS). Invoice builder will flag LT orders as `MISSING_XERO_RATE` until a Xero LT rate is created. **Action still required with accountant:** check historical LT invoices; if any were B2C, OSS output VAT was under-reported and correction may be needed.

3. **GBP order FX** — Verify whether `ps_orders.conversion_rate` reliably provides EUR equivalent for GBP orders. If yes, the invoice builder can auto-compute EUR without human input for most GBP orders.

4. **PS Webservice API key** — Needed for Phase 3 PDF attach. Add `PS_WEBSERVICE_KEY` and `PS_WEBSERVICE_BASE_URL` to `.env` and config schema before PDF workflow is built.
