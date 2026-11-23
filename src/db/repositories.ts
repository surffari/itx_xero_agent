import { ResultSetHeader } from "mysql2";
import { getPool } from "./mysql.js";
import { toMysqlDate, toMysqlDateTime } from "../lib/dates.js";
import { cleanText, getBoolean, getNumber, getString, stringifyJson } from "../lib/json.js";
import { AuditFindingInput } from "../types.js";

type AnyRecord = Record<string, any>;

export async function upsertTenant(tenant: AnyRecord, organisation?: AnyRecord) {
  await getPool().execute(
    `
    INSERT INTO xero_tenants (
      tenant_id, tenant_name, tenant_type, organisation_id, organisation_name,
      base_currency_code, country_code, raw_payload, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      tenant_name = VALUES(tenant_name),
      tenant_type = VALUES(tenant_type),
      organisation_id = VALUES(organisation_id),
      organisation_name = VALUES(organisation_name),
      base_currency_code = VALUES(base_currency_code),
      country_code = VALUES(country_code),
      raw_payload = VALUES(raw_payload),
      fetched_at = CURRENT_TIMESTAMP
    `,
    [
      tenant.tenantId,
      tenant.tenantName ?? null,
      tenant.tenantType,
      organisation?.OrganisationID ?? null,
      organisation?.Name ?? null,
      organisation?.BaseCurrency ?? null,
      organisation?.CountryCode ?? null,
      stringifyJson({ tenant, organisation: organisation ?? null })
    ]
  );
}

export async function getBaseCurrency(tenantId: string): Promise<string | null> {
  const [rows] = await getPool().query<any[]>(
    "SELECT base_currency_code FROM xero_tenants WHERE tenant_id = ?",
    [tenantId]
  );
  return rows[0]?.base_currency_code ?? null;
}

export async function upsertAccount(tenantId: string, account: AnyRecord) {
  await getPool().execute(
    `
    INSERT INTO xero_accounts (
      tenant_id, account_id, code, name, type, class, status, tax_type, description,
      enable_payments_to_account, show_in_expense_claims, source_updated_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      code = VALUES(code),
      name = VALUES(name),
      type = VALUES(type),
      class = VALUES(class),
      status = VALUES(status),
      tax_type = VALUES(tax_type),
      description = VALUES(description),
      enable_payments_to_account = VALUES(enable_payments_to_account),
      show_in_expense_claims = VALUES(show_in_expense_claims),
      source_updated_at = VALUES(source_updated_at),
      payload = VALUES(payload)
    `,
    [
      tenantId,
      account.AccountID,
      account.Code ?? null,
      account.Name ?? "(unnamed account)",
      account.Type ?? null,
      account.Class ?? null,
      account.Status ?? null,
      account.TaxType ?? null,
      account.Description ?? null,
      getBoolean(account.EnablePaymentsToAccount),
      getBoolean(account.ShowInExpenseClaims),
      toMysqlDateTime(account.UpdatedDateUTC),
      stringifyJson(account)
    ]
  );
}

export async function upsertTaxRate(tenantId: string, taxRate: AnyRecord) {
  await getPool().execute(
    `
    INSERT INTO xero_tax_rates (
      tenant_id, tax_type, name, status, effective_rate,
      can_apply_to_assets, can_apply_to_equity, can_apply_to_expenses,
      can_apply_to_liabilities, can_apply_to_revenue, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      status = VALUES(status),
      effective_rate = VALUES(effective_rate),
      can_apply_to_assets = VALUES(can_apply_to_assets),
      can_apply_to_equity = VALUES(can_apply_to_equity),
      can_apply_to_expenses = VALUES(can_apply_to_expenses),
      can_apply_to_liabilities = VALUES(can_apply_to_liabilities),
      can_apply_to_revenue = VALUES(can_apply_to_revenue),
      payload = VALUES(payload)
    `,
    [
      tenantId,
      taxRate.TaxType,
      taxRate.Name ?? null,
      taxRate.Status ?? null,
      getNumber(taxRate.EffectiveRate),
      getBoolean(taxRate.CanApplyToAssets),
      getBoolean(taxRate.CanApplyToEquity),
      getBoolean(taxRate.CanApplyToExpenses),
      getBoolean(taxRate.CanApplyToLiabilities),
      getBoolean(taxRate.CanApplyToRevenue),
      stringifyJson(taxRate)
    ]
  );
}

