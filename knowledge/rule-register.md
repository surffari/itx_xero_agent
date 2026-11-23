# Intactix Accounting Rule Register

Status values:

- `Current`: describes current practice.
- `Proposed`: recommended but not yet approved.
- `Needs accountant`: requires accountant/bookkeeper decision before implementation.
- `Report fix`: change needed in the local analytics layer, not necessarily in Xero.

## IAR-001 - Export Sales

Status: Current  
Applies to: `200 Export Sales`  
Tax treatment: non-EU/export sales, usually `TAX011 Export Sales - NA`

Rule:

Non-EU customer sales are posted to `200 Export Sales`. Bank-transfer customer receipts may appear as bank transaction lines against export sales when matched/reconciled to an invoice. `200` is sales-only: any purchase, supplier bill, raw material/product cost, owner service bill, or other spend posted to `200` is wrong.

Why:

The business sells outside the EU and treats those sales separately from EU OSS sales.

Risk:

Supplier bills or product purchases must not be posted to `200 Export Sales`. Tradethno creates ambiguity because it is both customer and supplier/related party.

Evidence:

- Tradethno sales/income examples in `200 Export Sales` are common.
- One problematic authorised bill on 2026-03-08, invoice `INV-0172`, contact `Tradethno pte. ltd.`, description `M.Speciosa (GP0326EU)`, amount EUR 19,286.96, was posted to `200 Export Sales`. It has now been corrected through remove and redo to `310 Cost of Goods Sold` with `No VAT`; VA re-reconciliation is pending.

Required action:

Correct supplier/product purchase bills out of revenue and into `310 Cost of Goods Sold`, unless the accountant later defines a formal inventory adjustment process.

## IAR-002 - EU OSS Sales

Status: Current  
Applies to: `207 EU/Domestic Online Sales`

Rule:

EU/domestic ecommerce sales use destination-country VAT rates. Different EU VAT tax codes on `207 EU/Domestic Online Sales` are expected, including NL domestic VAT on `TAX008`.

Why:

Intactix sells to multiple EU countries and applies country/default product VAT rates.

Risk:

The Xero account default on `207 EU/Domestic Online Sales` is `TAX023 No VAT`, while current lines use many country VAT rates. This is not automatically wrong if the import/automation sets the line tax code correctly. It becomes risky if any manual or automated transaction relies on the account default.

Required action:

EU ecommerce tax rates are currently set manually based on shipping country. This is a candidate for automation. Add/import-control logic should set the Xero tax rate from shipping country; do not rely on the `207` account default.

## IAR-015 - Shipping Sales

Status: Current  
Applies to: `208 Shipping Sales`

Rule:

Shipping charged to customers on GoPure online purchases is posted to `208 Shipping Sales`, not to the product sales account (`200`, `207`, or `235`). The shipping line still uses the destination-country TaxType from the online order country/VAT map. If shipping is free / zero, omit the Shipping line entirely.

Why:

Customer-charged shipping is revenue, but it needs its own account for margin and shipping-subsidy analysis. Keeping it separate from product/export/EU/NL sales prevents shipping income from being buried in product sales accounts while preserving the correct VAT treatment by destination.

Required action:

Invoice creation/import tooling must build customer shipping as a separate line with `AccountCode=208` whenever `total_shipping_tax_incl > 0`. Product lines continue to use the destination product sales account from the country map. Do not create zero-value Shipping lines because they block batch approval in Xero.

## IAR-003 - Raw Material And Product Purchases

Status: Current, with accountant review for period-end adjustments  
Applies to: Tradethno, VespaEx, product suppliers, raw materials for saleable products

Rule:

Raw materials and purchased products used to create or fill sellable products should not be posted to revenue. Current practical policy is to keep Xero simple and post these purchases to `310 Cost of Goods Sold`. Do not create a new raw material/product account yet unless the accountant recommends it.

Why:

Posting product/raw material purchases directly to revenue distorts sales, gross margin, and VAT/reporting review.

Current owner context:

Intactix does not currently use accounting-level inventory tracking in Xero. The business buys goods/raw materials and sells them, but has not maintained Xero as a stock ledger.

