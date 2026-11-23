# Stage A · 02 · Cited VAT rule library (Intactix B.V.)

**Date:** 2026-10-22 · **Status:** proposed; documentation only; **nothing here is automated** · **Decision it informs:** the rules the agent may research and recommend from, and the fixed answers it must reach. Built on the treatments `T1-T17` (`01-treatments.md`) and the sources in `05-verified-sources-and-rates.md` and `00-overview-and-sources.md`.

## How to read a rule
**Basis:** A = official source read; B = approved Intactix policy; C = outside the available sources. **Status:** `APPROVED` (law + approved code + approved policy), `RECOMMEND` (law read, code or policy pending: Needs Review with recommendation), `CONFLICT Kn` (see `01`). Citations: V = verified in Stage A, S = Belastingdienst/GOV.UK read 14-15 Oct, [VERIFY] = not verified. Return boxes are those the Belastingdienst pages name; the **Xero-to-box link is unverified for every code** (see `03`).
Common preconditions for every purchase rule: the document is a supplier invoice (not a settlement or request for payment), addressed to **Intactix B.V.** with its Dutch VAT ID, not a duplicate; the currency conversion follows A5. A failed precondition is Needs Review.

## 1. Dutch purchases
| ID | Facts | Treatment | Xero code | Box | Citations | Status | Needs Review when |
|---|---|---|---|---|---|---|---|
| **NL-1** | Supplier established in NL; VAT shown at **21%**; VAT = 21% x net; supplier VAT ID valid | Dutch input VAT, deductible if used for taxed supplies | `TAX057` | 5b (input VAT) | V4 art. 9(1); S4, S12, S26 | **APPROVED** (T1) | VAT does not equal rate x net; mixed rates (T15); non-deductible item (T14); supplier VAT ID unverified |
| **NL-2** | Dutch supplier, VAT at **9%** | As NL-1 at 9% | `TAX058` | 5b | V4 art. 9(2)(a) and table I; S4 | RECOMMEND (no precedent in Q2/Q3 purchases; P3) | Always until the code is approved; confirm the goods/services are in table I |
| **NL-3** | Dutch supplier, **0% or exempt or KOR** statement | No VAT; deduction preserved only for 0% | `TAX023`/`NONE` by precedent | none | V4 art. 9(2)(b), art. 11; S4, S21, S22 | RECOMMEND (P3 meaning of `TAX023`/`NONE`) | Always: 0% vs exempt vs KOR must be shown on the invoice |
| **NL-4** | Dutch supplier, **VAT reversed to Intactix** (btw verlegd; e.g. customs-related services) | Domestic reverse charge: declare and deduct | `TAX022` (Q2 DSV bill) | 2a, 5b | S12, S13, S24; V4 art. 12 | RECOMMEND (code mapping unverified) | Always; wording "btw verlegd" and VAT IDs required |
| **NL-5** | Non-deductible or partly deductible VAT (entertainment, private use) | Part of the cost | per accountant | per accountant | S23 | RECOMMEND | Always (T14) |

## 2. EU acquisitions of goods
| ID | Facts | Treatment | Xero code | Box | Citations | Status | Needs Review when |
|---|---|---|---|---|---|---|---|
| **EG-1** | Goods sent from another EU state **to NL**, EU supplier invoices at 0% with both VAT IDs | Intra-Community acquisition: declare Dutch VAT, deduct | **none verified** (`TAX021` used for NaturaLink in Q2: K5) | 4b, 5b | V4 art. 17a; S7, S8, S10 | RECOMMEND (code gap K5) | Always; require transport evidence of arrival in NL |
| **EG-2** | Goods delivered **to another EU state** (e.g. straight to Monta DE) | Acquisition may fall in the arrival state | none | per accountant | S8; X2 (foreign law) | RECOMMEND, outside the sources | Always |
| **EG-3** | **Own stock moved** NL to DE (no purchase) | Supply in NL at 0% + acquisition in DE (not a bill) | none | 3b + ICP (NL side) | S6, S7; E1 art. 17/21 [VERIFY] | outside the bill path | Always (K3) |

## 3. EU services
| ID | Facts | Treatment | Xero code | Box | Citations | Status | Needs Review when |
|---|---|---|---|---|---|---|---|
| **ES-1** | EU (non-NL) **business** supplier; B2B general-rule service; **0% VAT; reverse-charge wording**; valid VAT ID (VIES) | Reverse charge: Intactix declares NL VAT, nets to zero | `TAX021` | 4b, 5b | V4 art. 6(1), 12(2)-(3); S3, S9, S10, S13; E1 art. 44/196 [VERIFY] | **APPROVED** (T7) | No wording; VAT ID missing/invalid/stale; exception service (S25: property, events, passenger transport, catering); customer not Intactix B.V.; EU-KOR |
| **ES-2** | EU supplier **charges its own VAT** on a general-rule service | Not reverse charge; VAT wrongly charged: ask for a corrected invoice | none | none | S13 (wrong VAT not deductible) | RECOMMEND | Always |
| **ES-3** | EU supplier, **no VAT ID** / small business | Cannot reverse-charge on the facts | `TAX023` by precedent | none | S9, S22 | RECOMMEND | Always |

