# Intactix Accounting Agent — Implementation Plan

Snapshot date: 2026-06-20
Last updated: 2026-06-23
Status: **Phase 0 complete. Phase 1 complete. Phase 2 complete. Phase 3 complete.** Phase 4 (auto-apply, calibration-gated) next. Bank statement line gap closed (2026-06-23).

Phase 0 — complete: independent warehouse, Xero read client + sync, PS MySQL connector, MCP server skeleton.
Phase 1 — complete: reconciliation engine (ACCREC + ACCPAY), two-confidence scoring, bank-receipt lookup, rule store (16 active seed rules), decision queue, coding proposals, 9 MCP tools for rule/queue management. First run: 221 ACCREC invoices matched (0 unresolved), 1 ACCPAY proposal generated (Tradethno, conf 0.85).
Phase 2 — complete (2026-06-21): OSS VAT investigation → per-country Xero tax codes confirmed correct; 13-country COUNTRY_RULES gap and LT miscoding flagged. Canonical match key → PS reference ↔ Xero Reference ↔ xero_payments.source_id validated. PS access → mixed DB+REST confirmed: DB for all structured data, REST only for invoice PDF. Findings in knowledge/phase2-*.md.
Phase 3 — complete (2026-06-22): Write layer built. XeroWriteClient extended with createBill, updateInvoiceCoding, attachPdf, checkPeriodLock, getInvoice. PS webservice PDF client (src/presta/rest-pdf.ts). Apply orchestrator (src/apply/orchestrator.ts) — existence check → period-lock warning → DRAFT create/recode → PDF attach. 4 new MCP tools: apply_proposals, get_write_log, lookup_xero_contacts, attach_pdf_to_invoice. Migration 006 adds apply tracking columns. Prerequisites (user actions): create PS webservice key on gp_live, add write scopes to Xero OAuth app, re-run consent flow, set XERO_WRITE_ENABLED=true.
Bank statement line gap — fallback active (2026-07-14): Xero Finance API / Bank Statements Plus is restricted for this app, so the agent now treats missing Finance access as normal Accounting API fallback mode. Xero sync covers coded Accounting API objects (BankTransactions, payments, invoices, transfers, reports). Raw bank/card activity comes from direct Wise/Revolut provider feeds into `xero_bank_statement_lines`; `detect_missing_supplier_receipts` combines both sources.
Entity in scope: **Intactix B.V.** (GoPure), single Xero tenant. US/AU stores and any other legal entities are **out of scope**.

> Naming note: `intactix_accounting_agent` is a placeholder directory name. Rename freely.

---

## 0. What this agent is

An **independent, self-developing accounting agent** for Intactix B.V. that reconciles Xero
transactions (online sales, EU sales, NL domestic sales, exports, and purchases from each
jurisdiction), retrieves supporting invoices from the GP EU PrestaShop store, captures OSS / NL
VAT correctly per destination country, and **grows its own rule base** by asking when it cannot
decide and durably recording the answer.

Two hard constraints from the user shape everything below:

1. **Independence.** The agent builds and owns its own knowledge base, database, and Xero access
   code. It may *bootstrap* from `~/koodi/gp_xero_cfo` (copy patterns, port the knowledge base,
   seed rules) but must have **zero runtime dependency** on it. `gp_xero_cfo` is not guaranteed to
   survive.
2. **Auto-apply authority.** Confidence ≥ 0.95 → the agent posts/allocates in Xero automatically.
   Below threshold → it queues a question for a human. This requires real write access plus strong
   safety rails (draft-first, idempotency, immutable audit log, kill switch, value/materiality caps).

### Division of labour (important)

- **Deterministic code (TypeScript CLI + MCP tools)** does everything that must be exact and
  repeatable: Xero sync, DB, PrestaShop reads, candidate matching, confidence scoring, VAT
  arithmetic, idempotent writes, audit logging.
- **The OpenClaw agent** does judgement and learning only: resolving ambiguous matches, choosing a
  tax treatment when rules disagree, deciding when to ask a human, and **writing new durable rules**
  from human answers. The agent never does arithmetic or matching that SQL should own.

---

## 1. Confirmed decisions (from the user)

