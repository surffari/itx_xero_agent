# EXPERTISE.md — Xero & Accounting Advisory Framework

This file is your accounting and Xero expertise. When you encounter a situation not already covered
by a rule or supplier profile, reason from these principles first. Then either apply confidently
or write a precise question with your recommendation.

---

## 1. EU VAT for Intactix B.V. (ecommerce, NL-domiciled)

### Framework: which VAT regime applies to a sale?

```
Is the buyer an EU VAT-registered business (B2B)?
  YES → Reverse charge (buyer accounts for VAT in their country). Intactix invoices net.
        Account: 200 (non-EU) or 207 (EU). TaxType: depends — see purchase section.
        In Xero: use "Output Tax (Reverse Charge)" or "Zero Rated" depending on Xero setup.
  NO (B2C consumer or unknown) →
    Is ship-to country = NL?
      YES → NL domestic VAT. Rate: 21% STD (TAX001/TAX008), 9% RDC (TAX008).
             Intactix's products are botanicals — standard 21% applies (not reduced food/medicine rate).
             AccountCode: 207 (EU/Domestic Online Sales).
    Is ship-to country in EU?
      YES → OSS (One Stop Shop). Apply destination-country rate from country-vat.md.
             AccountCode: 207 (EU/Domestic Online Sales). TaxType: country-specific (TAX005–TAX064).
    Is ship-to country outside EU (GB, US, AU, SG, etc.)?
      YES → Export, zero-rated. AccountCode: 200 (Export Sales). TaxType: TAX011.
```

Customer-charged shipping on online orders is the exception to the product sales account above:
post the Shipping line to `208 Shipping Sales`, while keeping the same destination-country
TaxType that applies to the order. Products stay on `200` or `207` as above; do not use decommissioned
account `235` for new online sales.

### OSS threshold: Intactix is above it

The EU-wide OSS threshold is €10,000/year total cross-border B2C sales. Intactix is a multi-country
EU seller well above this — OSS applies to all cross-border B2C sales from the first euro.
Never suggest "maybe the threshold hasn't been crossed" without checking the annual figures.

### OSS filing mechanics (Xero → Belastingdienst)

- Accountant runs Xero Sales Tax Report per quarter.
- Each Xero tax-type row = one OSS country line. Per-country accuracy in Xero is filing-critical.
- A wrong or missing TaxType on a sale = wrong OSS return. No second chance without an amendment.
- The agent sets TaxType from PrestaShop ship-to country. PS is the ONLY source — Xero doesn't know ship-to.
- Quarterly deadline: ~31 July (Q2), ~31 October (Q3), ~31 January (Q4), ~30 April (Q1).
- **Q2 2026 (Apr 1–Jun 30) deadline is 2026-07-31 — this is the current priority.**

---

## 2. Purchase bill tax treatment decision tree

When coding an ACCPAY bill, work through this in order:

### Step 1 — Check supplier profile
Call `get_supplier_profile(contact_name)`. If confident profile exists → use it. Done.

### Step 2 — Check existing rules
Call `test_rule_match(ACCPAY, contact_name)`. If a rule fires above 0.75 → follow it.

### Step 3 — Reason from the verified rule library (corrected 2026-10-22, Stage A)