AI recommendation:

Do not implement full Xero inventory accounting until the business is ready to maintain reliable SKU, quantity, location, purchase cost, adjustment, and stock-count data. A pragmatic next step is to keep COGS coding in Xero while collecting lightweight stock evidence outside Xero. If inventory on hand becomes material, post accountant-approved month/quarter/year-end stock adjustments or use a dedicated stock/order system as the inventory subledger.

Evidence:

- VespaEx product lines are mostly in `310 Cost of Goods Sold`.
- Tradethno authorised bill `INV-0172` on 2026-03-08 for `M.Speciosa (GP0326EU)` was posted to `200 Export Sales`. It was confirmed as a partly paid kratom/raw-material purchase and has been changed through remove and redo to `310 Cost of Goods Sold` with `No VAT`; VA re-reconciliation is pending.
- A deleted Tradethno USD 15,000 no-code/no-tax bill exists on 2026-03-18; because it is deleted, it should not be treated as a current Xero correction unless live Xero still has an equivalent active transaction.

Open question:

Should the accountant post periodic stock-on-hand adjustments for material unsold inventory while the operating purchase coding remains `310 Cost of Goods Sold`?

## IAR-004 - Tradethno Dual-Role Contact Control

Status: Proposed operational control  
Applies to: Tradethno pte. ltd., customer sales, supplier bills, related-party transactions

Rule:

Use separate operational Xero contacts going forward:

- `Tradethno pte. ltd. - Customer` for customer invoices, export sales, and customer receipts.
- `Tradethno pte. ltd. - Supplier` for supplier bills, raw material/product purchases, partial supplier payments, and related-party supplier reconciliations.

Why:

Tradethno is both a customer and supplier/related party. One shared contact increases the chance that supplier bills are treated like customer/export sales. The `INV-0172` coding error is evidence that this risk is real, not theoretical.

Coding rule:

- Customer contact: sales flow only, usually `200 Export Sales`.
- Supplier contact, raw material/product bills: `310 Cost of Goods Sold`.
- Supplier contact, owner/related-party service bills: `705 Owner / Related Entity Services`.

Implementation note:

Apply prospectively. Do not rewrite historical transactions only to split the contact unless the accountant requests it. Keep the legal name and identifying details clear on both contacts so both can still be reviewed as one related legal entity when needed.

## IAR-005 - Fulfilment, Freight, Packaging, And Landed Cost Split

Status: Current with supplier corrections from 2026-07-30  
Applies to: Monta, DSV, VespaEx, Stamps.com, ShipStation, freight/courier, fulfilment centre transfers

Rule:

Use:

- `409 Fulfillment Costs` for fulfilment centre operating charges, pick/pack service, warehousing, and FFC service fees.
- `425 Freight & Courier` for carrier freight, forwarding, international shipping, and goods moved from one FFC to another.
- `410 Packaging Material Cost` for packaging materials bought as supplies.
- `411 Packing/Handling Costs` for packing/repacking handling service charges.
- `310 Cost of Goods Sold` for products/raw materials.

Why:

This separates product cost, fulfilment labour/service, shipping/carrier cost, and packaging. That makes shipping subsidy and gross margin analysis possible.

Evidence:

- Active Ants is no longer active and should not be auto-coded; queue any new Active Ants item for review.
- Monta Enschede/Monta NL: `409 Fulfillment Costs`, `TAX057` NL Standard VAT.
- Monta DE: `409 Fulfillment Costs`; tax should be German Standard VAT, but queue until the exact Xero purchase TaxType is confirmed/configured.
- DSV current split: `425` EUR 2,797.96 across 15 lines.
- DSV is invoice-dependent: if hauling products or raw materials, review as COS/freight-in rather than ordinary courier. Tax depends on which country's DSV entity is employed.
- VespaEx bill `2024000062` splits products to `310`, shipping to `425`, and repacking service to `411`.
- VespaEx bank transaction `2024001215` on 2025-01-31 is a direct spend-money row for EUR 2,126.35 to `310`; this is acceptable only if the invoice is purely product/goods. If the invoice includes shipping/insurance/packing, it should be split into the relevant accounts.
- Stamps.com and ShipStation were corrected by Jani on 2026-07-30: code to `409 Fulfillment Costs` with `TAX023 No VAT`. Do not treat Stamps.com as prepaid postage/account credit under `620 Prepayments` / `NONE`.

