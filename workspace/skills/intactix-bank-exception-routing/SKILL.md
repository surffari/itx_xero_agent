---
name: "intactix-bank-exception-routing"
description: "Route Intactix bank exceptions and GBP PS matches"
---

# Intactix Bank Exception Routing

Use this skill when reconciling Intactix bank transactions, rebuilding unmatched-transaction Excel workbooks, or classifying missing receipts/supporting evidence.

## Exception workbook format

When producing an Excel workbook for transactions that could not be automatically matched, separate missing supporting evidence by responsible person:

- `Missing receipts - Jani`
- `Missing receipts - Mari`

Keep transaction context columns visible for each row:

- account
- currency
- amount
- to/from party
- description/reference
- reason for not auto-matching

## Card-spend routing

All Revolut card usage goes to Mari unless a stronger explicit source says otherwise.

Wise card-spend ownership can continue to use existing cardholder detection rules from the transaction reference.

## GBP PrestaShop sales matching

GBP PS invoices do not require human EUR-amount confirmation when all of these are true:

1. The PS order is made in GBP.
2. The payment is into a GBP bank account.
3. The Xero invoice is in GBP.
4. The PS order reference is present in the bank transaction reference or description.
5. The GBP payment amount matches the GBP invoice/order amount according to the reconciliation engine.

This is the accepted flow: `GBP order -> GBP payment -> GBP invoice`.

Only require a human currency-amount confirmation when a bill/invoice is paid from an account with a different currency than the related invoice currency. In that case, reconcile the transaction in the currency it was actually paid in and do not invent FX rates.

## Intra-account transfer recognition

Treat queue item `284` as a known-good example of an intra-account transfer pattern. A description like:

`REV TO WIS EUR6000 | To INTACTIX B.V. | REV TO WIS EUR6000 | To INTACTIX B.V.`

means EUR 6000 was transferred from the Revolut EUR account to the Wise EUR account. Do not classify this as supplier/customer spend. Reconcile or report it as an own-bank transfer pattern.
