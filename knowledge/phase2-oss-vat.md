# Phase 2 Investigation — OSS VAT in Xero

Investigation date: 2026-06-21  
Status: **Complete — findings and gaps documented**

---

## Finding: Xero Sales Tax Report is the OSS filing source

The VAT/OSS return is produced directly from Xero's Sales Tax Report. The accountant takes
net/tax/gross per tax-rate row from that report and enters those figures into the OSS filing.
Per-country accuracy in Xero is therefore **load-bearing for VAT compliance** — a missing or
wrong tax code on a sale produces a zero or incorrect amount in the OSS return for that country.

## Finding: per-country tax-rate structure in Xero is correct

The existing approach — one Xero tax rate per EU country (e.g., TAX005 = FR 20%, TAX008 = NL 21%,
TAX009 = DE 19%) posted to account `207 EU/Domestic Online Sales` (including NL domestic) — is exactly
the right structure for OSS reporting from Xero. No tracking categories, no custom reports, and no
changes to the Xero chart of accounts are needed.

Recommendation: keep this structure and automate it fully. The agent sets the Xero tax code from
`ship_country` (from PS, which is the only authoritative source) — this is already the Phase 1
design and it is correct.

## Finding: COUNTRY_RULES coverage gap

`invoice-builder.ts` and `reconcile/engine.ts` both contain a `COUNTRY_RULES` map covering only
13 countries (NL, FR, GB, IE, SE, DE, ES, IT, BE, PT, HU, AT, LT). The EU has 27 member states.
Any EU sale to an unmapped country will:

- In the reconciliation engine: get `tax_confidence = 0.10` and queue a question (correct).
- In the invoice builder: return `status = "flagged"` with `UNKNOWN_COUNTRY` (correct).

These queued items are visible to the agent but produce **no OSS line** in Xero until resolved.
The current gap is safe (no wrong lines are posted) but produces incomplete OSS returns if sales
have been made to unmapped countries.

**Action for Phase 3/4:** before auto-apply is enabled for any country, the COUNTRY_RULES map
must be expanded to all EU members + common non-EU destinations. The 27-country rate table in
`knowledge/country-vat.md` (to be created) is the authoritative source. Each unmapped country hit
should also remain in the decision queue for the agent to learn the rule from human confirmation.

## Finding: Lithuania (LT) is miscoded as export

`COUNTRY_RULES` maps Lithuania to:
```
LT: { accountCode: "200", taxType: "TAX011" }  // treated as export in existing data
```

Lithuania is an EU member state, not a non-EU export destination. Treating LT sales as export
(`200 Export Sales, TAX011 No VAT`) understates OSS output VAT for LT. The comment "treated as
export in existing data" means this was the pattern in historical Xero data, not that it is correct.

**Action:** investigate historical Xero invoices with `Reference` to LT ship-to orders. Likely
explanation: those were B2B sales (reverse charge, genuinely zero-rated) or the Xero invoice was
manually coded incorrectly. Confirm with accountant. If they were B2C retail sales, the OSS rate
for Lithuania is 21%; a new Xero tax code is needed.

## Finding: OSS stays in Xero, not in PrestaShop

The per-country VAT determination must come from PrestaShop (ship-to country is not visible in
Xero), but the reported VAT totals live in Xero via the tax-code mechanism. PrestaShop is
authoritative for input (country + rate at order time); Xero is authoritative for the filed
output. These roles do not overlap. No new integration between PS and the OSS filing tool is
needed beyond what the agent already does.

## Finding: GBP orders are a gap

Orders in GBP (`id_currency = 3`) are flagged by the invoice builder and queued. The ship-to
country may still be an EU country (most likely GB, post-Brexit = export, but also IE or other
EU), so the tax code is not always TAX011. The EUR amount must be provided for Xero invoice
creation. This is a Phase 3 process decision: either use the PS EUR equivalent at order time
(if stored), or require human input for GBP orders as the invoice builder currently does.

## Recommendation

No structural changes to Xero are needed for OSS. The Phase 3 action list for OSS compliance is:

1. Create `knowledge/country-vat.md` with the full 27-country OSS rate table + Xero tax type codes.
2. Expand `COUNTRY_RULES` in `invoice-builder.ts` to all EU members and common non-EU destinations.
3. Investigate and correct the LT / Lithuania coding issue with accountant input.
4. Ensure any new EU country sale routes to the decision queue if a Xero tax type does not yet
   exist (the agent must create the tax rate or queue a human to do so).
5. Add a periodic VAT-rate-change check (already in Phase 5 plan) — the agent should verify the
   rate table against official EU OSS sources on a schedule.
