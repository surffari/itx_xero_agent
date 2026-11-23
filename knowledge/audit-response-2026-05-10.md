# Response To Annotated QA Review - 2026-05-10

Source: `reports/intactix-accounting-qa-review-2026-05-10.md`  
Data checked: local synced MySQL warehouse only  
Important caveat: live Xero remains the source of truth for current reconciliation state.

## Executive Conclusions

The highest-confidence real accounting issue was the authorised Tradethno bill on 2026-03-08 posted to `200 Export Sales`. It has now been confirmed as a raw material/product purchase and the owner direction is to use `310 Cost of Goods Sold` for now.

The biggest analytics/reporting issue is that the audit included `DELETED` and `VOIDED` rows. This explains much of the old unreconciled Wise concern and some no-code/no-tax concern. Current-state reports should filter those rows unless explicitly reviewing history.

The main rule gaps to document before changing Xero are:

- Whether accountant-level period-end inventory adjustments are needed on top of the current `310 Cost of Goods Sold` raw material/product purchase policy.
- Related-party/owner billing policy.
- Non-EU contractor VAT/tax-code policy.
- Fulfilment/freight/packaging/landed-cost split.
- Suspense and general expense cleanup practice.
- Payment processor reporting after Mollie.

## Biggest Accounting Setup Concerns

### Active Chart Is Bloated

Your question: is it feasible and recommendable to remove unused accounts? Can some be required by legislation?

Answer:

It is usually feasible to archive or hide unused active accounts, but it must be done selectively. Some accounts are system/control accounts or may be needed for statutory reporting, payroll, VAT, fixed assets, retained earnings, historical adjustments, accounts receivable/payable, or future inventory/prepayment workflows.

Do not remove/delete accounts casually. In Xero the usual action is archive/hide, not destructive removal.

Candidate review groups:

- Likely safe to review for archive if truly unused and not planned: Advertising, Cleaning, Insurance, Rent, Motor Vehicle Expenses, Telephone & Internet, Printing & Stationery, Repairs and Maintenance.
- Keep or accountant-confirm: Accounts Receivable, Accounts Payable, Sales Tax, Retained Earnings, Historical Adjustment, Rounding, fixed asset/depreciation accounts, Inventory, Prepayments, payroll/liability accounts.
- Revolut Merchant Fees and Revolut Merchant Payments can likely be archived/hidden for now. Revolut is currently used only for receiving B2C funds by bank transfer, not merchant acquiring/card processing. If Revolut merchant acquiring is used later, the accounts can likely be unarchived or recreated after accountant confirmation.

Owner answer recorded:

- If an account has no transactions, Intactix probably does not need it active.
- The unused expense accounts listed above are likely not used by the business.
- The control/default accounts listed above are probably part of the default Xero chart, so they should be reviewed more carefully before hiding.
- Intactix does not expect payroll, accounting-level fixed asset tracking, Revolut merchant acquiring, or prepayments to be meaningful in the next 12 months.
- Intactix does not currently use accounting-level inventory tracking in Xero.

Question:

Will Intactix use inventory accounting, payroll, fixed assets, Revolut merchant acquiring, or prepayments in the next 12 months?

Answer:

No for payroll, Revolut merchant acquiring, and current formal Xero inventory tracking. Fixed assets/prepayments are not expected to be material based on current practice. Inventory accounting has not been set up; Intactix currently buys goods/raw materials and sells them without Xero stock tracking.

AI recommendation on inventory:

Do not jump straight into full Xero inventory accounting unless the accountant recommends it and the business is ready to maintain product-level stock records. Full inventory accounting adds operational burden: product SKUs, stock quantities, purchase cost, stock adjustments, write-offs, period-end counts, and COGS release timing must stay accurate.

Recommended near-term approach:

- Keep the accounting simple: code product/raw material purchases to `310 Cost of Goods Sold`. If the accountant later says material unsold stock must be capitalised, handle that through a clear inventory/period-end adjustment process.
- Do not use `200 Export Sales` for raw material/product purchases.
- Start a lightweight management stock evidence process outside Xero: supplier invoice, batch/product, quantity, landed cost components, fulfilment centre/location, and month sold/used where known.
- Review quarterly whether stock on hand is material enough that accountant-level inventory adjustments are needed at period end.
- If inventory becomes material, use a dedicated inventory/order system or ecommerce/warehouse data as the stock subledger, then post monthly summary adjustments into Xero rather than trying to manage detailed inventory manually inside Xero.