export async function upsertContact(tenantId: string, contact: AnyRecord) {
  await getPool().execute(
    `
    INSERT INTO xero_contacts (
      tenant_id, contact_id, contact_number, name, email_address, status,
      is_supplier, is_customer, tax_number, source_updated_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      contact_number = VALUES(contact_number),
      name = VALUES(name),
      email_address = VALUES(email_address),
      status = VALUES(status),
      is_supplier = VALUES(is_supplier),
      is_customer = VALUES(is_customer),
      tax_number = VALUES(tax_number),
      source_updated_at = VALUES(source_updated_at),
      payload = VALUES(payload)
    `,
    [
      tenantId,
      contact.ContactID,
      contact.ContactNumber ?? null,
      contact.Name ?? "(unnamed contact)",
      contact.EmailAddress ?? null,
      contact.ContactStatus ?? null,
      getBoolean(contact.IsSupplier),
      getBoolean(contact.IsCustomer),
      contact.TaxNumber ?? null,
      toMysqlDateTime(contact.UpdatedDateUTC),
      stringifyJson(contact)
    ]
  );
}

export async function upsertTrackingCategory(tenantId: string, category: AnyRecord) {
  await getPool().execute(
    `
    INSERT INTO xero_tracking_categories (
      tenant_id, tracking_category_id, name, status, options_json, payload
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      status = VALUES(status),
      options_json = VALUES(options_json),
      payload = VALUES(payload)
    `,
    [
      tenantId,
      category.TrackingCategoryID,
      category.Name ?? "(unnamed tracking category)",
      category.Status ?? null,
      stringifyJson(category.Options ?? []),
      stringifyJson(category)
    ]
  );
}

export async function deleteFinanceLinesForSource(tenantId: string, sourceType: string, sourceId: string) {
  await getPool().execute(
    "DELETE FROM finance_transaction_lines WHERE tenant_id = ? AND source_type = ? AND source_id = ?",
    [tenantId, sourceType, sourceId]
  );
}

export async function upsertFinanceLine(line: AnyRecord) {
  await getPool().execute(
    `
    INSERT INTO finance_transaction_lines (
      tenant_id, source_type, transaction_subtype, source_id, source_line_id,
      transaction_date, due_date, paid_date,
      status, contact_id, contact_name, account_id, account_code, account_name, account_type,
      account_class, description, reference, invoice_number, tax_type, tax_rate_name,
      currency_code, line_amount, tax_amount, gross_amount, base_currency_code,
      base_line_amount, base_tax_amount, base_gross_amount, tracking_category_1,
      tracking_option_1, tracking_category_2, tracking_option_2, is_reconciled,
      bank_account_id, bank_account_code, bank_account_name, raw_object_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON DUPLICATE KEY UPDATE
      transaction_subtype = VALUES(transaction_subtype),
      transaction_date = VALUES(transaction_date),
      due_date = VALUES(due_date),
      paid_date = VALUES(paid_date),
      status = VALUES(status),
      contact_id = VALUES(contact_id),
      contact_name = VALUES(contact_name),
      account_id = VALUES(account_id),
      account_code = VALUES(account_code),
      account_name = VALUES(account_name),
      account_type = VALUES(account_type),
      account_class = VALUES(account_class),
      description = VALUES(description),
      reference = VALUES(reference),
      invoice_number = VALUES(invoice_number),
      tax_type = VALUES(tax_type),
      tax_rate_name = VALUES(tax_rate_name),
      currency_code = VALUES(currency_code),
      line_amount = VALUES(line_amount),
      tax_amount = VALUES(tax_amount),
      gross_amount = VALUES(gross_amount),
      base_currency_code = VALUES(base_currency_code),
      base_line_amount = VALUES(base_line_amount),
      base_tax_amount = VALUES(base_tax_amount),
      base_gross_amount = VALUES(base_gross_amount),
      tracking_category_1 = VALUES(tracking_category_1),
      tracking_option_1 = VALUES(tracking_option_1),
      tracking_category_2 = VALUES(tracking_category_2),
      tracking_option_2 = VALUES(tracking_option_2),
      is_reconciled = VALUES(is_reconciled),
      bank_account_id = VALUES(bank_account_id),
      bank_account_code = VALUES(bank_account_code),
      bank_account_name = VALUES(bank_account_name),
      raw_object_id = VALUES(raw_object_id)
    `,
    [
      line.tenantId,
      line.sourceType,
      line.transactionSubtype ?? null,
      line.sourceId,
      line.sourceLineId,
      toMysqlDate(line.transactionDate),
      toMysqlDate(line.dueDate),
      toMysqlDate(line.paidDate),
      line.status ?? null,
      line.contactId ?? null,
      line.contactName ?? null,
      line.accountId ?? null,
      line.accountCode ?? null,
      line.accountName ?? null,
      line.accountType ?? null,
      line.accountClass ?? null,
      cleanText(line.description),
      line.reference ?? null,
      line.invoiceNumber ?? null,
      line.taxType ?? null,
      line.taxRateName ?? null,
      line.currencyCode ?? null,
      line.lineAmount ?? null,
      line.taxAmount ?? null,
      line.grossAmount ?? null,
      line.baseCurrencyCode ?? null,
      line.baseLineAmount ?? null,
      line.baseTaxAmount ?? null,
      line.baseGrossAmount ?? null,
      line.trackingCategory1 ?? null,
      line.trackingOption1 ?? null,
      line.trackingCategory2 ?? null,
      line.trackingOption2 ?? null,
      line.isReconciled ?? null,
      line.bankAccountId ?? null,
      line.bankAccountCode ?? null,
      line.bankAccountName ?? null,
      line.rawObjectId ?? null
    ]
  );
}