| Topic | Decision |
|---|---|
| Write authority | Auto-apply at confidence ≥ 0.95; queue a question otherwise. End state, reached by phases. |
| Sales-to-cash model | Per-order: 1 PrestaShop order = 1 Xero ACCREC invoice; bank receipts matched per order. |
| Who creates the sales invoice | **The agent creates it** (cleanest path, confirmed 2026-06-21). For each online-sale order the agent creates one fully-coded Xero invoice from PS data (product/shipping split + ship-to-country VAT), optionally attaches the PS invoice PDF, then matches the bank receipt. This replaces the current manual "attach PDF / create-then-reconcile" step. Note: invoice creation is a **write**, so it lives in the write phases and is gated like all writes. |
| v1 scope | **Broad, throttled by the learning loop.** Agent attempts everything it can (online sales, purchase bills, bank coding) and surfaces what it cannot resolve to the decision queue; human explains; agent learns. Not a narrow sales-only v1. |
| OSS VAT location | **Investigate first** — inspect synced Xero tax data and how the OSS return is produced today, then recommend whether per-country VAT must live in Xero or stays in PrestaShop. |
| PrestaShop store | **GP EU** (gopure.shop) feeds Intactix B.V. |
| PrestaShop access | **Research DB vs REST.** Likely direct MySQL read for order/invoice data (fast, rich) + optional webservice to fetch the invoice PDF and attach it to the Xero invoice. |
| Independence | Agent owns its DB + knowledge base + Xero client; bootstraps from gp_xero_cfo, no runtime dependency. |

## 1a. Domain facts (confirmed by user, 2026-06-21) — these are load-bearing

- **Xero cannot determine ship-to country.** It does not know where an order shipped, so VAT rate and
  export-vs-EU-vs-domestic status **cannot be derived from Xero**. PrestaShop is the authoritative
  source for destination, and therefore for VAT treatment.
- **Xero records only the full order total.** The split between product revenue and shipping revenue
  (which belong on different Xero accounts) is known **only in PrestaShop**.

Consequence: every online-sale reconciliation **requires a PrestaShop lookup**. PS supplies (a)
ship-to country → VAT rate / export flag, and (b) the product-vs-shipping amount split for account
coding. This partially pre-answers the OSS investigation: per-country VAT determination lives in
PrestaShop, not Xero. The Phase 2 investigation now narrows to "how do totals tie out and is any
per-country tax structure needed in Xero at all."

## 2. Working assumptions (stated, not blocking — correct me if wrong)

- Single Xero tenant = Intactix B.V.
- The 27-country VAT table provided is the **OSS output-VAT** reference (sales to EU consumers).
- "Agent" = an OpenClaw agent orchestrating deterministic TS tools via a local MCP server
  (intactix-tools), runnable on this Pi both interactively and on a schedule. Model: gpt-5.5.
- VAT-rate-change research = a scheduled WebSearch/web-fetch task; low risk, not architectural.
- Reconciliation domains in scope: (a) online sales invoice → receipt matching, (b) purchase
  bills from NL / other-EU / non-EU suppliers, (c) bank-feed coding (Wise / Revolut / Finsei).

---

## 3. Xero API reality check (bounds the "auto-reconcile" promise)

Xero's standard Accounting API **cannot tick the bank-reconciliation checkbox** — `IsReconciled`
on bank statement lines is read-only and statement lines are not writable. What the API *can* do:

- Create / update **Invoices** (ACCREC, ACCPAY) — supports `DRAFT` status.
- Create **Bank Transactions** (spend/receive money).
- Create **Credit Notes**.
- Create and **allocate Payments** to invoices/bills (payments post immediately — no draft state).
- Create **Contacts**, **Manual Journals** (draft-capable).

So "auto-reconcile" operationally means: **create/code the right invoice/bill/bank-transaction and
allocate the payment, so Xero's own bank-rec matcher then proposes the green OK to a human (or the
feed auto-matches).** The agent gets the books correct; the final statement-line tick stays in Xero.
This must be communicated clearly — it changes what "done" looks like. (Verify against current Xero
docs during Phase 0; behaviour has been stable but confirm.)

---

## 4. Target architecture (independent project)