Open accountant question:

Should quarter/year-end stock-on-hand adjustments be posted for material unsold inventory while day-to-day product/raw material purchases are coded to `310 Cost of Goods Sold`?

### Missing Account Coding

Your note: need better intel; check Tradethno coding.

Evidence:

- The material USD 15,000 Tradethno bill on 2026-03-18 is `DELETED` in the local warehouse. It has no account and no tax code.
- Because it is deleted, do not treat it as a current Xero correction unless an active equivalent exists in live Xero.
- The known real Tradethno problem was the authorised EUR 19,286.96 bill on 2026-03-08, invoice `INV-0172`, description `M.Speciosa (GP0326EU)`, posted to `200 Export Sales`.

Recommendation:

`INV-0172` has been handled in Xero with remove and redo. It should be coded to `310 Cost of Goods Sold` with the `No VAT` tax rate. The VA will re-reconcile the partly paid bill.

Question:

Was `INV-0172` a purchase from Tradethno, a sale to Tradethno, an offset, or a related-party settlement?

Answer:

`INV-0172` was a purchase from Tradethno for raw material/product, specifically kratom. It was partly paid. It was not a sale to Tradethno, not an offset, and not an owner/related-party settlement.

Current rule created from this:

Product and raw material purchases go to `310 Cost of Goods Sold` for now. Do not create a new product/raw-material account yet unless the accountant recommends a more detailed chart or a periodic inventory adjustment process.

### Revenue Account Used On Supplier/Bill Flow

Your note: need examples and recommendations on alternatives.

Evidence:

- `2026-03-08`, `BILL`, `AUTHORISED`, Tradethno pte. ltd., `INV-0172`, `M.Speciosa (GP0326EU)`, EUR 19,286.96, account `200 Export Sales`.
- Related deleted/voided context exists: a voided invoice `INV-0171` for the same amount and a deleted bank transaction on 2026-03-18.

Recommended alternatives:

- If raw material/product purchase: `310 Cost of Goods Sold`.
- If inbound freight/duty/insurance related to those goods: `425 Freight & Courier` or landed into inventory/COGS if accountant requires.
- If owner/related-party service work: `705 Owner / Related Entity Services`.
- If customer sale to Tradethno: keep in `200 Export Sales`, but it should be an invoice/customer receipt flow, not an authorised supplier bill.

Status:

`INV-0172` was confirmed as a raw material/product purchase from Tradethno and has been changed through remove and redo to `310 Cost of Goods Sold` with `No VAT`. VA re-reconciliation is pending.

Question:

Should Tradethno be split into two Xero contacts: one customer contact and one supplier/related-party contact?

Answer:

Yes, recommended going forward, unless the accountant objects for statutory/reporting reasons.

Reason:

Tradethno is a dual-role related party: it can be a customer for export sales and a supplier for raw material/product purchases or related-party services. That dual role already caused a material supplier bill to be coded to `200 Export Sales`. Splitting the operational Xero contacts reduces the chance of selecting the wrong account/tax treatment during invoice, bill, and bank reconciliation work.

Recommended setup:

- `Tradethno pte. ltd. - Customer` for customer invoices, export sales, and customer receipts. Default sales account: `200 Export Sales`. Default sales tax treatment: export/no-VAT as confirmed by accountant.
- `Tradethno pte. ltd. - Supplier` for raw material/product purchases, supplier bills, partial payments, and supplier reconciliations. Default purchase account: `310 Cost of Goods Sold` for raw material/product purchases. Default purchase tax treatment: `No VAT` unless accountant changes the non-EU supplier rule.
- If Tradethno bills owner/related-party project services rather than products/raw materials, use the supplier contact but code the bill to `705 Owner / Related Entity Services`, not `310`.

Implementation rule:

Do not rewrite historical transactions just to split the contact. Apply the split prospectively. Keep the legal name, address, registration/tax details, and notes clear on both contacts so the accountant can still see both refer to the same legal entity.

### Catch-All Accounts

Your note: Suspense is primarily used when a paid amount is refunded; need more examples for General Business Expenses.

Suspense:

- `850 Suspense` is acceptable for real temporary/reversal items: card checks, matched refunds, failed/pending charges, and charge/refund pairs.
- It is not acceptable for normal operating spend that has not been refunded, because it hides the real cost account and weakens VAT/tax review.
- The current issue is not that every suspense row is wrong. The issue is whether each row is genuinely temporary/reversed and whether old pairs have been cleared or documented.

Concrete suspense analysis:

| Date | Contact | Rows | Current account | What is wrong | CFO action |
|---|---|---:|---|---|---|
| 2026-02-03 | Kuura Solutions LLC | EUR 169.57 charge + EUR 169.57 refund | `850 Suspense` | Not a P&L coding issue if these are a true full charge/refund pair. The weak point is that one row says normal `Ecommerce Services`, so someone could wrongly recode only the charge to subscriptions and leave the refund behind. | Do not recode one side only. Confirm in Xero that the two rows offset each other and leave/match/annotate as a refund pair in `850`. No urgent fix if net zero and reconciled. |
| 2026-02-03 | Wise | EUR 1.74 fee + EUR 1.74 refund linked to `KS00011` | `850 Suspense` | Same principle: if fee/refund fully offset, no P&L issue. | Keep as suspense refund pair if net zero; otherwise move actual retained Wise fee to `404 Bank Fees`. |
| 2026-04-27 | ClickUp | EUR 0.86 charge + EUR 0.86 refund | `850 Suspense` | Valid card check/refund style item if paired. | Leave in `850` if fully offset and reconciled. |
| 2026-03-20 | Uber pending | EUR 7.00 charge + EUR 7.00 refund | `850 Suspense` | Valid pending/refund pair if fully offset. | Leave in `850` if fully offset; if the ride actually happened, code final ride to travel instead. |
| 2024-11-15 to 2024-11-27 | UPS card checks | EUR 26.34, EUR 36.84, EUR 64.81 rows | `850 Suspense` | These are old and some local rows are unreconciled. If live Xero still shows them open, suspense is stale. | Check live Xero. If still unreconciled, match/clear the card checks or write off immaterial residue with accountant approval. |

General Business Expenses examples and likely recoding:

Policy decision:

Travel and meals should be coded precisely for tax deductibility and management reporting. Do not leave travel/meals in `429` just because the amount is small.