export async function upsertPayment(tenantId: string, payment: AnyRecord) {
  const invoice = payment.Invoice ?? payment.CreditNote ?? null;
  const account = payment.Account ?? null;
  const contact = invoice?.Contact ?? payment.Contact ?? null;
  await getPool().execute(
    `
    INSERT INTO xero_payments (
      tenant_id, payment_id, source_type, source_id, payment_date, contact_id, contact_name,
      account_id, account_code, account_name, reference, currency_code, amount,
      is_reconciled, status, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      source_type = VALUES(source_type),
      source_id = VALUES(source_id),
      payment_date = VALUES(payment_date),
      contact_id = VALUES(contact_id),
      contact_name = VALUES(contact_name),
      account_id = VALUES(account_id),
      account_code = VALUES(account_code),
      account_name = VALUES(account_name),
      reference = VALUES(reference),
      currency_code = VALUES(currency_code),
      amount = VALUES(amount),
      is_reconciled = VALUES(is_reconciled),
      status = VALUES(status),
      payload = VALUES(payload)
    `,
    [
      tenantId,
      payment.PaymentID,
      invoice?.Type ?? (payment.CreditNote ? "CREDITNOTE" : null),
      invoice?.InvoiceID ?? invoice?.CreditNoteID ?? null,
      toMysqlDate(payment.Date),
      contact?.ContactID ?? null,
      contact?.Name ?? null,
      account?.AccountID ?? null,
      account?.Code ?? null,
      account?.Name ?? null,
      payment.Reference ?? null,
      payment.CurrencyCode ?? invoice?.CurrencyCode ?? null,
      getNumber(payment.Amount),
      getBoolean(payment.IsReconciled),
      payment.Status ?? null,
      stringifyJson(payment)
    ]
  );
}