```
intactix_accounting_agent/
  src/
    xero/            replicated read client + NEW write client (separate file, separate scopes)
    presta/          GP EU connector: MySQL reader (+ optional webservice PDF fetch)
    warehouse/       own MySQL schema + migrations (own DB: intactix_agent_db)
    reconcile/       candidate matching, coding, tax determination, confidence scoring
    apply/           write orchestration: draft-first, idempotency, audit log, confidence gate
    learn/           rule store CRUD + "human answer -> durable rule" promotion
    vat/             27-country rate table, OSS logic, scheduled rate-change research
    mcp/             small MCP server exposing the above as agent tools
    cli.ts
  knowledge/         agent-OWNED markdown KB (ported + then self-maintained)
  audit/             immutable write-audit logs (JSONL)
  PLAN.md
```

### 4.1 Layers

1. **Xero access (independent copy).** Replicate `gp_xero_cfo` OAuth refresh-token flow and rate-limit
   handling. Keep the **read client untouched/read-only**. Add a **separate `XeroWriteClient`** so write
   capability is physically isolated and easy to disable. Own `.env`, own OAuth app/scopes.

2. **Local warehouse (own DB `intactix_agent_db`).** Port the relevant gp_xero_cfo migrations
   (raw objects, normalized `finance_transaction_lines`, payments, tax rates, contacts, invoice
   balances) into the agent's own schema. Bootstrap = one-time copy; thereafter the agent evolves
   its own schema independently.

3. **PrestaShop GP EU connector.** Primary: read orders/order-detail/invoices directly from the PS
   MySQL DB (creds from `<docroot>/app/config/parameters.php`), read-only. Optional: webservice REST
   call to fetch the **order invoice PDF** and attach it to the matching Xero invoice. Matching key
   research: PS order reference / invoice number ↔ Xero invoice reference / number / amount / date.

4. **Knowledge base (agent-owned, self-growing).** Markdown + structured tables:
   - `chart-of-accounts.md` — account map and purpose.
   - `tax-rules.md` — tax-code decision rules (export TAX011, EU reverse-charge TAX021, no-VAT
     TAX023, OSS output VAT, NL domestic 9%/21%).
   - `country-vat.md` — the 27-country OSS rate table + effective dates + source.
   - `rule-register.md` — durable reconciliation/coding rules (ported from gp_xero_cfo IAR-* register).
   - `current-state.md`, `open-questions.md`, `change-log.md` — ported then maintained by the agent.
   The KB is the agent's long-term memory; the structured **rule store** (DB table, modelled on
   `finance_cost_mapping_rules`) is the machine-executable form the matcher consumes.

5. **Reconciliation engine.** For each unreconciled item: generate candidate match(es) + proposed
   account coding + proposed tax code. Score **two confidences separately**, because the costly
   errors differ:
   - **Match confidence** (which Xero record / bank line goes with what): exact ref match, amount
     match, date proximity, supplier history, rule hits.
   - **Tax confidence** (which tax code applies): scored on its own and held to a **more conservative
     auto-apply bar** than matching, because a wrong tax treatment has filing consequences.
   For **online sales**, the agent **must pull PrestaShop** for every order, because Xero lacks the
   ship-to country and the product/shipping split (see §1a). From PS it gets: ship-to country → VAT
   rate / export flag, and the product-vs-shipping amounts → correct Xero accounts. PS's order-time
   VAT is carried through and validated against the 27-country rate table, not re-derived. The genuine
   VAT *judgement* lives on **purchases** (EU vs non-EU reverse-charge, no-VAT, the exact cases
   `open-questions.md` already enumerates); those get the conservative tax bar. Output is a structured
   proposal, never prose.

6. **Apply layer (write path).** Gated by confidence:
   - `>= 0.95` → auto-apply (draft-first where Xero supports it).
   - `< 0.95` → enqueue a human question.
   Every write: **idempotency key** (deterministic from source+target so retries never double-post),
   **immutable audit record** (what/why/confidence/inputs/Xero response), and a **reversibility note**
   (void/delete path). Hard caps that override confidence: per-transaction value ceiling and
   transaction-class allowlist (only vetted classes auto-apply at first).

7. **Learning loop (the self-development the user wants).**
   - Agent hits something it can't resolve → writes a precise question to the **decision queue**
     (with full evidence).
   - Human answers (how to reconcile / which tax code / why).
   - Agent **promotes the answer into a durable rule** in the rule store + `change-log.md`, with a
     scope (this supplier / this account / this pattern) and a confidence.
   - Future matching items now resolve automatically. The agent's accuracy compounds over time.