| Date | Supplier | Gross | Current account | Recommended account | Why / action | New account needed? |
|---|---|---:|---|---|---|---|
| 2026-03-25 | Ccv*van Gogh Hotel Bv | EUR 420.37 | `429 General Business Expenses` | `493 Travel - National` | Dutch hotel. Move to travel. Keep receipt for business purpose and VAT support. | No |
| 2026-03-31 | Finavia Oyj | EUR 80.00 | `429 General Business Expenses` | `494 Travel - International` | Airport/travel cost outside NL. Move to international travel. | No |
| 2026-03-28 | Uber | EUR 34.88 | `429 General Business Expenses` | `493 Travel - National` | NL taxi/ride. Move to national travel unless receipt shows international trip. | No |
| 2026-03-31 | Vof Visser De Roo | EUR 107.12 | `429 General Business Expenses` | `421 Meals and entertainment` | Food/meal type supplier with 9% NL VAT. Move to meals if business meal; keep attendee/business purpose evidence. | No |
| 2026-03-31 | Blushing | EUR 46.98 | `429 General Business Expenses` | `421 Meals and entertainment` | Food/meal type supplier with 9% NL VAT. Move to meals if business meal; if personal, treat as owner/private reimbursement issue instead. | No |
| 2026-03-31 | Bck*ns Utrecht / Amsterdam | EUR 25.12 / EUR 23.17 | `429 General Business Expenses` | `421 Meals and entertainment` | Cafe/food type items. Move to meals if business purpose exists. | No |
| 2024-02-01 / 2024-01-01 | Google API / Google Cloud | EUR 69.95 / EUR 17.09 | `429 General Business Expenses` | `450 Hosting & Infrastructure` | Cloud/API infrastructure. Move to hosting/infrastructure rather than catch-all. | No |
| 2024-01-29 | Prestashop | EUR 69.99 | `429 General Business Expenses` | `422 Software/Service expense` or `485 Subscriptions & Services` | Ecommerce platform/module/software service. Use `422` for software/service purchase; use `485` if treated as recurring subscription. CFO preference: `422` unless recurring monthly. | No |
| 2024-04-05 | Twilio, Inc. | USD 1.92 | `429 General Business Expenses` | `450 Hosting & Infrastructure` | API/communications infrastructure. Move to hosting/infrastructure. | No |
| 2024-03-12 | Barcodes Mania | USD 45.00 | `429 General Business Expenses` | `453 Office & Compliance Costs` | Barcode/admin/compliance style cost. Move to office/compliance. | No |
| 2024-11-08 | Amazon headphones | EUR 120.39 | `429 General Business Expenses` | `453 Office & Compliance Costs` | Low-value office equipment/accessory. Expense to office/compliance unless accountant wants fixed-asset treatment. | No |
| 2024-01-12 | Fedex import tax | GBP 38.92 | `429 General Business Expenses` | `425 Freight & Courier` | Import tax/carrier import cost linked to goods movement. Move to freight/courier under current chart. | Optional: create `426 Import Duties & Customs` only if duties/import VAT become recurring/material and accountant wants separate tracking. |
| 2024-01-22 | Sensi seeds | EUR 27.40 | `429 General Business Expenses` | `430 Research and Product Development` | Description says product development. Move to R&D. | No |
| 2025-06-30 | Valo Hotel | EUR 48.95 | `429 General Business Expenses` | `493 Travel - National` or `494 Travel - International` | Hotel/conference travel. Pick national vs international based on country/trip context. | No |
| 2025-06-12 | Kratochvile.org | EUR 20.20 / EUR 18.97 | `429 General Business Expenses` | `422 Software/Service expense` | Appears web/domain/service related. Move to software/service unless receipt proves another category. | No |
| 2026-02 to 2026-03 | Fk Plus | EUR 67.77-68.86 recurring rows | `429 General Business Expenses` | Needs receipt; likely `422 Software/Service expense`, `485 Subscriptions & Services`, or owner/private | Current supplier name is not enough. Recurring equal USD charges should not remain in `429`; identify what service/product this is and set a supplier rule. | No, unless a new category is identified |
| 2025-11 / 2025-03 / 2025-01 | Jani Saarinen test purchases | Small EUR rows | `429 General Business Expenses` with sales VAT codes | Tax code/account look wrong for purchase spend. These look like test ecommerce purchases or owner reimbursements, not normal business expenses. | Investigate source. If test customer purchases, do not treat as operating expense; if owner-paid business cost, recode to real expense and correct purchase tax treatment. | No |

Conclusion:

`429 General Business Expenses` should remain available, but only for genuinely one-off immaterial items with no better account. Travel, meals, software/API, hosting, import/freight, product development, and office/compliance already have real accounts and should use them.

### Old Unreconciled Bank Transactions

Your note: cannot see old unreconciled Wise EUR transactions in Xero; are these still a concern?

Answer:

Probably not as originally reported. Local warehouse evidence shows the report overstated this by including deleted rows:

| Bank account | Status | Lines | Amount | Oldest | Newest |
|---|---|---:|---:|---|---|
| Wise EUR | DELETED | 119 | EUR 27,172.84 | 2024-01-01 | 2026-03-25 |
| Wise EUR | AUTHORISED | 7 | EUR 1,580.57 | 2024-07-25 | 2024-11-28 |
| Wise USD | DELETED | 6 | 375.45 | 2024-01-08 | 2026-01-29 |

If live Xero shows old Wise periods fully reconciled, do not act from this report. Instead fix the report logic and/or resync bank transactions.

Decision:

Do not reopen old 2024 items from this audit. Treat this as a reporting/filtering issue unless live Xero currently shows old unreconciled transactions that the VA/accountant is actively asking about. Future reconciliation reports must exclude `DELETED` and `VOIDED` rows from current-state exception totals.

## Chart Of Accounts Recommendations

### `200 Export Sales`

Your note: non-EU sales are reconciled to 200; elaborate if issues.

That practice is fine for non-EU customer sales. The issue is not export sales as a concept. The issue is supplier/purchase activity hitting a revenue account.

Valid-looking examples:

- Tradethno customer/export sales invoices and receipts for consulting/ecommerce management.
- Ecommerce non-EU sales imported to `200`.

Problem example:

- `BILL`, `AUTHORISED`, Tradethno, `INV-0172`, EUR 19,286.96, product/raw material description, posted to `200`. This has now been corrected through remove and redo to `310 Cost of Goods Sold` with `No VAT`; VA re-reconciliation is pending.

Recommended rule:

Very clear rule: `200 Export Sales` should only receive sales. Any purchase, supplier bill, raw material/product cost, owner service bill, or other spend posted to `200` is wrong and must be corrected.

### Former `002 Freelancer & Contractor Costs`

Your note: VAs and freelancers are recorded here; what is the issue?

The business logic is sound. The issue is hygiene:

- Code `002` is unusual for an expense account, so it sorts away from normal expense codes.
- Tax treatment differs by supplier location and VAT registration status. Direct VAs/freelancers are generally not EU VAT registered; Fiverr/Upwork now have EU VAT registration treatment. This changed recently, so more than one tax rate in the history is expected.
- Some supplier purchases can include subscriptions or reimbursed services, so supplier-only rules may overclassify.

Decision:

The old `002 Freelancer & Contractor Costs` account has been changed to `480 Contractor & Freelance Services`.

Xero best-practice treatment:

1. Treat `480 Contractor & Freelance Services` as the ongoing contractor/freelancer account.
2. Do not change tax codes as part of the account rename/recode. Tax code depends on supplier location/platform/VAT-registration status and must remain line-specific.
3. Use Find & Recode only for transactions that were wrongly classified by nature, for example non-contractor subscriptions or software purchases accidentally coded to contractor costs.

### `705 Owner / Related Entity Services`

Your note: two owners bill through related entities; want owner work separate from external workforce.

Recommendation:

The separation is useful and reasonable for management reporting. Rename `705 Owner Billing` to `705 Owner / Related Entity Services`.

Do not merge it into external freelancers unless you intentionally want owner-entity labour to appear as ordinary external workforce.

Accountant question:

Should this be tracked as related-party services, ordinary consulting expense, management fees, or another disclosure category?

### `850 Suspense`

Your note: report all anomalies.

Decision:

`850 Suspense` is okay as of now based on the reviewed evidence. The Kuura rows are a charge/refund pair, not a current P&L coding issue. Do not reopen old 2024 suspense/card-check items from this audit. Future suspense anomalies should be reported naturally as new exceptions when they are not obvious matched refunds, card checks, or short-lived pending reversals.

### `429 General Business Expenses`

Your note: list all which should be recoded and to what.

Handled above. Use the recoding table as the working list and apply the policy that travel/meals must be coded precisely.

### Bank Accounts With No Code

Your note: do not understand what this means.

Xero bank ledger accounts can have account codes, but the normal bank-account screens may not make the code obvious. This has now been fixed in Xero for the active Wise/Revolut accounts and new Finsei account.

This is not a reconciliation issue and not a transaction recoding issue. It is chart setup / reporting hygiene.

Xero best-practice fix used:

1. In Xero, go to Chart of accounts and export the chart to CSV. The export/print view is the clean way to confirm whether the bank accounts have codes because it lists chart accounts and codes.
2. Assign unique asset-range codes to the Bank-type accounts.
3. Import the updated chart CSV back into Xero, or edit the individual Bank-type account if Xero exposes the code field in your UI.
4. Do not use Find & Recode. Nothing is wrong with the transaction lines; only the bank ledger account code is missing.
5. If an old duplicate bank account exists, archive it only after confirming it is not used for an active feed/reconciliation workflow.

Updated bank codes:

| Code | Bank ledger account | Type | Tax | Notes |
|---|---|---|---|---|
| `100` | Wise EUR | Bank | Tax Exempt (0%) | Active |
| `101` | Wise USD | Bank | Tax Exempt (0%) | Active USD |
| `102` | Wise GBP | Bank | Tax Exempt (0%) | Active/legacy GBP |
| `110` | Revolut EUR Main | Bank | Tax Exempt (0%) | Active |
| `111` | Revolut USD Main | Bank | Tax Exempt (0%) | Active USD |
| `112` | Revolut GBP Main | Bank | Tax Exempt (0%) | Active GBP |
| `120` | Finsei (AltPay) | Bank | Tax Exempt (0%) | New, seldom used |

Priority:

Done for the listed accounts. Future action is only to keep bank-account codes unique and review/archive any duplicate legacy bank account if it reappears.