The authoritative rules, citations, Xero codes and open conflicts are in `knowledge/vat-rule-library.md` and `knowledge/vat-source-hierarchy.md`. Rates are in `knowledge/country-vat.md` (verified against the EU Commission TEDB). **You research and recommend; you do not decide conflicts, and you never create or change a Xero tax rate.** Source order: law and official guidance, then approved company policy (SOP supplier rows; Kayne's guide for everything the SOP has no row for), then supporting guidance, then evidence only (profiles, history).

Purchase tax codes that exist in Xero (use only these): `TAX057` Dutch 21% purchases; `TAX058` Dutch 9% purchases (no precedent yet); `TAX021` reverse charge EU; `TAX022` reverse charge NL (domestic); `INPUT` reverse charge outside EU; `TAX023` No VAT; `NONE` Tax Exempt. **`TAX001` and `TAX008` are not Dutch purchase codes** (`TAX008` is the sales code for NL 9%). There is **no code** for EU goods acquisition, import VAT or foreign VAT: treat those as Needs Review.

```
Where is the supplier located and what is supplied?

NL supplier, VAT on the invoice at 21%      -> TAX057 (NL-1). Check VAT = rate x net and a valid VAT ID.
NL supplier, 9% / 0% / exempt / KOR / "btw verlegd" -> recommend only (NL-2/3/4); Needs Review.

EU supplier (not NL), business with a valid VAT ID (check VIES), general-rule service, 0% VAT and
reverse-charge wording, customer named as Intactix B.V. -> TAX021 (ES-1).
  - Supplier charged its own VAT -> not reverse charge (ES-2): Needs Review, ask for a corrected invoice.
  - No wording, VAT ID missing/stale, exception service (property, events, transport, catering) -> Needs Review.
  - EU goods delivered to NL, imports, foreign VAT -> no verified code: Needs Review (EG-1, IM, FV).

Non-EU supplier (US, AU, SG, PH ...):
  - Law and Belastingdienst guidance: a B2B general-rule service is normally reverse-charged by Intactix
    (return box 4a, nets to zero). That is the legal treatment, not "no VAT".
  - Company coding is in conflict with that (conflict K1): the SOP keeps named suppliers on TAX023
    (decision D49), Kayne's guide says INPUT. If the supplier has an SOP row: follow the row and attach K1.
    If it has no row: recommend INPUT with citations and route to Needs Review. Never decide automatically.
  - Individual freelancers: policy TAX023, law may differ (K2): Needs Review with both positions.
  - Goods from a non-EU supplier: the supplier invoice has no VAT; VAT arises at import (K4): Needs Review.
  - US sales tax or similar on the invoice is not VAT.

Platform/marketplace (Upwork, Fiverr, Amazon ...): charges VAT only if registered; the country and rate of the
VAT shown must match a verified registration, otherwise Needs Review.
```

Every recommendation must show: facts with their location on the document, the rule ID, the sources with
retrieval dates, the proposed Xero code, alternatives rejected, and what would change the answer.
Escalation format and who decides each case: see `/opt/projects/gopure/bills_management/research/vat-framework/stage-a/04-decision-rights.md` (proposed, not yet in force).

### Step 4 — Goods vs services (matters for intra-EU)

| Supply type | Treatment | Source |
|---|---|---|
| Services (B2B, general rule) | Place of supply is where the customer is established; the customer accounts for the VAT when the supplier is not established in NL | Wet OB art. 6(1), 12 (verified); Belastingdienst S3, S9-S11 |
| Goods (intra-Community acquisition) | Intactix declares the acquisition; no verified Xero code (Needs Review) | Wet OB art. 17a (verified); S7, S8 |
| Goods imported from non-EU | Import VAT at customs, or declared in the return under an Article 23 permit; no verified Xero code | Wet OB art. 18-23 (verified); S16, S17 |
| Digital services from a non-EU platform | VAT only if the platform is registered and charges it | S25 |

EU VAT Directive article numbers are **not verified** (EUR-Lex blocked): do not cite them as verified.

Intactix buys mainly **services** (fulfilment, contractors, subscriptions, freight) and **goods** (raw materials from Tradethno/VespaEx). Distinguish per bill.

---

## 3. Account code decision guide

When you're unsure which account to use, start here:

| What was bought | Account | Notes |
|---|---|---|
| Raw materials / products for resale | 310 Cost of Goods Sold | Tradethno, VespaEx, product suppliers |
| Fulfilment centre ops (pick/pack, warehousing, postage/fulfilment platforms) | 409 Fulfillment Costs | Monta, Stamps.com, ShipStation |
| Carrier / freight / international shipping | 425 Freight & Courier | Carrier invoices, inter-FFC transfers; DSV requires invoice review when hauling products/raw materials |
| Packaging materials (physical) | 410 Packaging Material Cost | |
| Repacking / handling service | 411 Packing/Handling Costs | |
| Import duties, customs charges | 425 Freight & Courier | Or 426 if created; ask accountant |
| External VA / freelancer labour | 480 Contractor & Freelance Services | Paulo, Henny/Suhenny, direct freelancers |
| Platform VA/freelance spend (Upwork, Fiverr) | 480 Contractor & Freelance Services | |
| Owner / related-entity billing | 705 Owner / Related Entity Services | Green Goddess, Extremexports, Tradethno services |
| Payment processor fees | 405 Payment GW Fees | Mollie (historic), new processor |
| Software subscriptions | 485 Subscriptions & Services | Recurring SaaS |
| One-off software purchase | 422 Software/Service expense | |
| Hosting / cloud / infra | 450 Hosting & Infrastructure | Google Cloud, Twilio |
| Travel (national) | 493 Travel — National | Hotels NL, Uber NL, domestic rail |
| Travel (international) | 494 Travel — International | Flights, hotels abroad |
| Meals / entertainment | 421 Meals and entertainment | Require business-purpose record |
| Office, compliance, registrations | 453 Office & Compliance Costs | |
| General catch-all (truly unclassifiable) | 429 General Business Expenses | Last resort; flag for review |
| Suspense / temporary clearing | 850 Suspense | Matched card checks, reversals only |

---

## 4. Xero mechanics you must know

### Invoice lifecycle
- **DRAFT** → not in VAT return, editable, safe to create and show to human.
- **SUBMITTED** → Xero internal review step; rarely used.
- **AUTHORISED** → in VAT return, not freely editable, payment can be allocated.
- **PAID** → fully paid; produces a payment record linked to a bank account.
- **VOIDED** → cancelled; historic record preserved, no financial effect.
- Agent creates DRAFTs only. Human authorises. Never skip DRAFT for a new invoice.

### Payment allocation
- A Payment in Xero links an Authorised invoice to a bank account line.
- Creating a Payment is irreversible (no DRAFT state). Only do this in Phase 4+ with confidence ≥ 0.95.
- Xero auto-suggests payment matches in the bank reconciliation screen — agent doesn't need to
  allocate payments manually if the bank feed is reconciled by the human.

### Bank reconciliation vs agent reconciliation
- **Xero bank reconciliation**: human (or feed) matches bank statement lines to payments/spend.
  `IsReconciled` on a bank line = the human has ticked it off in Xero. Agent cannot set this.
- **Agent reconciliation**: local engine matches Xero invoices to PS orders by reference.
  These are different processes. Agent reconciliation validates coding; bank rec validates cash.

### Credit notes
- ACCREC credit note: reduces what a customer owes (refund or discount).
- ACCPAY credit note: reduces what Intactix owes a supplier (supplier credit).
- Credit notes must be allocated against the original invoice to clear both. An unallocated credit
  note leaves both the invoice and the credit outstanding.

### Manual journals
- Use for period-end adjustments, FX revaluations, reclassifications.
- Agent should not create manual journals autonomously — flag the need and let the accountant decide.
- Exception: the agent may propose draft manual journals with full workings when the amount and
  accounts are unambiguous and the accountant has approved the pattern.

### Tracked and untracked tax
- In Xero NL, both input and output VAT are "tracked" — they appear in the VAT return.
- TAX023 (No VAT) and TAX011 (Export) are NOT tracked — they do not generate a VAT return line.
- TAX021 (EU reverse charge purchases) generates both a debit (input) and a credit (output) in
  the VAT return — net zero effect but required for the BTW box 4b/4a declaration.
- Getting the TaxType wrong on a line = wrong VAT return filing. Always double-check before proposing.

### Xero contacts
- Contacts are matched by name. Exact match matters for deduplication.
- Tradethno exception: use `Tradethno pte. ltd. - Customer` for ACCREC and `Tradethno pte. ltd. - Supplier`
  for ACCPAY. One contact name for both creates miscoding risk (IAR-004).
- When a contact is new (not in warehouse): `query_warehouse("SELECT * FROM xero_contacts WHERE name LIKE '%partial%'")`.
  If not found, the agent can create the contact as part of invoice creation (Phase 3+).

---

## 5. Recommendation protocol — how to structure advice

When you encounter a situation not covered by an existing rule or profile:

**1. Identify the item precisely.**
> "Bill 2026-06-15, EUR 1,840, from 'Designwithpash', current coding: 480 / TAX023."

**2. Retrieve evidence.**
- `get_supplier_profile('Designwithpash')` → no profile yet
- `query_warehouse(...)` → any prior bills? Any patterns?
- `query_ps(...)` → if relevant to a sale

**3. State candidates with reasoning.**
> "Designwithpash appears to be a design/creative services supplier. Three candidates:
> (a) Non-EU freelancer → 480 / TAX023 (current) — correct if they are not EU VAT registered
> (b) EU freelancer (VAT registered) → 480 / TAX021 (reverse charge) — correct if they have an EU VAT ID
> (c) EU freelancer (not VAT registered) → 480 / TAX023 — same net effect as (a) for Intactix"

**4. State what resolves it.**
> "To confirm: Is Designwithpash EU or non-EU based? Do they have an EU VAT ID? If yes, provide the ID and country — I'll validate against VIES when that tool is available."

**5. Give a recommendation.**
> "Current coding (TAX023) is defensible if non-EU. I recommend confirming their location. If EU + VAT-registered, the tax code should change to TAX021. Confidence: 0.65 pending confirmation."

**6. If human confirms: encode the answer.**
```
upsert_supplier_profile({
  contact_name: "Designwithpash",
  country_iso: "PK",         // Pakistan — non-EU confirmed
  entity_type: "individual",
  supply_type: "services",
  default_tax_code: "TAX023",
  default_account_code: "480",
  confidence: 0.85,
  notes: "Non-EU individual, design services. Confirmed by Jani 2026-06-21."
})
```
Then `promote_to_rule` if there's a broader pattern worth a regex rule.

---

## 6. Known tricky situations for Intactix

### Tradethno dual role
Tradethno Pte. Ltd. (Singapore) is BOTH a customer (buys GoPure products, paying export sales) AND a
supplier (bills raw materials, owner services). Never assume which role a Tradethno transaction is
without checking: is it an ACCREC (sale to them) or ACCPAY (bill from them)?
- ACCREC from Tradethno: `200 Export Sales, TAX011` (non-EU customer)
- ACCPAY product purchase: `310 COGS, TAX023` (non-EU raw material supplier)
- ACCPAY owner services: `705 Owner / Related Entity Services, TAX023`

### Green Goddess Consulting (FI, EU, VAT-registered)
Finnish entity with Finnish VAT registration. Cross-border B2B service supply to NL = EU reverse
charge. TaxType: TAX021. Account: 705 Owner / Related Entity Services. Established by IAR-007.

### Upwork and Fiverr (platform fees)
Platforms are now EU-VAT registered and charge VAT on platform fees for EU business buyers.
Current practice: reverse-charge outside-EU code. This is under review (open question in
open-questions.md). Do not change the treatment without accountant confirmation.

### GBP orders (invoice creation)
PS orders in GBP (id_currency=3) must NEVER have their EUR amount derived from PS conversion_rate.
The human accountant used real-time bank rates. Flag every GBP orphan separately; present the PS
GBP amounts and ask the human to confirm the EUR equivalent. Batching these helps (e.g., "here are
45 GBP orders for April — please provide EUR totals, or confirm I can use the Wise mid-rate on the
order date from the warehouse bank transfers").

### Mollie settlements (historic)
Mollie settled weekly lump payments covering many orders. Do not try to match Mollie settlements
1:1 to individual invoices — they were bulk settlements. These are now closed (Mollie deactivated).
Historic Mollie reconciliation is reference-only unless a specific discrepancy is flagged.

### 850 Suspense
Suspense is temporary only. If you see an authorised, non-reversed line in 850 older than 30 days
that is NOT a card-check pair, flag it and propose the correct account. Card-check pairs (equal
charge and refund) are fine to leave in suspense if they fully offset.

### 429 General Business Expenses
Any recurring or material item in 429 needs a home. If you see a supplier or description you
recognise: look up the right account from the table in section 3 and recommend the recode.
Travel = 493/494. Meals = 421. Software = 485/422. Cloud/hosting = 450. Do not let 429 accumulate.
