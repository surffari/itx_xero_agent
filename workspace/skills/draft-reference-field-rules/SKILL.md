---
name: "draft-reference-field-rules"
description: "Reference-field rules for draft invoices and bills."
---

# Draft Reference Field Rules

## Purpose
Ensure every Xero draft record carries the most useful external reference for matching, review, supplier lookup, and audit.

A draft invoice or bill should have a `Reference` whenever a reliable reference is visible on the source document or can be derived from related evidence such as the bank transaction reference, supplier portal/payment record, receipt number, order ID, or subscription reference.

Do not leave `Reference` blank merely because the supplier document calls the value something else. If the evidence gives a stable identifier that a human could use to find the transaction again, use it.

## Sales Invoice Drafts (ACCREC)
When creating draft sales invoices for online sales, set the Xero invoice `Reference` field to the original order reference whenever available.

For PrestaShop/GoPure online orders:
- Use the PS order reference as the Xero invoice `Reference`.
- Keep the PS invoice number as the Xero `InvoiceNumber` when that is the established local pattern.
- Treat the order reference as part of the idempotency and matching evidence; do not omit it from the draft.

## Supplier Bill Drafts (ACCPAY)
When creating or recoding draft supplier bills from supplier invoices, receipts, or bank-spend evidence, extract and use a supplier-side reference whenever one is visible or can be reliably derived.

Reference priority:
1. Payment or transaction reference shown on the bank line or supplier payment record, when it clearly links to the supplier document.
2. Supplier invoice number / invoice reference.
3. Supplier receipt number, payment receipt number, or charge ID.
4. Order ID, booking reference, subscription ID, account reference, or similar document identifier.
5. Other stable supplier-side identifier that can be used to retrieve the charge later.

If multiple candidate references exist, prefer the one most likely to appear on the bank line, card statement, supplier portal, or payment receipt. Preserve the supplier's formatting unless it contains obvious surrounding labels or whitespace.

Example: for an OpenAI receipt showing invoice number `CB6F8812-0034` and receipt number `2685-4027-6377`, use `CB6F8812-0034` as the bill `Reference` unless the bank transaction line or payment record clearly uses the receipt number instead.

## Derived References
A reference may be derived from evidence outside the PDF/image itself when the link is reliable. Examples:
- A bank transaction reference tied to the bill amount/date/supplier.
- A card statement reference that matches the supplier receipt.
- A supplier portal charge/payment ID for the same transaction.

Record the derived value in Xero `Reference`; mention in the review summary that it was derived and from where when this is material to human review.

## Unclear Cases
If no reliable reference can be extracted or derived, leave the field blank or use the existing local fallback pattern, and surface the missing reference in the review summary.

If two references are plausible and neither clearly wins, pick the one most likely to support bank matching and mention the alternative in the review summary.

Do not invent references.