## Tax-Rate / Tax-Code Recommendations

### `207 EU Sales`

Your note: OSS/country VAT rates are intentional.

Agreed. Multiple tax codes on `207` are expected for OSS. The only issue is the account default `TAX023 No VAT`. If imports always set the line-level country tax code, the default is less important. If manual entries rely on the account default, it can cause underreported VAT.

Owner answer:

EU ecommerce invoice tax rates are currently set manually based on shipping country. This is a candidate for automation.

CFO recommendation:

Keep using country-specific OSS tax rates on `207 EU Sales`, but do not rely on the `207` account default. Add an automation/control rule that sets the Xero tax rate from shipping country before invoice creation or during import review.

### `705 Owner / Related Entity Services`

Your note: Green Goddess is Finnish reverse VAT; Extremexports is AU; Tradethno is SG.

Recorded current rule:

- Green Goddess Consulting: Finnish entity, EU VAT registered. Use `TAX021 Tax on purchases under Reverse Charge (EU)` for Green Goddess supplier bills to Intactix.
- Extremexports: Australian entity. Use non-EU/no-VAT/outside-EU purchase treatment unless accountant says a reverse-charge code applies.
- Tradethno: Singapore entity. Use non-EU/no-VAT/outside-EU purchase treatment for purchases and `TAX011 Export Sales - NA` for sales.

Why accountant confirmation still matters:

Not because Green Goddess itself is unclear. The Green Goddess logic is clear: Finnish EU VAT registered supplier to NL entity means EU reverse charge. The accountant question is broader: whether `705 Owner / Related Entity Services` needs related-party disclosure/tracking, and whether AU/SG related entities should use `TAX023 No VAT` or an outside-EU reverse-charge purchase tax code in Xero.

### `405 Payment GW Fees`

Your note: Mollie is Dutch BV.

Mollie charges Dutch VAT at 21%, so `TAX057 Tax on purchases STD 21% (NL)` is correct for Mollie fees where a Dutch VAT invoice exists. The old audit flagged mismatch because account default is `INPUT`; that is a default/account-rule issue, not a historical recode issue.

Mollie is now inactive because it shut Intactix down. Future processor fees should still go to `405`, but the processor-specific tax treatment must be set for the new provider.

### `480 Contractor & Freelance Services`

Your note: no domestic NL freelancers/contractors.

Current rule:

- Direct VAs/freelancers who are not EU VAT registered generally use `TAX023 No VAT`, unless accountant says outside-EU reverse charge is required.
- Fiverr/Upwork tax treatment changed recently because they now have VAT registration/platform treatment; multiple tax rates in historical data are expected.
- No domestic NL freelancer/contractor population has been identified.

Action:

Maintain a supplier/tax matrix by supplier/platform and VAT-registration status. Do not force one tax code across all contractor spend.

### Old Tax Rate `TAX030`

What it is:

`TAX030` is `(DO NOT USE - OLD) VAT On Sales in EE 20%`, effective rate 20%. It is an old Estonia sales VAT rate.

Transactions found:

- 2024-07-20, invoice `8338`, contact Vadim Pribudenko, `207 EU Sales`, EUR 129.45 gross.
- 2024-05-24, invoice `8058`, contact Andres Rio, `207 EU Sales`, EUR 403.43 gross.

Recommended action:

Do not change closed filed VAT periods without accountant instruction. Prevent further use of `TAX030`, and ask whether these two historical Estonia VAT lines should be corrected.

### Null Tax Type

After filtering `DELETED` and `VOIDED`, there are no active material uncoded supplier bills in the local warehouse.

Summary split:

