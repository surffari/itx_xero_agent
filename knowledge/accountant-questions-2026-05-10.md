# Intactix Accountant Questions - 2026-05-10

Purpose: gather accountant/bookkeeper questions from the Intactix accounting QA work in one place.

Source files:

- `reports/intactix-accounting-qa-review-2026-05-10.md`
- `docs/accounting/intactix/audit-response-2026-05-10.md`
- `docs/accounting/intactix/rule-register.md`

## Chart Of Accounts

1. The old `002 Freelancer & Contractor Costs` account has been changed to `480 Contractor & Freelance Services`. Confirm whether any historical non-contractor lines inside this account should be recoded by nature using Find & Recode.
3. Confirm that renaming `705 Owner Billing` to `705 Owner / Related Entity Services` is acceptable.
4. Confirm whether owner-related entity transactions need extra related-party disclosure, tracking categories, notes, or year-end review beyond using account `705`.
5. Which unused active default/system accounts must remain active, and which unused accounts can be archived/hidden?
6. Bank ledger account codes have been updated: `100` Wise EUR, `101` Wise USD, `102` Wise GBP, `110` Revolut EUR Main, `111` Revolut USD Main, `112` Revolut GBP Main, `120` Finsei (AltPay). Accountant/bookkeeper only needs to review any duplicate/legacy bank account if it reappears.
7. Should a separate `426 Import Duties & Customs` account be created, or should import duties/carrier import taxes remain in `425 Freight & Courier` or product cost?

## Inventory, COGS, Freight

1. Product/raw material purchases are now coded to `310 Cost of Goods Sold`. Should accountant-level stock-on-hand adjustments be posted monthly, quarterly, or yearly for material unsold inventory?
2. Should inbound freight, inter-fulfilment-centre freight, duties, and insurance be capitalised into landed product cost, or kept separately in `425 Freight & Courier`?
3. Confirm whether the current simple approach is acceptable: day-to-day raw material/product purchases to `310`, with only periodic inventory adjustments if material.

## Tax Codes

1. Confirm tax treatment for direct non-EU freelancers/VAs who are not EU VAT registered, such as Paulo/Henny/Suhenny/Designwithpash: `TAX023 No VAT`, `INPUT Tax on Purchases under Reverse charge (Outside EU)`, or another code.
2. Confirm tax treatment for Fiverr/Upwork now that their VAT registration/platform treatment has changed. Should platform invoices and freelancer labour use the same tax treatment or be separated?
3. Confirm EU contractor/service supplier treatment: `TAX021 Tax on purchases under Reverse Charge (EU)`.
4. Confirm Green Goddess Consulting as a Finnish entity should continue using `TAX021`.
5. Confirm Tradethno and Extremexports non-EU treatment: `TAX023 No VAT`/outside-EU treatment for purchases and `TAX011 Export Sales - NA` for sales.
6. EU ecommerce tax rates on `207 EU Sales` are set manually based on shipping country. Accountant to confirm if the account default can stay neutral/no-VAT while automation/import controls set the country-specific OSS tax code per invoice line.
7. Should `420 Entertainment` and `421 Meals and entertainment` remain separate for Dutch tax deductibility/business-purpose reasons?
8. Confirm that travel/meals should always be coded to specific accounts and not left in `429 General Business Expenses`.

## Historical Corrections

1. Should old Green Goddess lines currently in the former `002` / now `480 Contractor & Freelance Services` account be reclassified to `705 Owner / Related Entity Services`, or left as historical drift?
2. After renaming/recoding `002` to `480`, should any non-contractor lines historically posted to the account be recoded by nature?
3. Do not reopen old 2024 unreconciled/suspense items from the local audit unless live Xero still shows a real current issue. Confirm this approach is acceptable.
4. For the deleted 2026-03-18 USD 15,000 Tradethno bill, confirm no active equivalent exists in Xero. If an active equivalent exists, review account/tax coding.

## Reporting / Controls

1. Confirm that `200 Export Sales` is sales-only and purchases posted to `200` should always be corrected.
2. Confirm that `850 Suspense` is acceptable for matched charge/refund pairs, card checks, and short-lived pending reversals, with future unresolved anomalies reported monthly.
3. Confirm monthly review process for `429 General Business Expenses`: recurring or identifiable spend should be recoded to real accounts.
