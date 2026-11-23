# Country VAT Reference Table

**Rewritten 2026-10-22 (Stage A).** The earlier version was "seeded from memory" and is replaced. Standard and reduced rates below are from the **EU Commission TEDB service** (situation on 2026-10-01; CZ, SK, EE also checked on 2026-05-15 and 2026-08-15). Estonia is confirmed by the Estonian Tax and Customs Board. Xero code columns are the live tax-rate configuration (active codes), with sales net for Q2/Q3 2026 from Xero. Full evidence: `/opt/projects/gopure/bills_management/research/vat-framework/stage-a/05-verified-sources-and-rates.md`; raw data `tedb-rates-2026-10-01.json` in the same folder.

## Rules for using this file
- `rates.ts` is the code-side source for audits; this file is the human-readable, **verified** reference. If they differ, report it; do not change a Xero tax rate or code (only Kayne changes Xero, after the accountant agrees).
- Multiple standard rates for one country (e.g. ES 7/21) are territories or categories; the mainland rate applies to Intactix's sales.
- **Which reduced rate applies depends on the product.** The legal basis for Intactix's reduced and zero rates (including Ireland 0%) is not documented (conflict K8): do not infer it from this table.
- Refresh monthly from TEDB and report differences from Xero.

## EU member states (verified 2026-10-22)

| ISO | Country | Standard % (TEDB) | Reduced % (TEDB) | Xero sales codes (active) | Sales gross (incl. VAT) Q2 / Q3 | Check |
|---|---|---|---|---|---|---|
| AT | Austria | 20 | 4.9, 10, 13, 19 | TAX048 10% | 0 / 303 | ok |
| BE | Belgium | 21 | 6, 12 | TAX006 12% | 1,566 / 563 | ok |
| BG | Bulgaria | 20 | 9 | TAX026 20% | 0 / 0 | ok |
| CY | Cyprus | 19 | 3, 5, 9 | TAX027 19% | 0 / 0 | ok |
| CZ | Czechia | 21 | 12 | TAX049 15%, TAX028 21% | 103 / 0 | MISMATCH: TAX049 15% used in Q2 (TEDB reduced 12%) |
| DE | Germany | 19 | 7 | TAX009 7% | 1,045 / 1,109 | ok |
| DK | Denmark | 25 | - | TAX029 25% | 424 / 431 | ok |
| EE | Estonia | 24 | 9, 13 | TAX061 24% | 0 / 0 | MISMATCH: TAX060 22% (use TAX061 24%) |
| ES | Spain | 7, 21 | 4, 10 | TAX054 10%, TAX031 20% | 2,087 / 1,329 | MISMATCH (unused): TAX031 20% |
| FI | Finland | 25.5 | 10, 13.5 | TAX050 10%, TAX032 25.5% | 0 / 0 | ok |
| FR | France | 20 | 0.9, 1.05, 2.1, 5.5, 8.5, 10, 13 | TAX005 5.5% | 1,955 / 1,135 | ok |
| GR | Greece | 24 | 4, 6, 13, 17 | TAX062 13%, TAX034 24% | 0 / 0 | ok |
| HR | Croatia | 25 | 5, 13 | TAX035 13% | 0 / 0 | ok |
| HU | Hungary | 27 | 5, 18 | TAX024 27% | 174 / 0 | ok |
| IE | Ireland | 23 | 9, 13.5 | TAX018 0%, TAX036 23% | 3,127 / 2,743 | 0% code used: depends on product class (open) |
| IT | Italy | 22 | 4, 5, 10 | TAX047 5%, TAX037 22% | 974 / 1,581 | ok |
| LT | Lithuania | 21 | 5, 12 | TAX063 12%, TAX064 5%, TAX059 21% | 354 / 844 | ok |
| LU | Luxembourg | 17 | 3, 8, 14 | TAX004 3%, TAX003 5%, TAX038 17% | 0 / 29 | MISMATCH (unused): TAX003 5% |
| LV | Latvia | 21 | 5, 12 | TAX039 21% | 0 / 0 | ok |
| MT | Malta | 18 | 5, 7 | TAX025 18% | 0 / 0 | ok |
| NL | Netherlands | 21 | 9 | TAX008 9%, TAX001 21% | 823 / 1,050 | ok |
| PL | Poland | 23 | 5, 8 | TAX051 8%, TAX041 23% | 0 / 0 | ok |
| PT | Portugal | 23 | 6, 13, 16, 22 | TAX007 6%, TAX042 23% | 880 / 563 | ok |
| RO | Romania | 21 | 11 | TAX052 9%, TAX043 19% | 0 / 0 | MISMATCH (unused): TAX052 9%, TAX043 19% |
| SE | Sweden | 25 | 6, 12 | TAX055 12%, TAX044 25% | 1,483 / 2,232 | ok |
| SI | Slovenia | 22 | 5, 9.5 | TAX056 9.5%, TAX045 22% | 293 / 214 | ok |
| SK | Slovakia | 23 | 5, 19 | TAX053 9.5%, TAX046 20% | 0 / 107 | MISMATCH: TAX046 20% used in Q3 (TEDB standard 23%); TAX053 9.5% unused |

## Findings that need a human decision (do not act on them yourself)
- **CZ**: `TAX049` 15% was used in Q2 (gross 103.41, net 89.93); TEDB reduced rate is 12%, standard 21%.
- **SK**: `TAX046` 20% was used in Q3 (gross 106.90, net 89.08); standard rate is 23%.
- **EE**: standard rate is **24%** (since 1 July 2025); `TAX061` is right, `TAX060` 22% is outdated. The shop charged 22% on order 13293 (28 Sep 2026). EE has no tax type in `rates.ts`; the order stays held.
- Unused active codes with non-existent rates: `TAX031` ES 20%, `TAX003` LU 5%, `TAX043` RO 19%, `TAX052` RO 9%, `TAX053` SK 9.5%.
- `TAX008` is the **sales** code NL 9%; Dutch purchases use `TAX057` (21%) and `TAX058` (9%).

## Non-EU / export
| ISO | Country | Rate | Xero code | Account | Notes |
|---|---|---|---|---|---|
| GB | United Kingdom | 0% | `TAX011` | 200 | Export. UK rules require UK VAT at point of sale for consignments up to GBP 135 (GOV.UK, read 2026-10-15); the position is an open accountant question (K10). |

## History kept from the earlier file
- Lithuania was once mapped to export; Q2/Q3 sales use `TAX059` (LT STD 21%) and the LT codes `TAX063` (12%), `TAX064` (5%) also exist. Any historical LT invoices coded as export still need accountant review.

## Workflow: a country has no Xero rate (`audit_vat_rates` reports MISSING_XERO_RATE)
1. Confirm the rate from TEDB (and the national tax authority) and record the source and date here.
2. Stop and ask: creating a Xero rate is Kayne's step after the accountant agrees; the agent never creates or edits tax rates.
3. After Kayne creates it, run `sync_reference` and `audit_vat_rates`, then update `rates.ts` through the normal change process and mark the row verified.