| Group | Source/status | Lines | Absolute amount | Interpretation | Action |
|---|---|---:|---:|---|---|
| Deleted material rows | `BILL`, `DELETED` | 4 | 15,197.00 | Includes deleted Tradethno USD 15,000 bill and deleted Xero subscription bills. | Exclude from current exception totals. No Xero action unless live Xero has active equivalent. |
| Deleted bank transfer rows | `BANKTRANSACTION`, `DELETED` | 10 | 752.65 | Deleted Wise/Revolut transfer attempts. | Exclude from current exception totals. |
| Deleted/voided invoice shipping rows | `INVOICE`, `DELETED`/`VOIDED` | 21 | 38.96 | Historical deleted/voided shipping rows, mostly immaterial/zero. | Exclude from current exception totals. |
| Active bank transfer rows | `BANKTRANSACTION`, `AUTHORISED` | 8 | 2,784.73 | Wise/Revolut inter-bank transfer ledger rows with no tax/account code. These are bank-transfer mechanics, not supplier bills. | Report separately as bank transfer rows; do not treat as uncoded supplier spend. |
| Active zero-value shipping rows | `INVOICE`, `PAID` | 1,992 | 0.00 | Ecommerce invoice shipping placeholder lines with zero value and no account/tax. | Report separately or suppress from material QA. |
| Active other zero-value rows | `INVOICE`, `PAID` | 4 | 0.00 | Zero-value non-shipping invoice lines. | Report separately or suppress unless import quality is being reviewed. |

Action:

Filter deleted/voided rows and separate zero-value shipping lines from material uncoded supplier bills.

## Transaction Coding Issues

### Active Ants

Your note: FFC-to-FFC shipping usually freight.

That matches the recommended split. Keep service/warehouse/pick-pack in `409`, and inter-FFC or carrier freight in `425`.

### Green Goddess

Already documented as owner-related entity work. Recommendation: keep separate in `705` and rename for clarity if accountant agrees.

### Tradethno

Already documented. Key issue is role ambiguity and `INV-0172`.

### Paulo Tomas

Your note: mostly former `002` / current `480 Contractor & Freelance Services`, occasional subscriptions should be marked appropriately.

That is the right policy. The rule should not blindly put all Paulo spend into `480`; description/evidence should override if Paulo is reimbursed for a subscription or tool.

### Kuura

Suspense rows:

- 2026-02-03 `Ecommerce Services`, EUR 169.57, `850 Suspense`
- 2026-02-03 `Ecommerce Services Refund`, EUR 169.57, `850 Suspense`

Most Kuura spend is correctly in `485 Subscriptions & Services`.

### VespaEx

Your note: need better instructions on goods purchased for sale; list what is wrong with Vespa.

Vespa is mostly good. The bill `2024000062` is split sensibly:

- Product lines to `310 Cost of Goods Sold`: capsules and Kanna product.
- Shipping lines to `425 Freight & Courier`.
- Repacking service to `411 Packing/Handling Costs`.

Potential issue:

One 2025-01-31 bank transaction to VespaEx for EUR 2,126.35 is coded directly to `310 Cost of Goods Sold` as `Sent money to VespaEx sro`.

Evidence:

| Date | Source | Ref | Description | Gross | Account | Tax | Reconciled |
|---|---|---|---|---:|---|---|---|
| 2025-01-31 | Bank transaction | `2024001215` | `Sent money to VespaEx sro` | EUR 2,126.35 | `310 Cost of Goods Sold` | `TAX021 Tax on purchases under Reverse Charge (EU)` | Yes |

What is wrong:

The account and tax treatment look plausible for an EU supplier product purchase: VespaEx is an EU supplier, product cost goes to `310`, and reverse charge `TAX021` can be appropriate. The weakness is evidence and granularity, not necessarily the P&L account.

Because it was entered directly as a bank spend, Xero only shows one generic payment line. It does not show whether the EUR 2,126.35 included:

- product/goods for resale,
- shipping/freight,
- packing/repacking service,
- insurance,
- other service fees,
- discounts or credits.

This matters because VespaEx bill `2024000062` shows the better pattern:

| Bill line type | Example | Correct account |
|---|---|---|
| Product/goods | Capsules, Kanna product | `310 Cost of Goods Sold` |
| Shipping / insurance | Shipping NL, internal shipping + insurance | `425 Freight & Courier` |
| Packing/repacking service | Packing/repackaging service | `411 Packing/Handling Costs` |

CFO decision:

Do not treat the 2025-01-31 row as an urgent recode if the source invoice proves the whole amount was product/goods. If the invoice includes shipping, insurance, or packing service, split it using the accounts above.

Required action:

Find VespaEx invoice/reference `2024001215`. If it has only product/goods, attach the invoice to the Xero spend-money transaction or leave it as is with the evidence attached. If it has multiple line types, use remove-and-redo or accountant-approved adjustment to split product/freight/packing correctly.

Future rule:

For VespaEx and similar product suppliers, enter a bill with invoice line detail first, then reconcile the bank payment against the bill. Use direct spend-money only for simple one-line purchases where the receipt clearly supports the account and tax treatment.

## Cost Structure Observations

### Product / COGS

Concern is not the total alone. The key is whether raw materials/products are consistently coded to COGS/inventory and whether freight/duties should be landed into product cost.

### Miscellaneous / Unclassified

The largest unclassified examples are mostly analytics/reporting classification issues, not current accounting corrections.

Specific Tradethno rows behind the old wording:

| Month | Row | Amount | Current status | What it means | Action |
|---|---|---:|---|---|---|
| 2026-03 | Deleted Tradethno bill, no account/tax, description `TRADETHNO PTE. LTD.` | USD 15,000.00 | `DELETED` | Deleted/aborted bill in local history. | No current Xero action. Exclude `DELETED` from current unclassified reports. |
| 2024-01 | Tradethno / Airwallex receipt, account `200 Export Sales` | EUR 10,000.00 | `AUTHORISED` bank transaction | Export-sales receipt being treated as spend by analytics. | Report logic fix: revenue rows should not appear as unclassified spend. |
| 2025-10 to 2026-04 | Tradethno consulting sales invoices/receipts in `200 Export Sales` | EUR 3,460 to 7,200 examples | Current revenue rows | Export-sales/consulting revenue being treated as spend by analytics. | Report logic fix, not accounting recode, unless a row is actually a supplier bill. |

Answer: there is nothing current to fix in Xero from the “deleted Tradethno rows” wording. The remaining issue is to fix analytics so unclassified spend excludes `DELETED`/`VOIDED` rows and excludes revenue accounts.

### Marketing / Ads

Owner billing does not need to be questioned as marketing spend. Green Goddess owner/entity billing should remain in `705 Owner / Related Entity Services`, not treated as ordinary ad spend. Future marketing analysis should focus on actual ad/channel costs and revenue attribution, not owner billing.

### Shipping Subsidy

Deferred. We will handle shipping subsidy after importing ecommerce order/payment/shipping data. See `order-payment-shipping-import-prompt.md`.

### Payment Processing Fees

Mollie fees can be compared to total revenue, but not true Mollie-processed card revenue from current warehouse data.

Approximate Mollie fee as percent of total revenue:

- 2026-03: EUR 867.97 fees / EUR 42,926.67 revenue = about 2.0%.
- 2026-02: EUR 625.48 / EUR 19,524.34 = about 3.2%.
- 2026-01: EUR 551.76 / EUR 15,429.51 = about 3.6%.
- 2025-12: EUR 1,209.78 / EUR 22,816.71 = about 5.3%.
- 2025-11: EUR 1,167.09 / EUR 22,416.78 = about 5.2%.

These are not card processing rates because the denominator includes all revenue, not only Mollie-processed card volume.

## Priority Action Plan Updated

1. Done: Tradethno `INV-0172` was remove-and-redone to `310 Cost of Goods Sold` with `No VAT`; VA re-reconciliation is the remaining operational step.
2. Reporting fix needed: current-state reports must exclude `DELETED` and `VOIDED`, exclude revenue accounts from spend views, and split bank-transfer mechanics / zero-value shipping rows from material uncoded supplier bills.
3. Current policy: product/raw material purchases go to `310 Cost of Goods Sold`. Accountant question remains only whether periodic stock-on-hand adjustments are needed.
4. Todo: define supplier tax matrix for direct non-EU freelancers, Fiverr/Upwork platform treatment, EU reverse-charge suppliers, non-EU related entities, Dutch suppliers, and payment processors.
5. Current status okay: `850 Suspense` has no action from this audit. Continue future anomaly reporting only.
6. Todo: recode material `429 General Business Expenses` rows to travel, meals, software, hosting, office/compliance, freight/import duty, or product development.
7. API possible: rename `705 Owner Billing` to `705 Owner / Related Entity Services` via Xero Accounting API account update. Current repo OAuth scopes are read-only (`accounting.settings.read`), so this integration must be re-authorised with `accounting.settings` before it can write the rename.
8. Done: bank codes assigned for Wise/Revolut/Finsei.
9. Future action plan created: review archive/hide candidates in `future-action-plan.md`.
10. Import prompt created: use `order-payment-shipping-import-prompt.md` to add ecommerce order/payment/shipping data.
