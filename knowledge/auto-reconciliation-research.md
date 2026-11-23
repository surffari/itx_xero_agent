# Auto-Reconciliation Research
_Research date: 2026-06-26_

---

## TL;DR

Xero permanently declined programmatic reconciliation via the public API (May 6, 2026). But "full auto-reconcile" is achievable through a layered strategy that sidesteps this wall entirely — and we already have the critical infrastructure in place. For Intactix's current topology (bank-transfer sales, no active card processor), the per-order Payment allocation path + JAX activation is likely to achieve ≥ 95% hands-free reconciliation within weeks.

---

## 1. The Wall — What Xero Has Definitively Closed Off

On **May 6, 2026**, Xero's Developer Centre admin formally and permanently declined the 280-vote "Reconcile via the API" feature request ([UserVoice link](https://xero.uservoice.com/forums/5528-accounting-api/suggestions/2884040-reconcile-via-the-api)):

> "We have confirmed that we will not be adding the ability to reconcile bank statement lines via the API or to expose unreconciled bank statement data via the public **Accounting** API."

Reasons given:
1. **Regulatory / CDR**: Unreconciled bank lines are raw banking data. In Australia (and by extension Xero's global policy) redistributing this to third parties via public API triggers consumer data rights obligations.
2. **Contractual with banks**: Xero's bank-feed agreements restrict redistribution of raw statement data.
3. **Liability**: Xero will own reconciliation automation itself (JAX), not expose the pipe for third parties to own.

What is NOT closed off:
- The **gated Finance API** (`/finance.xro/1.0/BankStatementsPlus`) is separate — it exposes unreconciled lines to authorised apps. However, for **this tenant/app it is currently gated and not accessible** (confirmed in `current-state.md`). The primary gap-closer for us is the Wise/Revolut direct-API approach, not the Finance API.
- Xero's official recommendation for "apps that need raw bank statements for AI/automation: source that data directly from the bank or an accredited open-banking provider." We are already doing this.

---

## 2. Our Actual Visibility Into Unreconciled Lines

We already route around Xero's wall via the bank providers themselves:

| Source | Method | Status |
|---|---|---|
| Wise | `sync_wise_activities` → `xero_bank_statement_lines` | Working |
| Revolut | `sync_revolut_transactions` (HMAC broker) → `xero_bank_statement_lines` | Working |
| Xero Finance API (BankStatementsPlus) | `getFinanceApi()` / `sync-statements.ts` | Built but **gated** for this tenant — not reliable |
| Xero Accounting API BankStatements | `GET /api.xro/2.0/BankStatements` | 404 — does not exist |
| Xero Reports BankStatement | `GET /api.xro/2.0/Reports/BankStatement` | 401 — wrong scope |

**Conclusion**: Wise and Revolut direct APIs are the production source for unreconciled lines. Xero's own statement validates this architecture. No further work needed to see what's pending — we already see it.

---

## 3. What "Auto-Reconcile" Actually Means in Xero

The `IsReconciled` flag on **bank statement lines** is permanently read-only. But reconciliation in Xero is a **two-sided match**: the *accounting transaction* side + the *bank statement line* side. The API controls the accounting side completely. The reconciliation "tick" fires automatically when both sides line up.

So "auto-reconcile via API" = **get the accounting side perfectly formed and matched, then let Xero's own engine tick the statement line** — either via:
- Xero's **suggested matches** (human clicks OK, 1 second)
- Xero **bank rules** with auto-apply mode (zero clicks)
- Xero **JAX** AI auto-reconciliation (zero clicks, beta since Nov 2025)

The goal shifts from "programmatically tick the box" to "make the accounting side so clean that Xero ticks it itself."

---

## 4. Approaches — From Most to Least Preferred

### Approach A — Payment Allocation API (Primary Path, Sales)

**How it works:**

1. Agent reads unreconciled Wise/Revolut credit from `xero_bank_statement_lines` (already synced)
2. Matches to a PrestaShop order by amount + reference + date
3. Creates the Xero ACCREC invoice via API (Phase 3 — already built)
4. Posts `POST /Payments` allocating payment amount to invoice, bank account = Wise/Revolut account ID
5. Xero now shows this as a **suggested match** (or JAX auto-ticks it) against the bank statement line
6. Human confirms in < 1 second, or JAX does it with zero clicks

**Why this works for Intactix now:**

- Mollie is gone. Currently no card processor → no batched PSP settlements
- Customers pay by direct bank transfer to Wise/Revolut/Finsei
- Each bank statement line corresponds to **one order** (or at most a small handful for the same customer)
- Reference in the bank statement line = PS order reference = Xero invoice reference
- Amount is exact (the full invoice total)
- Xero's matcher finds this trivially

**API mechanics:**

```
POST /api.xro/2.0/Payments
{
  "Invoice": { "InvoiceID": "<xero-invoice-id>" },
  "Account": { "AccountID": "<wise-eur-bank-account-id>" },
  "Amount": 123.45,
  "Date": "2026-06-10",
  "Reference": "PS-ORDER-REF"
}
```

The payment immediately creates both:
- A `RECEIVE_MONEY` BankTransaction on the Wise account
- A payment allocation against the invoice (invoice becomes PAID)

Xero's bank-rec screen then shows the bank feed line paired with this transaction → single OK click (or JAX auto-confirm).

**Constraint to verify:** Payment API posts **immediately** (no draft state). This is the highest-risk write type. It must not fire until the Phase 4 confidence gate clears and backtesting is complete. Do NOT activate for auto-apply until precision ≥ 99% on a sample.

---

### Approach B — Enable JAX Auto-Reconciliation (Free Quick Win)

JAX (Xero's own AI, beta since Nov 2025, available on Standard+ plans) auto-reconciles statement lines with high confidence. It operates in four layers:

1. **Bank rules** (see Approach C below)
2. **Invoice match** — finds a Xero invoice/payment matching the statement line
3. **Memory** — learns from this company's own reconciliation history
4. **Prediction** — learns from patterns across Xero's 4.5M subscribers

For Intactix, the combination of Approach A (agent creates perfect invoices and payments) + JAX enabled means: the accounting side is always formed before the bank line arrives → JAX layer 2 (invoice match) fires → auto-ticked with zero human involvement.

**Enabling JAX:**
- Xero Settings → Bank accounts → select each account → turn on auto-reconciliation
- Can be enabled per-account (start with Revolut EUR Main, cleanest data)
- JAX works forward only — does not retro-reconcile historical lines

**Real-world testing notes (Digit, 10-week test 2026):**
- 60–67% auto-match on suitable files, not 80% as claimed
- Works best on: repeating transactions, unique amounts, single-invoice payments
- Worse on: complex intercompany, mixed personal/business, accounts with GST errors
- Our profile: mostly e-commerce with unique order amounts → good JAX candidate

**Recommendation**: Enable JAX on Revolut EUR Main and Wise EUR first, assess for 2 weeks, then expand. Leave Finsei (low volume) for manual review.

---

### Approach C — Bank Rules with Auto-Apply (Purchases / Recurring)

Xero bank rules can be set to **Auto-apply** — they fire without showing on the reconciliation screen. This is the closest thing to programmatic reconciliation available today.

Bank rules trigger on: description keywords, amount ranges, or contact names.

**Cannot be created via API** (separate declined feature request). Must be set up once in Xero UI.

**High-value rules to create now (manual, one-time setup):**

| Pattern | Rule trigger | Account | Tax | Mode |
|---|---|---|---|---|
| Active Ants | payee contains "Active Ants" | Fulfilment costs | EU reverse-charge | Auto-apply |
| Monta | payee contains "Monta" | Fulfilment costs | EU reverse-charge | Auto-apply |
| DSV | payee contains "DSV" | Shipping costs | EU reverse-charge | Auto-apply |
| Upwork | payee contains "Upwork" | Contractor fees | No VAT (TAX023) | Suggest |
| Bank fee patterns | description contains "fee" OR "charge" | Bank charges | No VAT | Auto-apply |

**Effect**: For every recurring supplier transaction, the bank statement line gets auto-reconciled without human involvement, before the agent even processes it. The agent's job then shifts to creating the bill (so the accounting side exists), while the rule handles the bank-feed side.

---

### Approach D — IsReconciled:true BankTransactions (No-Feed Accounts Only)

When a bank account has **no live feed connected** in Xero, you can post a BankTransaction with `IsReconciled: true` via API:

```
POST /api.xro/2.0/BankTransactions
{
  "Type": "SPEND",
  "Contact": { "ContactID": "..." },
  "BankAccount": { "AccountID": "<finsei-account-id>" },
  "IsReconciled": true,
  "Amount": 50.00,
  "Date": "2026-06-15",
  "LineItems": [...]
}
```

This creates AND reconciles the transaction in a single API call — there's no statement line to match because there's no feed.

**When this applies for Intactix:**
- Finsei (AltPay, account `376c81fd...`) — new, seldom used, unclear if direct feed is connected
- If Finsei has no Xero direct feed: use this approach for all Finsei spend → fully automated
- **Mutually exclusive with live feed**: if Finsei later gets a direct feed, this approach breaks

**Action**: Check Xero Banking → Finsei account → whether a live feed is connected. If not, IsReconciled:true is available for all Finsei transactions.

---

### Approach E — Clearing Account Pattern (Future / PSP scenario)

If Intactix gets a new card processor (Mollie replacement), payments arrive as **batched PSP payouts** — one bank line = many orders.

The per-order Payment API approach (A) fails here because the bank line doesn't correspond to one invoice.

**Clearing account pattern:**

```
Invoices (per order)  →  POST /Payments to clearing account (agent)
PSP payout (bank line) →  Xero bank rule: code to clearing account (auto-apply)
Clearing account balances to zero → nothing left to reconcile
```

This is how Stripe integration works (and how historical Mollie was handled). Set it up when a new PSP is chosen.

---

### Approach F — Browser Automation / RPA (Last Resort, ToS-gray)

The **Xero Reconcile Robot** Chrome extension exists (4.7/5 stars, Chrome Web Store) and works by:
- Scanning suggested matches on the reconciliation screen
- Clicking OK for matches where reference codes are identical on both sides, or a bank rule match is proposed

We already have Playwright in the stack (`.playwright-mcp/`). A headless browser could do the same — log in to Xero, scan the reconciliation page, click OK on exact-match items.

**Risk assessment:**
- ToS: Xero's terms prohibit screen-scraping and automated UI interaction by third-party software. The Chrome extension exists in a gray area (personal use); headless automation for business reconciliation is riskier.
- Brittleness: Any Xero UI update can break selectors without warning.
- Auditability: Browser automation produces no API audit trail in Xero's own logs.

**Verdict**: Only use if JAX is unavailable and bank rules don't cover a transaction class. Label as emergency fallback. Do not invest in maintaning it unless other approaches fail.

---

### Approach G — Revolut Expenses Sync (Purchases from Revolut Cards)

Revolut's Expenses integration pushes expense data (receipts, categories, tax rates, descriptions) directly to Xero alongside bank statement lines. Xero then shows **both sides of the reconciliation screen pre-filled** — effectively zero-click reconciliation for approved Revolut expenses.

**How to activate:**
- Revolut Business → Settings → Integrations → Xero → enable Expenses sync
- Approved expenses auto-export with coding metadata
- Xero sees the bank line AND the spend coding simultaneously → auto-suggest or JAX ticks it

**Applicable to**: Any business spend paid by Revolut card (fulfilment, marketing, SaaS subscriptions). Not applicable to Wise or Finsei.

---

## 5. Open Question — Payment Topology After Mollie

The research surfaced one open item that determines how much of Approach A is immediately buildable:

> After Mollie shut down, what is the current payment topology for online sales?

| Scenario | Implication |
|---|---|
| Customers pay by bank transfer directly to Wise/Revolut (one bank line per order) | Approach A is immediately viable. Agent posts payment per order → Xero suggests match per order → JAX ticks. Best case. |
| A new PSP is used (Stripe, Mollie replacement) and settles as lump payouts | Clearing account pattern (Approach E) required. Approach A cannot match orders to individual bank lines. |
| Mixed: some bank transfer, some PSP | Run Approach A for bank-transfer customers; set up clearing account for PSP. |

This should be confirmed from Wise/Revolut transaction history before Phase 4 is built.

---

## 6. Recommended Phase 4 Roadmap

### Immediate actions (no code, no build required)

1. **Enable JAX** on Revolut EUR Main in Xero (2 minutes in Xero UI)
2. **Set up 5–8 bank rules** with Auto-apply for recurring suppliers in Xero UI (30 minutes)
3. **Enable Revolut Expenses sync** in Revolut Business portal (5 minutes)
4. **Check Finsei feed status** in Xero → if no feed, plan IsReconciled:true for Finsei transactions

### Phase 4 build (calibration-gated, as planned)

1. **Confirm payment topology** — inspect recent Wise/Revolut transactions to confirm per-order vs. batched
2. **Backtest Payment API proposals** against historical Xero data (reconciled invoices + their Wise/Revolut statement line counterparts) — measure precision at different confidence thresholds
3. **Build payment allocation step** in apply orchestrator: after invoice is created/updated, POST `/Payments` linking invoice → bank account
4. **Gate on confidence ≥ 0.99** (not 0.95 — payment allocation has no draft state, hardest to reverse)
5. **Add nightly JAX-reconciled report** pull: query Xero's `BankTransactions?IsReconciled=true&ModifiedAfter=...` to see what JAX auto-confirmed and validate against agent proposals
6. **Clearing account pattern** as a parallel track for when the new PSP arrives

### What "done" looks like

For a typical Intactix day:
- A new online order pays by bank transfer to Wise EUR
- Agent (cron, overnight): syncs Wise transaction → matches PS order → creates Xero invoice → posts Payment allocation → bank line is now paired with a payment in Xero's rec screen
- JAX (real-time on statement arrival): sees the payment and the matching bank line → auto-reconciles
- Human review (morning): sees "JAX reconciled 12 items" on the Reconciled page, spot-checks 2–3, done in < 5 minutes

---

## 7. Competitive Intelligence — How Third-Party Tools Do It

All of ChatFin, Otto, Synder, and similar tools use **only the official Xero API**. None of them tick the reconciliation flag directly. Their model:

- ChatFin: Multi-signal matching (amount + date + reference + contact) → POST Payment to invoice → Xero suggests match → claim "92% auto-match rate" (human still confirms)
- Otto: ML matching → POST Payment → Xero suggested-match UX does the final tick
- Synder: Clearing account pattern for payment processors (Shopify, Stripe, PayPal) → cash coding in Xero UI

The tools that claim "automatic reconciliation" are really claiming "automatic preparation of the accounting side so that Xero's own UI presents a one-click confirm." None achieve the programmatic tick that the UserVoice request was asking for.

Our agent can do everything these tools do, with the additional advantage of owning the PrestaShop data for correct VAT coding — which none of the commercial tools can access.

---

## Sources

- [Reconcile via the API — Xero Developer Ideas (declined May 2026)](https://xero.uservoice.com/forums/5528-accounting-api/suggestions/2884040-reconcile-via-the-api)
- [About automatic bank reconciliation powered by JAX (BETA) — Xero Central](https://central.xero.com/s/article/About-auto-bank-reconciliation-powered-by-JAX)
- [Get a first look at automatic bank reconciliation — Xero Blog](https://blog.xero.com/product-updates/automatic-bank-reconciliation-jax-beta/)
- [Xero Auto-Reconciliation: Notes From Our Testing — Digit](https://digit.business/insights/xero/xero-auto-reconciliation-testing-notes)
- [How AI Agents Automate Bank Reconciliation in Xero — ChatFin](https://chatfin.ai/blog/how-ai-agents-automate-bank-reconciliation-in-xero-in-23-minutes-a-day/)
- [Xero + AI: How Automated Reconciliation Enhances Your Accounting Software — With Otto](https://withotto.app/blog/xero-ai-how-automated-reconciliation-enhances-your-accounting-software/)
- [Xero Bank Reconciliation Guide 2026 — bankreconciler.app](https://bankreconciler.app/blogXeroReconciliation)
- [Bank Feeds API Overview — Xero Developer](https://developer.xero.com/documentation/api/bankfeeds/overview)
- [Xero Reconcile Robot — Chrome Web Store](https://chromewebstore.google.com/detail/xero-reconcile-robot/omchihoemeblabnbpbamimnopopfllfi)
- [Revolut Xero Integration](https://www.revolut.com/business/integrations/xero-integration/)
- [Wise Xero Integration](https://wise.com/gb/business/xero)
