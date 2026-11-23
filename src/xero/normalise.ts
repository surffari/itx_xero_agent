import { getBaseCurrency, upsertFinanceLine, upsertPayment } from "../db/repositories.js";
import { toMysqlDate } from "../lib/dates.js";
import { getNumber } from "../lib/json.js";

type AnyRecord = Record<string, any>;

function tracking(line: AnyRecord) {
  const categories = Array.isArray(line.Tracking) ? line.Tracking : [];
  return {
    trackingCategory1: categories[0]?.Name ?? null,
    trackingOption1: categories[0]?.Option ?? null,
    trackingCategory2: categories[1]?.Name ?? null,
    trackingOption2: categories[1]?.Option ?? null
  };
}

function amountFields(source: AnyRecord, line: AnyRecord, baseCurrencyCode: string | null) {
  const lineAmount = getNumber(line.LineAmount) ?? 0;
  const taxAmount = getNumber(line.TaxAmount) ?? 0;
  const grossAmount = lineAmount + taxAmount;
  const currencyRate = getNumber(source.CurrencyRate) ?? 1;
  const currencyCode = source.CurrencyCode ?? baseCurrencyCode;
  const isBase = !baseCurrencyCode || !currencyCode || currencyCode === baseCurrencyCode;
  return {
    currencyCode,
    lineAmount,
    taxAmount,
    grossAmount,
    baseCurrencyCode,
    baseLineAmount: isBase ? lineAmount : lineAmount * currencyRate,
    baseTaxAmount: isBase ? taxAmount : taxAmount * currencyRate,
    baseGrossAmount: isBase ? grossAmount : grossAmount * currencyRate
  };
}

export async function normaliseInvoice(tenantId: string, invoice: AnyRecord, rawObjectId: number) {
  const baseCurrencyCode = await getBaseCurrency(tenantId);
  const contact = invoice.Contact ?? {};
  const lines = Array.isArray(invoice.LineItems) ? invoice.LineItems : [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const account = line.Account ?? {};
    const sourceType = invoice.Type === "ACCPAY" ? "BILL" : "INVOICE";
    await upsertFinanceLine({
      tenantId,
      sourceType,
      sourceId: invoice.InvoiceID,
      sourceLineId: line.LineItemID ?? `${invoice.InvoiceID}:${index}`,
      transactionDate: invoice.Date,
      dueDate: invoice.DueDate,
      paidDate: invoice.FullyPaidOnDate,
      status: invoice.Status,
      contactId: contact.ContactID ?? null,
      contactName: contact.Name ?? null,
      accountId: line.AccountID ?? account.AccountID ?? null,
      accountCode: line.AccountCode ?? account.Code ?? null,
      accountName: account.Name ?? null,
      accountType: account.Type ?? null,
      accountClass: account.Class ?? null,
      description: line.Description ?? invoice.Reference ?? invoice.InvoiceNumber ?? null,
      reference: invoice.Reference ?? null,
      invoiceNumber: invoice.InvoiceNumber ?? null,
      taxType: line.TaxType ?? null,
      taxRateName: line.TaxName ?? null,
      ...amountFields(invoice, line, baseCurrencyCode),
      ...tracking(line),
      rawObjectId
    });
  }
}

export async function normaliseBankTransaction(
  tenantId: string,
  bankTransaction: AnyRecord,
  rawObjectId: number
) {
  const baseCurrencyCode = await getBaseCurrency(tenantId);
  const contact = bankTransaction.Contact ?? {};
  const bankAccount = bankTransaction.BankAccount ?? {};
  const lines = Array.isArray(bankTransaction.LineItems) ? bankTransaction.LineItems : [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const account = line.Account ?? {};
    await upsertFinanceLine({
      tenantId,
      sourceType: "BANKTRANSACTION",
      transactionSubtype: bankTransaction.Type ?? null,
      sourceId: bankTransaction.BankTransactionID,
      sourceLineId: line.LineItemID ?? `${bankTransaction.BankTransactionID}:${index}`,
      transactionDate: bankTransaction.Date,
      status: bankTransaction.Status,
      contactId: contact.ContactID ?? null,
      contactName: contact.Name ?? null,
      accountId: line.AccountID ?? account.AccountID ?? null,
      accountCode: line.AccountCode ?? account.Code ?? null,
      accountName: account.Name ?? null,
      accountType: account.Type ?? null,
      accountClass: account.Class ?? null,
      description: line.Description ?? bankTransaction.Reference ?? null,
      reference: bankTransaction.Reference ?? null,
      taxType: line.TaxType ?? null,
      taxRateName: line.TaxName ?? null,
      ...amountFields(bankTransaction, line, baseCurrencyCode),
      ...tracking(line),
      isReconciled: bankTransaction.IsReconciled,
      bankAccountId: bankAccount.AccountID ?? null,
      bankAccountCode: bankAccount.Code ?? null,
      bankAccountName: bankAccount.Name ?? null,
      rawObjectId
    });
  }
}