export async function upsertInvoiceBalance(tenantId: string, invoice: AnyRecord) {
  const contact = invoice.Contact ?? null;
  await getPool().execute(
    `
    INSERT INTO xero_invoice_balances (
      tenant_id, invoice_id, invoice_type, invoice_number, reference, contact_id, contact_name,
      invoice_date, due_date, paid_date, expected_payment_date, status, currency_code,
      sub_total, total_tax, total, amount_due, amount_paid, amount_credited,
      source_updated_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      invoice_type = VALUES(invoice_type),
      invoice_number = VALUES(invoice_number),
      reference = VALUES(reference),
      contact_id = VALUES(contact_id),
      contact_name = VALUES(contact_name),
      invoice_date = VALUES(invoice_date),
      due_date = VALUES(due_date),
      paid_date = VALUES(paid_date),
      expected_payment_date = VALUES(expected_payment_date),
      status = VALUES(status),
      currency_code = VALUES(currency_code),
      sub_total = VALUES(sub_total),
      total_tax = VALUES(total_tax),
      total = VALUES(total),
      amount_due = VALUES(amount_due),
      amount_paid = VALUES(amount_paid),
      amount_credited = VALUES(amount_credited),
      source_updated_at = VALUES(source_updated_at),
      payload = VALUES(payload)
    `,
    [
      tenantId,
      invoice.InvoiceID,
      invoice.Type ?? null,
      invoice.InvoiceNumber ?? null,
      invoice.Reference ?? null,
      contact?.ContactID ?? null,
      contact?.Name ?? null,
      toMysqlDate(invoice.Date),
      toMysqlDate(invoice.DueDate),
      toMysqlDate(invoice.FullyPaidOnDate),
      toMysqlDate(invoice.ExpectedPaymentDate),
      invoice.Status ?? null,
      invoice.CurrencyCode ?? null,
      getNumber(invoice.SubTotal),
      getNumber(invoice.TotalTax),
      getNumber(invoice.Total),
      getNumber(invoice.AmountDue),
      getNumber(invoice.AmountPaid),
      getNumber(invoice.AmountCredited),
      toMysqlDateTime(invoice.UpdatedDateUTC),
      stringifyJson(invoice)
    ]
  );
}

export async function upsertCreditNoteBalance(tenantId: string, creditNote: AnyRecord) {
  const contact = creditNote.Contact ?? null;
  const appliedAmount = Array.isArray(creditNote.Allocations)
    ? creditNote.Allocations.reduce((sum: number, allocation: AnyRecord) => sum + (getNumber(allocation.Amount) ?? 0), 0)
    : null;
  await getPool().execute(
    `
    INSERT INTO xero_credit_note_balances (
      tenant_id, credit_note_id, credit_note_type, credit_note_number, reference, contact_id,
      contact_name, credit_note_date, status, currency_code, sub_total, total_tax, total,
      remaining_credit, applied_amount, source_updated_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      credit_note_type = VALUES(credit_note_type),
      credit_note_number = VALUES(credit_note_number),
      reference = VALUES(reference),
      contact_id = VALUES(contact_id),
      contact_name = VALUES(contact_name),
      credit_note_date = VALUES(credit_note_date),
      status = VALUES(status),
      currency_code = VALUES(currency_code),
      sub_total = VALUES(sub_total),
      total_tax = VALUES(total_tax),
      total = VALUES(total),
      remaining_credit = VALUES(remaining_credit),
      applied_amount = VALUES(applied_amount),
      source_updated_at = VALUES(source_updated_at),
      payload = VALUES(payload)
    `,
    [
      tenantId,
      creditNote.CreditNoteID,
      creditNote.Type ?? null,
      creditNote.CreditNoteNumber ?? null,
      creditNote.Reference ?? null,
      contact?.ContactID ?? null,
      contact?.Name ?? null,
      toMysqlDate(creditNote.Date),
      creditNote.Status ?? null,
      creditNote.CurrencyCode ?? null,
      getNumber(creditNote.SubTotal),
      getNumber(creditNote.TotalTax),
      getNumber(creditNote.Total),
      getNumber(creditNote.RemainingCredit),
      appliedAmount,
      toMysqlDateTime(creditNote.UpdatedDateUTC),
      stringifyJson(creditNote)
    ]
  );
}