Question:

Should inbound freight and inter-FFC freight be capitalised into landed product cost or kept as freight/courier expense? Current practice keeps it separate as freight/courier.

## IAR-006 - Freelancer And Contractor Costs

Status: Current, code changed  
Applies to: `480 Contractor & Freelance Services`, formerly `002 Freelancer & Contractor Costs`

Rule:

External VAs, Upwork, Fiverr, Paulo Tomas, Suhenny/Henny, and similar non-owner contractors are grouped as contractor/freelancer costs. Current chart account is `480 Contractor & Freelance Services`, changed from old code `002`.

Why:

The business wants a clear view of external workforce cost separate from owner/entity billing.

Evidence:

- Upwork: EUR 21,976.74 under reverse-charge outside-EU tax code, plus older `TAX023` usage.
- Paulo Tomas: EUR 21,332.90 mostly under `TAX023 No VAT`, plus older `INPUT` usage.
- Suhenny Dwi Purwasih: EUR 4,593.91 under `TAX023 No VAT`.

Risk:

The old account code `002` was unusual for an expense account. Different tax codes are expected when supplier location and VAT registration status differ. Direct VAs/freelancers are generally not EU VAT registered; Fiverr/Upwork now have EU VAT registration/platform treatment, and that changed recently.

Required action:

Use `480 Contractor & Freelance Services` going forward. Do not change historical tax codes as part of the account rename/recode; tax remains line-specific. Use Find & Recode only for transactions that were wrongly classified by nature, such as subscriptions or software purchases accidentally coded to contractor costs.

## IAR-007 - Owner Billing

Status: Current, rename approved  
Applies to: `705 Owner / Related Entity Services`, Green Goddess Consulting, Extremexports, Tradethno where billing owner/entity work

Rule:

Owner-related project work billed by owner-related entities is posted to `705 Owner / Related Entity Services`, separate from external contractor spend.

Why:

The business wants to see how much work is billed by owner-related entities versus external workforce.

Evidence:

- Green Goddess Consulting: `705 Owner Billing`, `TAX021`, EUR 64,395.76 across 21 lines.
- Extremexports pty. ltd.: `705 Owner Billing`, `TAX023`, EUR 5,861.38 across 2 lines.
- Green Goddess also appears historically in `002 Freelancer & Contractor Costs`, `TAX021`, EUR 9,248.36 across 3 early 2024 lines.

Recommendation:

Rename `705 Owner Billing` to `705 Owner / Related Entity Services`. This can be done through Xero's Accounting API account update endpoint for account ID `377e669c-25dc-46ef-a269-e5fec5c19388`, but the local integration currently has read-only `accounting.settings.read` scope and would need `accounting.settings` plus re-authorisation before it can write the update.

Open question:

Should these be treated only as ordinary contractor services, or separately disclosed/monitored as related-party transactions?

## IAR-008 - Payment Processing Fees

Status: Current, provider inactive  
Applies to: `405 Payment GW Fees`, Mollie, future card processors

Rule:

Payment processor fees are direct variable costs in `405 Payment GW Fees`. Historical Mollie fees remain in this account. New card processor fees should use the same account unless the accountant creates processor-specific accounts.

Why:

Payment fees reduce contribution margin and should be monitored against processed card revenue.

Evidence:

- Mollie fees in 2025-01 through 2026-04 total regular monthly amounts in `405`.
- Mollie shut Intactix down recently; there is currently no card processing.

Reporting note:

Current warehouse data can compare Mollie fees to total revenue by month, but not reliably to only Mollie-processed card revenue unless order/payment-source data is imported. Fee percentage against total revenue is useful but not the true processor fee rate.

Required action:

When a new processor is selected, capture payment method/processor at order level so processor fees can be analysed as a percentage of processed volume.

