# Phase 2 Investigation — Canonical PS ↔ Xero ↔ Bank Match Key

Investigation date: 2026-06-21  
Status: **Complete — canonical key defined and validated**

---

## Canonical match triple

```
PS order (ps_orders.id_order)
  ← identified by → ps_orders.reference       (e.g. "GPEU12345")
  ↔ (primary join key)
Xero ACCREC invoice (xero_invoice_balances.invoice_id)
  ← matched on →    xero_invoice_balances.reference = ps_orders.reference
  ← validated by →  xero_invoice_balances.invoice_number = ps_order_invoice.number
  ← amount check →  |xero_total − ps_total_paid_tax_incl| / xero_total < 0.01
  ↔
Xero payment (xero_payments)
  ← linked via →    xero_payments.source_id = xero_invoice_balances.invoice_id
  ← amount check →  xero_payments.amount ≈ xero_invoice_balances.total
  ↔
Bank account ledger (xero_payments.account_id)
  ← maps to →       100 Wise EUR / 101 Wise USD / 102 Wise GBP
                     110 Revolut EUR / 111 Revolut USD / 112 Revolut GBP
                     120 Finsei
```

## Validation (Phase 1)

The engine ran a full reconciliation for 2026-01-01 → 2026-06-21:
- **221 ACCREC invoices** processed; **0 XERO_ONLY** (all had PS matches by reference).
- Match status breakdown: all were `MATCHED` or `REF_MATCH_INV_DIFF` (invoice number format diff).
- Decision queue for ACCREC in this period: 0 items.

The PS `reference` ↔ Xero `Reference` join is **reliable and complete** for this dataset.

## Edge cases and handling

### REF_MATCH_INV_DIFF

PS `invoice_number` (numeric, e.g. `12345`) does not equal Xero `invoice_number` (format `INV-0123`).
This happens when a Xero invoice was created manually (a VA typed "INV-0123" instead of copying the
PS invoice number). The reference still matches so the order is found; the confidence is reduced
(0.80 if amount agrees vs 0.65) and the status is logged for review.

**Action:** when the agent creates Xero invoices in Phase 3, it must set `InvoiceNumber` to the
PS invoice number (the numeric value from `ps_order_invoice.number`), ensuring future matches are
`MATCHED` not `REF_MATCH_INV_DIFF`.

### XERO_ONLY (no PS match)

A Xero invoice where no PS order shares the same reference. Likely causes:
1. B2B or manual sale (no PS order exists).
2. Reference copied incorrectly when creating the Xero invoice manually.
3. PS order in a different currency or store not in scope.

These always go to the decision queue with full evidence. The agent asks whether this is a non-PS
sale or a reference mismatch.

### PS orphans (PS invoice, no Xero invoice)

A PS order in `invoice=1` state with no Xero invoice by reference. Likely causes:
1. Invoice not yet created in Xero (the normal backlog the agent is meant to fill).
2. Xero invoice created with a different reference format.

These are recorded in `reconciliation_ps_orphans`. In Phase 3, these are the primary input list
for the invoice creation workflow.

### Multiple payments per invoice

The engine currently takes the single latest payment (`ORDER BY payment_date DESC LIMIT 1`). Xero
allows multiple partial payments on a single invoice. This is a known limitation:

**Action (Phase 3):** when creating or allocating payments, sum all `xero_payments` rows for a
given `source_id` to determine total paid, not just the latest. The `amount_paid` field on
`xero_invoice_balances` already aggregates this correctly — use that for balance checks.

### GBP orders

PS orders with `id_currency = 3` (GBP) are invoiced in EUR in Xero (Intactix books in EUR). The
PS total in GBP does not match the Xero total in EUR so the amount check is meaningless without FX.
The invoice builder gates on `GBP_NO_EUR_AMOUNT` until a EUR amount is provided.

**Action (Phase 3):** check whether `ps_currency_rate` at order time is stored in the PS DB
(it should be in `ps_orders.conversion_rate`). If reliable, the agent can compute `EUR =
GBP_total / conversion_rate` and use that without human input for most GBP orders. Verify
against known completed GBP invoices before enabling.

### Invoice date alignment

PS `date_add` is order creation date (UTC). Xero `invoice_date` is set to whatever was entered
when the invoice was created manually. For historical invoices, these may differ by days (weekend
batch processing, etc.). The engine uses `date_add >= periodStart` and `date_add < periodEnd + 1`
for the PS query. Date proximity is not currently a match-score signal; it should be added as a
tiebreaker if a reference ever collides (which PS prevents by design, but is worth guarding).

## Primary key mapping table

| Field | PS source | Xero destination | Notes |
|---|---|---|---|
| Order reference | `ps_orders.reference` | `Invoice.Reference` | Primary join key |
| Invoice number | `ps_order_invoice.number` | `Invoice.InvoiceNumber` | Format must match |
| Invoice date | `ps_orders.date_add` (YYYY-MM-DD) | `Invoice.DateString` | Use order date |
| Due date | `date_add + 14 days` | `Invoice.DueDateString` | Standard terms |
| Total incl. tax (EUR) | `ps_orders.total_paid_tax_incl` | `Invoice.SubTotal + TotalTax` | Amount validation |
| Shipping amount | `ps_orders.total_shipping_tax_incl` | Line item "Shipping" | Split from products |
| Ship-to country | `ps_address.id_country → ps_country.iso_code` | (not in Xero) | VAT code source |
| Tax code | derived from ship_country → COUNTRY_RULES | `LineItem.TaxType` | Per-country OSS |
| Product account code | derived from ship_country -> COUNTRY_RULES | Products `LineItem.AccountCode` | 207/200; 235 is decommissioned |
| Shipping account code | fixed customer-shipping account | Shipping `LineItem.AccountCode` | 208 when shipping amount > 0; no Shipping line when shipping is zero |
| Customer name | `ps_customer.firstname + lastname` | `Contact.Name` | Contact resolution |
| Payment link | (from Xero payment API) | `xero_payments.source_id = invoice_id` | Bank match |

## Idempotency key design (for Phase 3)

Every Xero invoice creation must be idempotent. The deterministic key is:

```
idempotency_key = sha256(`CREATE_ACCREC:${ps_order_reference}:${tenant_id}`)
```

Before creating: check `xero_invoice_balances` for an existing row with
`reference = ps_order_reference AND invoice_type = 'ACCREC' AND status NOT IN ('DELETED','VOIDED')`.
If found: skip creation, log "already exists", link the existing invoice_id to the reconciliation
result. The idempotency key is a belt; this existence check is the braces.