8. **Scheduled autonomy.** Cron-driven: incremental Xero sync, PrestaShop pull, reconciliation run,
   and a **periodic VAT-rate web-research task** that checks each of the 27 countries for rate
   changes and raises a flagged question if anything moved.

---

## 4b. Purchase invoices: intake + EU reverse-charge determination

### 4b.1 EU reverse-charge determination (don't trust the invoice's printed format)

Problem: many suppliers are EU-VAT-registered but show their VAT ID inconsistently (or not at all)
on the invoice. The treatment depends on the supplier's **actual** status, not on what a given PDF
prints. Design:

- Maintain a durable **supplier tax profile** in the knowledge base / rule store: legal name,
  country, VAT ID, goods-vs-services nature, default tax treatment (NL domestic VAT / EU reverse
  charge `TAX021` / outside-EU `TAX023` or reverse charge outside EU / import VAT for goods).
- **Validate VAT IDs against VIES** (free EU VAT validation service). A VIES-confirmed cross-border
  EU B2B supply → reverse charge, even if the specific invoice omitted the VAT ID.
- Goods vs services matters (intra-community acquisition / import VAT for goods vs the B2B general
  rule for services); the profile records which.
- First time a supplier is seen or is ambiguous → **decision queue**; human/accountant confirms →
  promoted to a durable supplier rule. Every later invoice from that supplier auto-classifies.
- The engine **flags mismatches**: VAT charged where reverse charge was expected, or vice versa.
- This is rule application + VIES validation, **not tax advice**; conservative tax-confidence bar
  (see §4.1.5). Consistent with the TAX021/TAX023 questions already in `open-questions.md`.

### 4b.2 Invoice intake (multi-source, one pipeline)

Today invoices are emailed to Xero (email-to-Xero creates an inbox file, sometimes a draft bill).
The agent needs the raw PDF to extract supplier / VAT ID / amounts / product-shipping split, then
create or complete a coded bill and match the payment. Design = **one ingestion pipeline fed by
several sources**, normalized into a single inbox table → extract → supplier tax profile + VIES →
draft bill in Xero (PDF attached) → reconcile.

**Channel selection is deferred (user, 2026-06-21): explore later. Keep all of these as live
possibilities; build the pipeline so channels are pluggable.** Candidate channels:

- **Pull Xero Files inbox** via API so anything emailed straight to Xero by habit isn't missed.
  (Closest to the current habit; likely the first one explored.)
- **Slack channel / DM** — post or forward invoices to a Slack channel or the agent's Slack user;
  agent ingests via the Slack API. Good fit for the team's existing workflow.
- **Dedicated agent mailbox (IMAP)** — forward/BCC invoices; agent owns the raw source, best audit
  trail, independent of Xero's scan quality; keep BCC-to-Xero if desired.
- **Telegram bot** — phone-snapped receipts on the go (trivial, free).
- **Dropbox / watched folder** — bulk backfill / manual filing.
- WhatsApp = later add only (paid Business API, more setup).

Verify in build: Xero Files API access to the inbox + current email-to-Xero behaviour. Extraction
uses the OpenClaw agent for the messy/varying invoice layouts; deterministic code handles the pipeline,
VIES calls, dedupe, and the write. Because channels are pluggable, the chosen one(s) can be turned on
when you decide without reworking the pipeline.

## 5. Phased delivery (value before risk; auto-apply is earned, not day one)

**Phase 0 — Bootstrap independent skeleton**
- Create project, own `.env`, own DB `intactix_agent_db`.
- Replicate Xero **read** client + sync; port relevant migrations; port the `docs/accounting/intactix`
  knowledge base into `knowledge/`.
- Verify Xero API write capabilities against current docs.
- Deliverable: independent read-only warehouse that re-syncs Intactix with no gp_xero_cfo dependency.

**Phase 1 — Read-only reconciliation proposer (no write scopes)**
- GP EU PrestaShop connector (DB read; pick DB vs API after a short spike).
- Matching + coding + tax-determination engine with confidence scores.
- For online sales the proposer outputs the **full proposed invoice** it would create per order
  (lines, product/shipping split, country VAT, contact) plus the receipt match — reviewed, not yet
  written.
- Broad attempt across sales + purchases + bank coding; everything it cannot resolve goes to the
  decision queue. **The learning loop is the throttle**: the agent does as much as it confidently can
  and asks for the rest.