export async function upsertBankTransfer(tenantId: string, bankTransfer: AnyRecord) {
  const fromAccount = bankTransfer.FromBankAccount ?? {};
  const toAccount = bankTransfer.ToBankAccount ?? {};
  await getPool().execute(
    `
    INSERT INTO xero_bank_transfers (
      tenant_id, bank_transfer_id, transfer_date, from_bank_account_id, from_bank_account_code,
      from_bank_account_name, to_bank_account_id, to_bank_account_code, to_bank_account_name,
      amount, currency_code, from_amount, to_amount, from_currency_code, to_currency_code,
      reference, is_reconciled, source_updated_at, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      transfer_date = VALUES(transfer_date),
      from_bank_account_id = VALUES(from_bank_account_id),
      from_bank_account_code = VALUES(from_bank_account_code),
      from_bank_account_name = VALUES(from_bank_account_name),
      to_bank_account_id = VALUES(to_bank_account_id),
      to_bank_account_code = VALUES(to_bank_account_code),
      to_bank_account_name = VALUES(to_bank_account_name),
      amount = VALUES(amount),
      currency_code = VALUES(currency_code),
      from_amount = VALUES(from_amount),
      to_amount = VALUES(to_amount),
      from_currency_code = VALUES(from_currency_code),
      to_currency_code = VALUES(to_currency_code),
      reference = VALUES(reference),
      is_reconciled = VALUES(is_reconciled),
      source_updated_at = VALUES(source_updated_at),
      payload = VALUES(payload)
    `,
    [
      tenantId,
      bankTransfer.BankTransferID,
      toMysqlDate(bankTransfer.Date),
      fromAccount.AccountID ?? null,
      fromAccount.Code ?? null,
      fromAccount.Name ?? null,
      toAccount.AccountID ?? null,
      toAccount.Code ?? null,
      toAccount.Name ?? null,
      getNumber(bankTransfer.Amount),
      bankTransfer.CurrencyCode ?? null,
      getNumber(bankTransfer.FromAmount),
      getNumber(bankTransfer.ToAmount),
      bankTransfer.FromCurrencyCode ?? fromAccount.CurrencyCode ?? null,
      bankTransfer.ToCurrencyCode ?? toAccount.CurrencyCode ?? null,
      bankTransfer.Reference ?? null,
      getBoolean(bankTransfer.IsReconciled),
      toMysqlDateTime(bankTransfer.UpdatedDateUTC),
      stringifyJson(bankTransfer)
    ]
  );
}

export async function upsertReportSnapshot(input: {
  tenantId: string;
  reportType: string;
  reportDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  currencyCode?: string | null;
  payload: AnyRecord;
}) {
  await getPool().execute(
    `
    INSERT INTO xero_report_snapshots (
      tenant_id, report_type, report_date, period_start, period_end, currency_code, payload, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      payload = VALUES(payload),
      fetched_at = CURRENT_TIMESTAMP
    `,
    [
      input.tenantId,
      input.reportType,
      toMysqlDate(input.reportDate),
      toMysqlDate(input.periodStart) ?? "1000-01-01",
      toMysqlDate(input.periodEnd) ?? "1000-01-01",
      input.currencyCode ?? "",
      stringifyJson(input.payload)
    ]
  );
}

export async function backfillNormalisedLineReferences(tenantId?: string): Promise<number> {
  const [result] = await getPool().execute<ResultSetHeader>(
    `
    UPDATE finance_transaction_lines l
    LEFT JOIN xero_accounts aid
      ON aid.tenant_id = l.tenant_id AND aid.account_id = l.account_id
    LEFT JOIN xero_accounts acode
      ON acode.tenant_id = l.tenant_id AND acode.code = l.account_code AND aid.account_id IS NULL
    LEFT JOIN xero_tax_rates tr
      ON tr.tenant_id = l.tenant_id AND tr.tax_type = l.tax_type
    LEFT JOIN xero_contacts c
      ON c.tenant_id = l.tenant_id AND c.contact_id = l.contact_id
    LEFT JOIN xero_tenants t
      ON t.tenant_id = l.tenant_id
    SET
      l.account_id = COALESCE(NULLIF(l.account_id, ''), aid.account_id, acode.account_id),
      l.account_code = COALESCE(NULLIF(l.account_code, ''), aid.code, acode.code),
      l.account_name = COALESCE(NULLIF(l.account_name, ''), aid.name, acode.name),
      l.account_type = COALESCE(NULLIF(l.account_type, ''), aid.type, acode.type),
      l.account_class = COALESCE(NULLIF(l.account_class, ''), aid.class, acode.class),
      l.tax_rate_name = COALESCE(NULLIF(l.tax_rate_name, ''), tr.name),
      l.contact_name = COALESCE(NULLIF(l.contact_name, ''), c.name),
      l.base_currency_code = COALESCE(NULLIF(l.base_currency_code, ''), t.base_currency_code, l.currency_code),
      l.base_line_amount = COALESCE(l.base_line_amount, l.line_amount),
      l.base_tax_amount = COALESCE(l.base_tax_amount, l.tax_amount),
      l.base_gross_amount = COALESCE(l.base_gross_amount, l.gross_amount, COALESCE(l.line_amount, 0) + COALESCE(l.tax_amount, 0))
    WHERE
      (? IS NULL OR l.tenant_id = ?)
      AND (
        l.account_name IS NULL OR l.account_name = ''
        OR l.account_type IS NULL OR l.account_type = ''
        OR l.account_class IS NULL OR l.account_class = ''
        OR l.tax_rate_name IS NULL OR l.tax_rate_name = ''
        OR l.contact_name IS NULL OR l.contact_name = ''
        OR l.base_currency_code IS NULL OR l.base_currency_code = ''
        OR l.base_line_amount IS NULL
        OR l.base_tax_amount IS NULL
        OR l.base_gross_amount IS NULL
      )
    `,
    [tenantId ?? null, tenantId ?? null]
  );
  return result.affectedRows;
}

