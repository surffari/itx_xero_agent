# Intactix Future Accounting Action Plan

Snapshot date: 2026-05-10

Purpose: track non-urgent accounting cleanup, automation, and reporting work that should not block current reconciliation.

## Current Status

Done:

- Tradethno `INV-0172` corrected to `310 Cost of Goods Sold` with `No VAT`; VA re-reconciliation remains operational.
- Bank account codes assigned for Wise/Revolut/Finsei.
- `002 Freelancer & Contractor Costs` changed to `480 Contractor & Freelance Services`.
- `850 Suspense` reviewed as okay for current known rows.
- `429 General Business Expenses` cleanup policy defined.

## Reporting Fixes

1. Update current-state reports to exclude `DELETED` and `VOIDED` rows unless the report is explicitly a historical audit trail.
2. Update unclassified spend logic so revenue accounts, especially `200 Export Sales`, do not appear as spend.
3. Split no-account/no-tax reporting into separate buckets:
   - deleted/voided rows,
   - bank-transfer mechanics,
   - historical zero-value shipping placeholders created before the no-zero-shipping-line rule,
   - actual material uncoded supplier bills.
4. Add rule tests for high-risk mappings:
   - Tradethno customer vs supplier flow,
   - `200` sales-only rule,
   - raw materials/products to `310`,
   - owner/entity services to `705`,
   - contractors to `480`,
   - Kuura normal services to `485`,
   - Mollie/future processor fees to `405`.

## Chart Cleanup

Recommended archive/hide review candidates if they have no live Xero use and accountant agrees:

| Code | Account | Current view |
|---|---|---|
| `REVFEES` | Revolut Merchant Fees | Archive/hide; Revolut is not merchant acquiring now |
| `REVPAYM` | Revolut Merchant Payments | Archive/hide; Revolut is not merchant acquiring now |
| `270` | Interest Income | Archive/hide if no expected interest income reporting |
| `400` | Advertising | Archive/hide if no direct ad spend planned; otherwise keep for future marketing |
| `408` | Cleaning | Archive/hide |
| `433` | Insurance | Archive/hide unless policy invoices expected |
| `445` | Light, Power, Heating | Archive/hide |
| `449` | Motor Vehicle Expenses | Archive/hide |
| `461` | Printing & Stationery | Archive/hide |
| `469` | Rent | Archive/hide |
| `473` | Repairs and Maintenance | Archive/hide |
| `489` | Telephone & Internet | Archive/hide |
| `900` | Loan | Archive/hide if no term loan exists or is expected |

Keep or accountant-confirm before archive:

| Code | Account | Reason |
|---|---|---|
| `416` | Depreciation | Needed if fixed assets exist or are added later |
| `477` | Wages and Salaries | Payroll/control default; archive only if accountant confirms no payroll |
| `478` | Superannuation | Payroll/control default; archive only if accountant confirms no payroll |
| `497` | Bank Revaluations | FX/reporting account |
| `498` | Unrealised Currency Gains | FX/reporting account |
| `499` | Realised Currency Gains | FX/reporting account |
| `505` | Income Tax Expense | Tax/year-end reporting |
| `610` | Accounts Receivable | System/control account |
| `620` | Prepayments | Keep unless accountant confirms not needed |
| `630` | Inventory | Keep for potential stock-on-hand adjustments |
| `710` / `711` | Office Equipment / Accumulated Depreciation | Fixed asset defaults; archive only with accountant approval |
| `720` / `721` | Computer Equipment / Accumulated Depreciation | Fixed asset defaults; archive only with accountant approval |
| `800` | Accounts Payable | System/control account |
| `801` | Unpaid Expense Claims | System/control/default account |
| `803` | Wages Payable | Payroll/control default |
| `825` / `826` | Employee Tax/Superannuation Payable | Payroll/control default |
| `830` | Income Tax Payable | Tax/year-end reporting |
| `840` | Historical Adjustment | System/conversion account |
| `860` | Rounding | System/control account |
| `877` | Tracking Transfers | Internal/control use; accountant confirmation |
| `881` / `883` | Shareholder Capital Contribution | Equity/liability tracking |
| `882` | Shareholder Loan (Mari) | Related-party balance tracking |
| `960` | Retained Earnings | System/equity account |
| `970` | Owner A Share Capital | Equity account |

## Xero API Work

Rename `705 Owner Billing` to `705 Owner / Related Entity Services`.

Known local account ID:

- `377e669c-25dc-46ef-a269-e5fec5c19388`

Xero API approach:

- Endpoint: Accounting API account update, `/Accounts/{AccountID}`
- Required scope: `accounting.settings`
- Current local integration scope: read-only `accounting.settings.read`
- Required implementation step: add a deliberate write command and re-authorise OAuth with `accounting.settings`

Payload concept:

```json
{
  "Accounts": [
    {
      "AccountID": "377e669c-25dc-46ef-a269-e5fec5c19388",
      "Code": "705",
      "Name": "Owner / Related Entity Services",
      "Type": "EXPENSE",
      "TaxType": "TAX023"
    }
  ]
}
```

## Data Imports

Use `order-payment-shipping-import-prompt.md` to import/add ecommerce order, payment, and shipping data before answering:

- shipping subsidy,
- true payment processor fee percentage,
- gross margin by country/order/payment method,
- customer shipping charged versus carrier/fulfilment cost.
