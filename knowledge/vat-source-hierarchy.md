# Stage A · 01 · Source hierarchy and conflict register

**Date:** 2026-10-22 · **Status:** proposed for sign-off; documentation only · **Decision it informs:** which source the agent treats as authoritative when sources disagree, and which disagreements need a human decision. Company-policy questions are **flagged here, not resolved**.

## 1. Hierarchy (highest first)
| Level | Source | Role | Examples in this project |
|---|---|---|---|
| **L1 Applicable law and official guidance** | EU VAT Directive (text not yet verified), Dutch Wet OB (verified), Belastingdienst guidance (S1-S30), EU Commission TEDB and national tax boards for rates, VIES for VAT-ID status | Defines the **legal treatment**: place of supply, who accounts for the VAT, rate, deductibility, reporting duty | `00-overview-and-sources.md`, `05-verified-sources-and-rates.md` |
| **L2 Approved company policy** | (a) The coding SOP supplier table (v6, 30 Jul) and decisions D47/D49; (b) Kayne's bookkeeping guide (D48); (c) policy P1 (adopted 2026-10-15); rule register IAR items marked Current; Jani's 2026-07-30 corrections, for the named suppliers only | Chooses **which Xero code and booking mechanics** to use, and adds stricter handling (Needs Review triggers). Tie-break between (a) and (b), per D49: **the SOP governs for suppliers that have a row; the guide governs everything else and the stop-and-ask rules** | `knowledge/rule-register.md`, `research/kayne-bookkeeping-guide.md`, PLAN D47-D49 |
| **L3 Supporting guidance** | Confluence "NL VAT Report Explained" v8, the framework documents `01`-`17`, Belastingdienst tools | Explains and cross-checks; never decides alone | `17-reconciled-tax-coding-rules.md` |
| **L4 Evidence only** | Supplier profiles, earlier bookings, `coding_proposals`, agent memory, previous Xero codes, Xero history | Facts about what was done, not what is right | `supplier_tax_profiles`, `workspace/MEMORY.md` |

## 2. How the agent applies it
1. **The legal treatment comes from L1.** The agent states it with a citation (source ID, retrieval date).
2. **The Xero code and handling come from L2.** If L2 has a rule for this case (SOP row, guide rule, adopted decision), the agent follows it and records the rule ID.
3. **If L2 and L1 disagree** (for example an SOP row says No VAT where L1 says reverse charge), the agent **does not choose**. It records both, labels the case **CONFLICT Kn**, and routes to Needs Review with the question. A human with authority (section 4 of `04-decision-rights.md`) decides.
4. **If L2 is silent**, the agent recommends from L1, labels it "research-based, not signed off", and routes to Needs Review.
5. **L3 and L4 never override L1 or L2.** A profile or history that disagrees with L1/L2 is flagged as stale evidence.
6. **Dates and versions are recorded** with every citation. Official pages older than 30 days at the time of use are refetched; the SOP and guide are cited by version/date.
7. **A rule with no source is not a rule.** Anything the agent cannot cite is Needs Review.

## 3. Conflict register (for decision; nothing resolved here)
| ID | Conflict | Sources | Exposure | Who decides |
|---|---|---|---|---|
| **K1** (was C1) | The SOP keeps named non-EU suppliers on **No VAT (`TAX023`)**: Cloudflare, ClickUp, FrontApp, ShipStation, Stamps.com, Xero NZ, Ventraip, Tradethno. L1 (S11, Wet OB art. 6(1) and 12(3)) says B2B services from a non-EU supplier are normally reverse-charged by the Dutch customer (box 4a); the guide (D48) says `INPUT`. D49 chose the SOP for coding. The open question is whether **omitting the 4a declaration** is acceptable | L1 vs L2(a) vs L2(b) | Up to EUR 9,814.94 of Q3 base (about EUR 2,061 VAT, net zero) | **Jani + accountant** |
| **K2** | Individual contractors (Paulo Tomas, Kayne Pecha, Keith Sarsaba, Darlene Aberin, Dede N.): policy is `TAX023`; L1 reverse charge applies when the individual is an independent business and the service is a general-rule service | L1 vs L2 | 28 Q3 invoices, about EUR 3,536 | **Accountant**, Jani |
| **K3** | Monta Germany GmbH (EUR 10,972.32 Q3; two invoices in Q2): coded `TAX021` (reverse charge, wording on the invoices); the SOP row says **Review**; Intactix may be registered or active in Germany (German VAT workbooks exist), which changes who accounts for what | L2(a) "Review"; L1 B2B rule; open X2 | EUR 10,972.32 | **Accountant**, Jani |
| **K4** | Goods from non-EU suppliers (Tradethno, INV-0175 booked `INPUT` in Q2, other rows `TAX023`): L1 says VAT arises at import, not on the supplier invoice; the code `TAX023` is "No VAT" by precedent; the import VAT documents and the Art. 23 permit question are open | L1 vs L2 (IAR-003) | Tradethno 6,060 (Q3) | **Accountant** |
| **K5** | Intra-EU **goods** purchases have no Xero code; NaturaLink (Q2, EUR 6,750) was booked on `TAX021` (the services code) | L1 (S7, S8, Wet OB art. 17a) vs Xero config | Q2 and any Q3 EU goods | **Jani + accountant** (code choice), Kayne (Xero) |
| **K6** | **Rates in Xero vs official rates:** CZ 15% used in Q2; SK 20% used in Q3; EE 22% code outdated | L1 (TEDB, EMTA) vs Xero config | Q2 CZ VAT 13.48; Q3 SK VAT 17.82 | Fix of codes: **Kayne** with accountant; correction of filed/open returns: **accountant** |
| **K7** | **Shop rate for Estonia** (22% charged on 13293, 28 Sep 2026) vs 24% | L1 | One order, EUR 91.43 | **Kayne** (shop), accountant |
| **K8** | **Product classification** for reduced and zero rates (reduced rates in 12 states, IE 0%): the legal basis for each reduced rate for Intactix's products is not documented | outside the available sources (X-type) | All OSS sales | **Accountant** |
| **K9** | **Return-box mapping unverified** for `INPUT`, `TAX021`, `TAX022`, `TAX023`, `TAX057`, `TAX058`: Xero shows a single 0% component and the report has no box labels | L1 box rules vs Xero config | The whole Q3 return | **Accountant + Jani** |
| **K10** | **UK sales:** GB at `TAX011` export 0%; UK rules (S30) require UK VAT at point of sale for consignments up to GBP 135 | L1 (UK) vs Xero config | 290 GB invoices in Q3 | **Accountant** (UK registration question) |
| **K11** | **Stale internal rules:** IAR-005 (Monta DE as German standard VAT), IAR-003 wording for Tradethno, the agent's `EXPERTISE.md` codes (corrected in Stage A) | L2 vs facts | Documentation | Jani (approve updates) |
| **K12** | **Guide vs SOP precedence** | D48 vs D49 | Resolved by D49 (SOP for rows; guide for the rest). Recorded here so the agent applies it consistently | Closed |
| **K13** | **Source gap:** EU VAT Directive text not verified (EUR-Lex blocked); article numbers stay [VERIFY] | - | The agent must cite the Wet OB and Belastingdienst, not the Directive article numbers | Stage B (tooling) |

## 4. Rule for the agent on conflicts
A conflict never gets resolved by the agent, by a profile, or by "what we did last quarter". The agent records the conflict ID, both positions with citations, the amount at stake, and proposes what it would do under each answer, then stops (existing decision-queue behaviour in `AGENTS.md`).