export async function startSyncRun(
  syncType: string,
  tenantId?: string,
  periodStart?: string | null,
  periodEnd?: string | null
): Promise<number> {
  const [result] = await getPool().execute<ResultSetHeader>(
    "INSERT INTO xero_sync_runs (tenant_id, sync_type, period_start, period_end) VALUES (?, ?, ?, ?)",
    [tenantId ?? null, syncType, periodStart ?? null, periodEnd ?? null]
  );
  return result.insertId;
}

export async function finishSyncRun(
  id: number,
  status: "completed" | "failed",
  objectCounts?: unknown,
  error?: unknown
) {
  await getPool().execute(
    `
    UPDATE xero_sync_runs
    SET status = ?, completed_at = CURRENT_TIMESTAMP, object_counts = ?, error_message = ?
    WHERE id = ?
    `,
    [
      status,
      stringifyJson(objectCounts ?? {}),
      error ? String(error instanceof Error ? error.message : error) : null,
      id
    ]
  );
}

export async function startAuditRun(
  tenantId: string,
  auditType: string,
  periodStart?: string | null,
  periodEnd?: string | null
): Promise<number> {
  const [result] = await getPool().execute<ResultSetHeader>(
    "INSERT INTO finance_audit_runs (tenant_id, audit_type, period_start, period_end) VALUES (?, ?, ?, ?)",
    [tenantId, auditType, periodStart ?? null, periodEnd ?? null]
  );
  return result.insertId;
}

export async function insertAuditFinding(tenantId: string, runId: number, finding: AuditFindingInput) {
  await getPool().execute(
    `
    INSERT INTO finance_audit_findings (
      audit_run_id, tenant_id, finding_type, severity, confidence, period_start, period_end,
      account_code, account_name, contact_id, contact_name, source_type, source_id, amount,
      currency_code, finding_summary, evidence_json, recommended_action
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      runId,
      tenantId,
      finding.findingType,
      finding.severity,
      finding.confidence,
      finding.periodStart ?? null,
      finding.periodEnd ?? null,
      finding.accountCode ?? null,
      finding.accountName ?? null,
      finding.contactId ?? null,
      finding.contactName ?? null,
      finding.sourceType ?? null,
      finding.sourceId ?? null,
      finding.amount ?? null,
      finding.currencyCode ?? null,
      finding.findingSummary,
      stringifyJson(finding.evidenceJson ?? {}),
      finding.recommendedAction ?? null
    ]
  );
}

export async function finishAuditRun(runId: number, status: "completed" | "failed", error?: unknown) {
  await getPool().execute(
    `
    UPDATE finance_audit_runs r
    SET status = ?,
        completed_at = CURRENT_TIMESTAMP,
        finding_count = (SELECT COUNT(*) FROM finance_audit_findings f WHERE f.audit_run_id = r.id),
        error_message = ?
    WHERE r.id = ?
    `,
    [status, error ? String(error instanceof Error ? error.message : error) : null, runId]
  );
}

export async function resolveTenantId(preferred?: string): Promise<string> {
  if (preferred) return preferred;
  const [rows] = await getPool().query<any[]>(
    "SELECT tenant_id FROM xero_tenants ORDER BY fetched_at DESC LIMIT 1"
  );
  if (!rows[0]?.tenant_id) {
    throw new Error("No tenant known yet. Run `npm run sync:reference` first or set XERO_TENANT_ID.");
  }
  return rows[0].tenant_id;
}

export function stringOrFallback(value: unknown, fallback: string): string {
  return getString(value) ?? fallback;
}
