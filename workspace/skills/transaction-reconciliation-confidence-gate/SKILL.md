---
name: "transaction-reconciliation-confidence-gate"
description: "Xero reconciliation confidence workflow"
---

# Proposed update: Multicurrency Supplier File Sweep

Add this section to `transaction-reconciliation-confidence-gate` under **Multicurrency Handling** or immediately after **Mandatory Xero Inbox Audit**.

## Multicurrency Supplier File Sweep

Use this sweep before declaring a supplier's USD-invoice/EUR-payment set complete, especially for recurring contractors such as Paulo Tomas.

When the supplier sends foreign-currency invoices but payment leaves a EUR Wise/Revolut/bank account:

1. Search by supplier/contact/payee first, but do not stop there.
2. Widen the Xero inbox audit across the full requested period plus 14 days either side.
3. Include `new` and `processing` inbox files even when extraction is null.
4. Search generic date-style filenames as candidates, not only supplier names:
   - `Invoice DD-MM-YYYY.pdf`
   - `GP Invoice DD-MM-YYYY.pdf`
   - `invoice` with uploaded date near the invoice/payment date
5. Build a candidate grid from every source before applying:
   - inbox filename, uploaded date, status, extracted fields if any
   - existing ACCPAY bills by contact, invoice number, reference, date, currency, status, total
   - successful and dry-run `CREATE_BILL` write-log entries
   - Wise/provider activities and bank statement debit lines
6. Treat the foreign invoice amount as matching evidence, not the bill currency, when the actual Xero bank movement is EUR.
7. If Wise/provider evidence shows a gross EUR debit and Xero records a separate Wise/card fee, create the bill for the net supplier amount only: gross debit minus separately recorded Xero fee.
8. Before summarising, reconcile the expected count: every plausible invoice file in the date series must be classified as one of:
   - already paid/existing bill
   - draft bill created
   - ready to draft after dry-run
   - duplicate/not applicable, with reason
   - blocked, with exact missing evidence
9. Do not say only N files exist when generic `new`/`processing` date-style invoices remain unclassified in the period.

High-confidence Paulo-style rule:

A Paulo Tomas invoice can be matched to an EUR bank payment without matching reference text when there is exactly one plausible invoice/payment pair by invoice date or nearby payment date, USD invoice amount, EUR Wise/bank movement, and no competing Paulo invoice in the same window. Use account `480` and tax `TAX023` unless a newer supplier profile or human instruction says otherwise. The bill should be in EUR when the Xero bank transaction to reconcile is in EUR.