## IAR-009 - Suspense

Status: Current, okay as reviewed  
Applies to: `850 Suspense`

Rule:

Suspense is temporary only. It may hold card checks, refunds, failed/duplicated/pending transactions, and short-lived clearing items. It should not hold recurring subscriptions, fulfilment, supplier costs, or normal operating spend.

Why:

Suspense hides business cost categories and can create stale reconciliation noise.

Evidence:

- Kuura Solutions LLC has two authorised 2026-02-03 suspense lines: `Ecommerce Services` EUR 169.57 and `Ecommerce Services Refund` EUR 169.57.
- Fk Plus has deleted suspense rows in 2026; these are historical artifacts unless still live in Xero.
- UPS card-check items from 2024 are the only authorised old unreconciled suspense rows in the local warehouse.

Required action:

Treat `850` as okay as of this review. Clear current authorised suspense monthly. Charge/refund pairs may stay in `850` only when they fully offset and are documented or matched. Do not recode only one side of a fully refunded pair. Future anomalies should be reported when they are not obvious matched refunds, card checks, or short-lived pending reversals.

## IAR-010 - General Business Expenses

Status: Current with tightening needed  
Applies to: `429 General Business Expenses`

Rule:

Use `429` only as a true catch-all for immaterial or one-off items without a better account. Recode recurring or analytically important spend to specific accounts.

Travel and meals should be coded precisely for tax deductibility and management reporting. Do not leave travel or meal costs in `429` just because the amount is small.

Suggested coding:

- Hotels, transport, flights, parking, taxis: `493 Travel - National` or `494 Travel - International`.
- Meals and cafes: `421 Meals and entertainment`, based on accountant policy and attendee/business-purpose rules.
- Software/API/hosting tools: `422 Software/Service expense`, `450 Hosting & Infrastructure`, or `485 Subscriptions & Services`.
- Product development samples: `430 Research and Product Development`.
- Office/compliance/admin registrations: `453 Office & Compliance Costs`.
- Import duties/carrier import tax: `425 Freight & Courier`, `310 Cost of Goods Sold`, or new `426 Import Duties & Customs` if created after accountant approval.

Evidence examples:

- Van Gogh Hotel EUR 420.37 gross on 2026-03-25 should move from `429` to `493 Travel - National`.
- Finavia EUR 80.00 should move from `429` to `494 Travel - International`.
- Uber NL rides should move from `429` to `493 Travel - National`.
- Vof Visser De Roo, Blushing, and Bck*ns cafe/food rows should move from `429` to `421 Meals and entertainment` if business purpose exists.
- Google API/Cloud and Twilio should move from `429` to `450 Hosting & Infrastructure`.
- Prestashop should move from `429` to `422 Software/Service expense` or `485 Subscriptions & Services`, depending on whether it is one-off software or recurring subscription.
- Barcodes Mania should move from `429` to `453 Office & Compliance Costs`.
- Amazon headphones should move from `429` to `453 Office & Compliance Costs` unless accountant wants fixed asset treatment.
- Fedex import tax should move from `429` to `425 Freight & Courier` under the current chart. Create a separate import duties/customs account only if this becomes recurring/material and accountant wants separate tracking.

Required action:

Review `429` monthly and recode material or recurring lines. Travel and meals are always specific-code items.

## IAR-011 - Bank Account Codes

Status: Current, completed for active accounts  
Applies to: Wise, Revolut, and Finsei bank accounts

Rule:

Bank ledger accounts should have unique chart codes for reporting order and audit readability. This is reporting hygiene, not a reconciliation requirement.

Why:

Codes make reporting, filtering, and audit trails easier, especially with multiple currencies.

Current bank account codes:

| Code | Bank ledger account | Type | Tax | Notes |
|---|---|---|---|---|
| `100` | Wise EUR | Bank | Tax Exempt (0%) | Active |
| `101` | Wise USD | Bank | Tax Exempt (0%) | Active USD |
| `102` | Wise GBP | Bank | Tax Exempt (0%) | Active/legacy GBP |
| `110` | Revolut EUR Main | Bank | Tax Exempt (0%) | Active |
| `111` | Revolut USD Main | Bank | Tax Exempt (0%) | Active USD |
| `112` | Revolut GBP Main | Bank | Tax Exempt (0%) | Active GBP |
| `120` | Finsei (AltPay) | Bank | Tax Exempt (0%) | New, seldom used |