- Decision queue + human-answer → rule promotion (learning loop works end-to-end, just without writes).
- Deliverable: reviewed worklist + growing rule base. **This is where most value lands.**

**Phase 2 — Investigations (parallel, feed the rules)**
- OSS VAT: how is VAT recorded in Xero today, how is the OSS return produced, do we need per-country
  in Xero or keep it in PrestaShop? → recommendation.
- Sales-to-cash: confirm the per-order invoice flow against real synced data; define the canonical
  match key (PS order ↔ Xero invoice ↔ bank receipt).
- PrestaShop: DB vs REST decision + whether to attach invoice PDFs to Xero.

**Phase 3 — Write layer, draft-first, behind confidence gate**
- Build `XeroWriteClient`, idempotency, audit log, kill switch, value caps.
- Request the **increased Xero OAuth scopes here** (not before) — see §6.
- Start with the single lowest-risk write class in DRAFT only; human approves every item.

**Phase 4 — Auto-apply for vetted classes (calibration-gated)**
- **The 0.95 number is not meaningful until calibrated.** A score assembled from heuristic signals is
  not a probability. Before auto-apply is enabled for *any* transaction class, **backtest the proposer
  against already-reconciled historical Xero data and measure actual precision at the threshold.**
  Auto-apply turns on per-class only when measured precision clears a stated bar (e.g. ≥ 99% on a
  meaningful sample); otherwise the threshold is raised or the class stays queued. This is the gate
  that lets the agent "do its job perfectly" honestly.
- **Payments allocate last.** Payment allocation posts immediately (no draft) and is the hardest write
  to reverse, so it is the final class promoted to auto-apply — queued-only until everything else is
  proven, and always gated on the period-lock check.
- Keep value cap + kill switch + full audit. Daily auto-apply summary for human review.

**Phase 5 — Scheduled autonomy**
- Cron: incremental sync, reconciliation, OSS checks, and the VAT-rate web-research task.

---

## 6. Xero scopes — request only at Phase 3

Current app is read-only. For the write phases the OAuth app will need (will ask you to add when we
reach Phase 3, with the exact list):
- `accounting.transactions` (write) — invoices, bills, bank transactions, payments.
- `accounting.contacts` (write) — create/match supplier & customer contacts.
- `accounting.attachments` (write) — attach PrestaShop invoice PDFs.
- `accounting.settings` (write) — only if Phase 2 concludes per-country tax rates must live in Xero.

**Do not** request write scopes until the auto-apply path and its safety rails exist and you approve.

## 7. Safety model for auto-apply (non-negotiable)

- Separate write client; read path stays read-only and untouched.
- Draft-first wherever Xero supports a draft state.
- **Period-lock check before every write.** Query Xero's lock dates; never post into a closed month
  or a filed VAT period. Silent period violations are serious.
- **Existence check before every create, not just idempotency.** The idempotency key only stops the
  agent double-posting its *own* retry. Before creating an invoice/bill, query Xero for an existing
  record by order reference (a VA or an existing PS→Xero push may already have created it) to avoid
  double-booking the same order.
- Idempotency key on every write; retries are safe.
- Immutable JSONL audit log: input evidence, confidence, decision, Xero response, timestamp.
- Confidence gate (0.95) AND a value ceiling AND a transaction-class allowlist — all must pass.
- Kill switch (env flag) that forces every write back to queue-only.
- Dry-run mode that logs intended writes without sending them.
- Reversibility note per write; nightly summary of all auto-applied items for human spot-check.

## 8. Open items I will resolve during build (not blocking the plan)

- DB vs REST for PrestaShop, and PDF-attach feasibility (short spike, Phase 1/2).
- Exact OSS VAT recording recommendation (Phase 2 investigation).
- Canonical match key across PrestaShop ↔ Xero ↔ bank (Phase 2).
- Confirm Xero write/draft behaviour for payments vs invoices against current docs (Phase 0).

## 9. What I need from you to start

1. Approve the **independent project + phased approach** (auto-apply as the Phase 4 end state, not day 1).
2. Confirm the placeholder name or give me one.
3. Confirm I may read the GP EU PrestaShop DB (read-only) for orders/invoices.
4. Confirm a fresh, isolated MySQL DB for the agent is OK (`intactix_agent_db`).
5. Hold the Xero scope increase until Phase 3 (I'll give you the exact scopes then).
```
