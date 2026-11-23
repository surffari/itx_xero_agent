# Phase 2 Investigation — PrestaShop Data Access: DB vs REST

Investigation date: 2026-06-21  
Status: **Complete — mixed-mode decision confirmed**

---

## Decision: mixed mode (DB primary, REST for generated artifacts)

The agent uses **direct MySQL read** for all structured transactional data and **PS Webservice REST**
only for resources that PS generates on demand and cannot be read from raw DB tables. The split is
clean and stable — the boundary is: "is this data that lives in a table, or is it something PS
renders/generates?"

Connection config: `PS_BI_HOST`, `PS_BI_DATABASE` (default `gopure_bi`), prefix `pscw_`.

---

## Use case map

### DB — all structured transactional data

| Use case | PS tables | Fields used | Notes |
|---|---|---|---|
| Fetch order header | `pscw_orders` | `id_order, reference, date_add, id_currency, total_paid_tax_incl, total_paid_tax_excl, total_shipping_tax_incl, current_state, id_address_delivery, id_address_invoice, id_customer, id_carrier` | Core order identity + amounts |
| Ship-to country (VAT determination) | `pscw_orders → pscw_address → pscw_country` | `id_address_delivery → id_country → iso_code` | Authoritative VAT input; Xero does not have this |
| Product/shipping split | `pscw_orders` | `total_paid_tax_incl − total_shipping_tax_incl` | Two Xero line items per invoice |
| Product line items | `pscw_order_detail` | `product_name, product_quantity, tax_rate, total_price_tax_excl, total_price_tax_incl` | OSS rate validation; detailed invoice lines |
| Invoice number | `pscw_order_invoice` | `number` (numeric) | Maps to Xero `InvoiceNumber` |
| Invoice date | `pscw_order_invoice` | `date_add` | Use for invoice date if different from order date |
| Order state filter | `pscw_orders → pscw_order_state` | `invoice = 1` flag | Only process invoiced orders |
| Customer name | `pscw_orders → pscw_customer` | `firstname, lastname` | Xero contact resolution |
| Customer email | `pscw_customer` | `email` | Xero contact creation |
| Billing address | `pscw_orders → pscw_address (id_address_invoice)` | `address1, city, postcode, id_country` | Xero contact address |
| GBP → EUR rate | `pscw_orders` | `conversion_rate` | EUR equivalent for GBP orders (verify reliability) |
| Refunds / credit slips | `pscw_order_slip` | `total_products_tax_incl, total_shipping_tax_incl, date_add` | For Xero credit notes |
| Returns | `pscw_order_return` | `date_add, state` | Partial return tracking |
| Carrier / shipping method | `pscw_orders → pscw_carrier` | `name` | Shipping cost analysis |
| Currency details | `pscw_currency` | `iso_code, conversion_rate` | FX context |
| Product SKU / reference | `pscw_product` | `reference` | SKU-level matching if needed later |
| Delivery country for all orders | Batch query on `pscw_address → pscw_country` | `iso_code` | Bulk OSS country breakdown |

**All of the above are DB queries. Fast, read-only, no PS server load beyond a DB connection.**

### REST/Webservice — generated and rendered artifacts

| Use case | Endpoint | Notes |
|---|---|---|
| Invoice PDF (attach to Xero) | `GET /api/order_invoices/{id_order_invoice}?output_format=PDF&ws_key={KEY}` or `GET /pdf.php?id_order_invoice={id}&token={token}` | PS generates the PDF on demand. Cannot be read from DB tables. Returns binary PDF. |
| Credit slip PDF | `GET /api/order_slip/{id_order_slip}?output_format=PDF&ws_key={KEY}` | Same pattern for credit note attachments. |
| Product images (if ever needed) | `GET /api/images/products/{id_product}/{id_image}` | Low priority; not in current scope. |

**Webservice requires a PS API key** (not the DB credentials). Store as `PS_WEBSERVICE_KEY` in `.env`.
The PS installation must have webservice enabled (Preferences → Webservice → Enable). Verify against
the staging and live sites before Phase 3.

---

## PDF attach workflow (Phase 3)

When creating a Xero invoice for a PS order:

1. Create the invoice in Xero (DRAFT) using DB data → get back `invoice_id`.
2. Look up `ps_order_invoice.id_order_invoice` for this order from DB.
3. Call PS webservice: `GET /api/order_invoices/{id_order_invoice}?output_format=PDF&ws_key=...`
4. POST the binary PDF to Xero Attachments API: `POST /api.xro/2.0/Invoices/{invoice_id}/Attachments/{filename}`
5. Log attachment in audit JSONL.

If the PDF call fails (PS webservice down, key expired): log the failure but do NOT block invoice
creation. The invoice is still correct without the PDF; the attachment is a convenience.

PDF scope needed in Xero OAuth: `accounting.attachments` (to be requested in Phase 3).

---

## What PS data is NOT needed (scope guard)

- Order messages / customer communications → not relevant to accounting.
- Stock levels / warehouse quantities → PS is not the inventory system of record for Xero purposes.
- Product catalog pricing → not used for invoicing (order totals come from order tables).
- Loyalty points, vouchers, cart rules → voucher amounts are already reflected in order totals; the
  split is in line items if needed, but accounting-level treatment is: discount reduces revenue,
  already in the total.
- Customer browsing / session data → no accounting use.
- PS employee/staff records → not relevant.

---

## Environment variables to add

```env
# Already present:
PS_BI_HOST=127.0.0.1
PS_BI_PORT=3306
PS_BI_DATABASE=gopure_bi
PS_BI_USER=gp_bi_user
PS_BI_PASSWORD=...
PS_TABLE_PREFIX=pscw_

# Add for Phase 3 (PDF attach):
PS_WEBSERVICE_KEY=...          # PS API key with order_invoices read permission
PS_WEBSERVICE_BASE_URL=https://gopure.shop   # live; use staging for dev
```

## Staging vs live note

The agent connects to `gopure_bi` (live PS BI replica). For development and testing, configure
`PS_BI_DATABASE` to point at the staging DB equivalent. PDF attach testing must use the staging PS
webservice URL and a staging-specific API key. Never test PDF fetches against the live site unless
in an approved production run.

---

## Summary

| Resource type | Access method | Reason |
|---|---|---|
| All order/line/customer/currency data | MySQL DB (direct read) | Fast, structured, already connected |
| Invoice PDF | PS Webservice REST (GET) | PS generates on demand; not in DB |
| Credit slip PDF | PS Webservice REST (GET) | Same |
| Everything else | DB | No REST equivalent needed |