Xero best-practice action:

Use Chart of Accounts edit/export/import for bank account code maintenance. Do not use Find & Recode because transactions are not the problem. Archive duplicate/legacy bank accounts only after confirming they are not active bank feeds or reconciliation accounts.

## IAR-012 - Active Unused Accounts

Status: Current direction, needs accountant before Xero change  
Applies to: active Xero accounts with no synced transaction lines

Rule:

Unused active accounts can usually be archived/hidden if they are not system accounts, not needed for statutory reporting, not needed for future expected activity, and have no historical transactions.

Why:

A bloated chart increases miscoding risk and makes AI/accounting analysis less reliable.

Do not archive without accountant confirmation:

- System/control accounts such as accounts receivable/payable, sales tax, retained earnings, historical adjustment, rounding, payroll/liability control accounts.
- Fixed asset and accumulated depreciation accounts if the accountant expects future assets/depreciation.
- Inventory/prepayments if the inventory policy or accrual process will use them.

Candidate accounts for review:

- Unused expense accounts not expected to be used: Advertising, Cleaning, Insurance, Rent, Motor Vehicle Expenses, Telephone & Internet, Printing & Stationery, Repairs and Maintenance.
- Unused special accounts: Revolut Merchant Fees, Revolut Merchant Payments, Interest Income, Loan.

Owner context:

If these accounts have no transactions, Intactix likely does not need them active. Revolut is not currently used for merchant/card processing, only for receiving B2C bank-transfer funds. Archived accounts can likely be unarchived or recreated later if needed, subject to Xero/accountant constraints.

Required action:

Prepare an archive/hide list for accountant approval after checking live Xero history and system-account restrictions.

## IAR-013 - Deleted And Voided Rows In Analytics

Status: Report fix  
Applies to: audit reports, business category reports, unclassified spend, reconciliation health

Rule:

Current-state QA reports should exclude `DELETED` and `VOIDED` source rows by default. Historical/auditability reports may include them, but must label them clearly.

Why:

The 2026-05-10 audit overstated current reconciliation and no-code issues by including deleted objects.

Required action:

Update report/audit SQL to filter current-state findings with `status NOT IN ('DELETED','VOIDED')`, while retaining raw object history for drilldown.

## IAR-014 - Tradethno Transition Management Overlay

Status: Current management-reporting rule  
Applies to: Tradethno transition-period B2C sales receipts, refunds, Monta payments, product purchases, VAT settlements, bank/FX fees, and related misc transactions economically belonging to Intactix

Rule:

Do not bring these rows into official Intactix Xero accounting. Store them only in the local management overlay table `external_management_adjustments`.

Default accounting and finance analysis remains official-only. Tradethno transition rows are included only when a question or report explicitly asks for management analysis including Tradethno transition activity.

Implementation rule:

- Do not insert Tradethno transition rows into `finance_transaction_lines`, `xero_raw_objects`, or Xero.
- Do not insert these rows into `external_sales_monthly`, because that would make them part of normal revenue context.
- Use `status = 'draft'` while collecting/reviewing.
- Use `status = 'approved'` only for rows that should be available in the optional management overlay.
- Use `is_pnl = FALSE` for VAT liability settlements and intercompany settlements.
- Use explicit `management...with_transition...` views when including them.

Why:

The transition period was economically mixed, but the business does not want to reopen or contaminate Intactix accounting. The overlay preserves historic management comparability while keeping day-to-day analysis and official Xero-derived reporting clean.

Evidence:

Tradethno received or paid items that practically belonged to Intactix during the transition, including EUR/GBP B2C sales receipts, customer refunds, Monta fulfilment payments, product purchases, OSS/NL/DE VAT payments, VAT filing fees, and Wise fees.