## 4. Non-EU services
| ID | Facts | Treatment | Xero code | Box | Citations | Status | Needs Review when |
|---|---|---|---|---|---|---|---|
| **NE-1** | Non-EU **business** supplier, B2B general-rule service, no Dutch VAT | **Reverse charge, normally** (the Dutch customer declares); wording not required by Dutch law | **Policy split:** SOP rows for named suppliers = `TAX023`; guide and L1 = `INPUT` | 4a, 5b | V4 art. 6(1), 12(3); S2, S11 | **CONFLICT K1**; `INPUT` blocked for automatic use (D47) | **Always** for suppliers without an SOP row; for SOP-row suppliers follow the row and attach K1 |
| **NE-2** | Non-EU supplier is an **individual** (freelancer) | Reverse charge if an independent business; otherwise outside scope | `TAX023` (policy) | 4a if reverse-charged | S11 | **CONFLICT K2** | Always when the invoice states reverse charge, a VAT ID, or a business form |
| **NE-3** | Non-EU platform **registered in the EU and charging VAT** (some digital platforms) | VAT charged by the supplier, deductible if proper | `TAX057`/`TAX058` or foreign VAT (NE/FV) | 5b | S25, S26 | RECOMMEND | Always: country and rate of the VAT must match a verified registration |
| **NE-4** | US sales tax or other non-EU tax on the invoice | Not VAT; part of the cost | `TAX023` | none | S27 | RECOMMEND | Always |

## 5. Imports and non-EU goods
| ID | Facts | Treatment | Xero code | Box | Citations | Status | Needs Review when |
|---|---|---|---|---|---|---|---|
| **IM-1** | **Supplier invoice** for goods located outside the EU (Tradethno, ExtremeXports goods) | No VAT on the invoice; VAT arises at import | `TAX023` by precedent (IAR-003); see K4 | none on the invoice | S15, S16 | **CONFLICT K4** | Always |
| **IM-2** | **Import document** (customs declaration, carrier disbursement) | Import VAT: deductible; with an Article 23 permit declared in the return instead of paid at the border | none verified | 5b (box for Art. 23 not verified) | V4 art. 18-23; S16, S17 | RECOMMEND (needs the permit question and a code) | Always |
| **IM-3** | Carrier/forwarder invoice mixing freight, clearance fees and import VAT (DSV) | Split lines: freight/service lines and import VAT are different treatments | `TAX022` was used in Q2 for the whole DSV bill | per line | S16, S24, T3/T7/T12 | RECOMMEND | Always: classify each line |

## 6. Foreign VAT
| ID | Facts | Treatment | Xero code | Box | Citations | Status | Needs Review when |
|---|---|---|---|---|---|---|---|
| **FV-1** | Supplier charges **another country's VAT** on a supply taxed there (goods located there; exception services) | Not deductible in the Dutch return; recover in that country or through the EU refund procedure | none verified; cost incl. VAT | none in the NL return | S10, S18, S27 | RECOMMEND (code gap) | Always; check whether the VAT was due (VAT wrongly charged on a general-rule service: ES-2) |
| **FV-2** | VAT paid in a non-EU country | Ask that country's tax authority | none | none | S27 | RECOMMEND | Always |

## 7. Reverse charge: recognising and ruling out the look-alikes
| ID | Rule | Citations |
|---|---|---|
| **RC-1** | Reverse charge is a **reporting duty even when the net is zero**: 4a non-EU services, 4b EU services and acquisitions, 2a domestic reverse charge; the deductible part goes to 5b | S10, S11, S12 |
| **RC-2** | Rule out the **three look-alike pairs** explicitly on every invoice: reverse charge vs foreign VAT charged; zero-rated vs exempt; "no VAT shown" vs outside scope. "No VAT shown" is not proof of anything | T10, T11, `01` part D |
| **RC-3** | Reverse charge needs the customer to be **Intactix B.V. as a business** (name and VAT ID); a person or another company is Needs Review | S13, S14 |
| **RC-4** | Exception services (immovable property, events, short-term transport hire, passenger transport, catering) are not general-rule services; stop | S3, S25 |

## 8. OSS and Intactix's own sales (reference, same knowledge base)
| ID | Facts | Treatment | Xero code | Citations | Status |
|---|---|---|---|---|---|
| **OS-1** | B2C distance sales of goods to another EU state; Intactix uses the **Union OSS** | Charge the **destination country's rate** from the order's ship-to country (PrestaShop is the only source); return filed in the OSS | per-country codes (`05`) | S19; ship-to rule in IDENTITY.md | APPROVED (sales side); rates verified by `05` |
| **OS-2** | Rate to apply | Standard or reduced **by product**; the legal basis of Intactix's reduced rates is not documented | RDC or STD code per country | V1 (rates only) | **CONFLICT K8** |
| **OS-3** | Shipping line | Follows the destination-country code (IAR-015) | same code | IDENTITY.md | APPROVED (policy) |
| **OS-4** | Non-EU destination | Export 0% | `TAX011` | S5 | APPROVED; UK point-of-sale rule open (K10) |
| **OS-5** | Country with no tax code configured (EE today in the app) | Stop and ask; never guess | none | AGENTS.md | APPROVED |
| **OS-6** | **Rate change monitoring** | Refresh rates from TEDB monthly and diff against Xero (found CZ, SK, EE in Stage A) | - | V1 | Stage B/E |

## 9. What the agent may conclude alone
Only the rules marked **APPROVED** (NL-1, ES-1, OS-1, OS-3, OS-4, OS-5), and only when every condition and precondition is met and every cited source is current. Everything else is a **recommendation** with citations, routed to Needs Review. Section 3 of `04-decision-rights.md` lists who signs off what.