export async function normaliseCreditNote(tenantId: string, creditNote: AnyRecord, rawObjectId: number) {
  const baseCurrencyCode = await getBaseCurrency(tenantId);
  const contact = creditNote.Contact ?? {};
  const lines = Array.isArray(creditNote.LineItems) ? creditNote.LineItems : [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const account = line.Account ?? {};
    await upsertFinanceLine({
      tenantId,
      sourceType: "CREDITNOTE",
      sourceId: creditNote.CreditNoteID,
      sourceLineId: line.LineItemID ?? `${creditNote.CreditNoteID}:${index}`,
      transactionDate: creditNote.Date,
      status: creditNote.Status,
      contactId: contact.ContactID ?? null,
      contactName: contact.Name ?? null,
      accountId: line.AccountID ?? account.AccountID ?? null,
      accountCode: line.AccountCode ?? account.Code ?? null,
      accountName: account.Name ?? null,
      accountType: account.Type ?? null,
      accountClass: account.Class ?? null,
      description: line.Description ?? creditNote.Reference ?? null,
      reference: creditNote.Reference ?? null,
      taxType: line.TaxType ?? null,
      taxRateName: line.TaxName ?? null,
      ...amountFields(creditNote, line, baseCurrencyCode),
      ...tracking(line),
      rawObjectId
    });
  }
}

export async function normaliseManualJournal(tenantId: string, journal: AnyRecord, rawObjectId: number) {
  const baseCurrencyCode = await getBaseCurrency(tenantId);
  const lines = Array.isArray(journal.JournalLines) ? journal.JournalLines : [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const account = line.Account ?? {};
    await upsertFinanceLine({
      tenantId,
      sourceType: "MANUALJOURNAL",
      sourceId: journal.ManualJournalID,
      sourceLineId: line.LineItemID ?? `${journal.ManualJournalID}:${index}`,
      transactionDate: journal.Date,
      status: journal.Status,
      accountId: line.AccountID ?? account.AccountID ?? null,
      accountCode: line.AccountCode ?? account.Code ?? null,
      accountName: account.Name ?? null,
      accountType: account.Type ?? null,
      accountClass: account.Class ?? null,
      description: line.Description ?? journal.Narration ?? null,
      reference: journal.Narration ?? null,
      taxType: line.TaxType ?? null,
      taxRateName: line.TaxName ?? null,
      currencyCode: baseCurrencyCode,
      lineAmount: getNumber(line.LineAmount) ?? 0,
      taxAmount: getNumber(line.TaxAmount) ?? 0,
      grossAmount: (getNumber(line.LineAmount) ?? 0) + (getNumber(line.TaxAmount) ?? 0),
      baseCurrencyCode,
      baseLineAmount: getNumber(line.LineAmount) ?? 0,
      baseTaxAmount: getNumber(line.TaxAmount) ?? 0,
      baseGrossAmount: (getNumber(line.LineAmount) ?? 0) + (getNumber(line.TaxAmount) ?? 0),
      ...tracking(line),
      rawObjectId
    });
  }
}

export async function normalisePayment(tenantId: string, payment: AnyRecord) {
  await upsertPayment(tenantId, payment);
}

export function invoiceWhere(type: "ACCPAY" | "ACCREC", start: string, end: string) {
  return `Type=="${type}"&&Date>=DateTime(${start.replaceAll("-", ",")})&&Date<=DateTime(${end.replaceAll("-", ",")})`;
}

export function datedWhere(field: string, start: string, end: string) {
  return `${field}>=DateTime(${start.replaceAll("-", ",")})&&${field}<=DateTime(${end.replaceAll("-", ",")})`;
}

export function sourceUpdatedAt(payload: AnyRecord): string | null {
  return payload.UpdatedDateUTC ?? payload.UpdatedDateUtc ?? payload.Date ?? null;
}

export function xeroDate(value: unknown): string | null {
  return toMysqlDate(value);
}
