import { config, requireXeroConfig } from "../config.js";
import { upsertRawObject } from "../db/rawObjects.js";
import {
  backfillNormalisedLineReferences,
  deleteFinanceLinesForSource,
  finishSyncRun,
  startSyncRun,
  upsertAccount,
  upsertBankTransfer,
  upsertContact,
  upsertCreditNoteBalance,
  upsertInvoiceBalance,
  upsertReportSnapshot,
  upsertTaxRate,
  upsertTenant,
  upsertTrackingCategory
} from "../db/repositories.js";
import { isoDateDaysAgo, todayIsoDate } from "../lib/dates.js";
import { XeroClient } from "./client.js";
import {
  datedWhere,
  invoiceWhere,
  normaliseBankTransaction,
  normaliseCreditNote,
  normaliseInvoice,
  normaliseManualJournal,
  normalisePayment,
  sourceUpdatedAt
} from "./normalise.js";

type AnyRecord = Record<string, any>;

export async function syncReferenceData(): Promise<void> {
  const runId = await startSyncRun("reference");
  const counts: Record<string, number> = {};
  try {
    const client = new XeroClient();
    const tenant = await resolveXeroTenant(client);
    const tenantId = tenant.tenantId;

    const organisations = await client.getAll<AnyRecord>(tenantId, "Organisation", "Organisations");
    await upsertTenant(tenant, organisations[0]);
    counts.organisations = organisations.length;
    for (const organisation of organisations) {
      await upsertRawObject({
        tenantId,
        objectType: "ORGANISATION",
        objectId: organisation.OrganisationID ?? tenantId,
        payload: organisation
      });
    }

    const accounts = await client.getAll<AnyRecord>(tenantId, "Accounts", "Accounts");
    counts.accounts = accounts.length;
    for (const account of accounts) {
      if (!account.AccountID) continue;
      await upsertRawObject({
        tenantId,
        objectType: "ACCOUNT",
        objectId: account.AccountID,
        sourceUpdatedAt: account.UpdatedDateUTC,
        payload: account
      });
      await upsertAccount(tenantId, account);
    }

    const taxRates = await client.getAll<AnyRecord>(tenantId, "TaxRates", "TaxRates");
    counts.taxRates = taxRates.length;
    for (const taxRate of taxRates) {
      if (!taxRate.TaxType) continue;
      await upsertRawObject({ tenantId, objectType: "TAXRATE", objectId: taxRate.TaxType, payload: taxRate });
      await upsertTaxRate(tenantId, taxRate);
    }

    const contacts = await client.getAll<AnyRecord>(tenantId, "Contacts", "Contacts", {
      order: "UpdatedDateUTC ASC"
    });
    counts.contacts = contacts.length;
    for (const contact of contacts) {
      if (!contact.ContactID) continue;
      await upsertRawObject({
        tenantId,
        objectType: "CONTACT",
        objectId: contact.ContactID,
        sourceUpdatedAt: contact.UpdatedDateUTC,
        payload: contact
      });
      await upsertContact(tenantId, contact);
    }

    const trackingCategories = await client.getAll<AnyRecord>(
      tenantId,
      "TrackingCategories",
      "TrackingCategories"
    );
    counts.trackingCategories = trackingCategories.length;
    for (const category of trackingCategories) {
      if (!category.TrackingCategoryID) continue;
      await upsertRawObject({
        tenantId,
        objectType: "TRACKINGCATEGORY",
        objectId: category.TrackingCategoryID,
        payload: category
      });
      await upsertTrackingCategory(tenantId, category);
    }

    await finishSyncRun(runId, "completed", counts);
    console.log(`Reference sync completed for tenant ${tenantId}`, counts);
  } catch (error) {
    await finishSyncRun(runId, "failed", counts, error);
    throw error;
  }
}

export async function syncTransactions(startDate: string, endDate: string): Promise<void> {
  const client = new XeroClient();
  const tenant = await resolveXeroTenant(client);
  const tenantId = tenant.tenantId;
  const runId = await startSyncRun("transactions", tenantId, startDate, endDate);
  const counts: Record<string, number> = {};
  try {
    await upsertTenant(tenant);

    const accPay = await client.getAll<AnyRecord>(tenantId, "Invoices", "Invoices", {
      where: invoiceWhere("ACCPAY", startDate, endDate),
      order: "Date ASC"
    });
    counts.bills = accPay.length;
    for (const invoice of accPay) {
      await persistInvoiceLike(tenantId, invoice);
    }

    const accRec = await client.getAll<AnyRecord>(tenantId, "Invoices", "Invoices", {
      where: invoiceWhere("ACCREC", startDate, endDate),
      order: "Date ASC"
    });
    counts.invoices = accRec.length;
    for (const invoice of accRec) {
      await persistInvoiceLike(tenantId, invoice);
    }

    const bankTransactions = await client.getAll<AnyRecord>(
      tenantId,
      "BankTransactions",
      "BankTransactions",
      { where: datedWhere("Date", startDate, endDate), order: "Date ASC" }
    );
    counts.bankTransactions = bankTransactions.length;
    for (const bankTransaction of bankTransactions) {
      if (!bankTransaction.BankTransactionID) continue;
      const rawId = await upsertRawObject({
        tenantId,
        objectType: "BANKTRANSACTION",
        objectId: bankTransaction.BankTransactionID,
        sourceUpdatedAt: sourceUpdatedAt(bankTransaction),
        payload: bankTransaction
      });
      await deleteFinanceLinesForSource(tenantId, "BANKTRANSACTION", bankTransaction.BankTransactionID);
      await normaliseBankTransaction(tenantId, bankTransaction, rawId);
    }

    const payments = await client.getAll<AnyRecord>(tenantId, "Payments", "Payments", {
      where: datedWhere("Date", startDate, endDate)
    });
    counts.payments = payments.length;
    for (const payment of payments) {
      if (!payment.PaymentID) continue;
      await upsertRawObject({
        tenantId,
        objectType: "PAYMENT",
        objectId: payment.PaymentID,
        sourceUpdatedAt: sourceUpdatedAt(payment),
        payload: payment
      });
      await normalisePayment(tenantId, payment);
    }

    const creditNotes = await client.getAll<AnyRecord>(tenantId, "CreditNotes", "CreditNotes", {
      where: datedWhere("Date", startDate, endDate),
      order: "Date ASC"
    });
    counts.creditNotes = creditNotes.length;
    for (const creditNote of creditNotes) {
      if (!creditNote.CreditNoteID) continue;
      const rawId = await upsertRawObject({
        tenantId,
        objectType: "CREDITNOTE",
        objectId: creditNote.CreditNoteID,
        sourceUpdatedAt: sourceUpdatedAt(creditNote),
        payload: creditNote
      });
      await deleteFinanceLinesForSource(tenantId, "CREDITNOTE", creditNote.CreditNoteID);
      await normaliseCreditNote(tenantId, creditNote, rawId);
      await upsertCreditNoteBalance(tenantId, creditNote);
    }

    await syncOverpaymentRawObjects(client, tenantId, startDate, endDate, counts);
    await syncPrepaymentRawObjects(client, tenantId, startDate, endDate, counts);

    try {
      const manualJournals = await client.getAll<AnyRecord>(
        tenantId,
        "ManualJournals",
        "ManualJournals",
        { where: datedWhere("Date", startDate, endDate), order: "Date ASC" }
      );
      counts.manualJournals = manualJournals.length;
      for (const journal of manualJournals) {
        if (!journal.ManualJournalID) continue;
        const rawId = await upsertRawObject({
          tenantId,
          objectType: "MANUALJOURNAL",
          objectId: journal.ManualJournalID,
          sourceUpdatedAt: sourceUpdatedAt(journal),
          payload: journal
        });
        await deleteFinanceLinesForSource(tenantId, "MANUALJOURNAL", journal.ManualJournalID);
        await normaliseManualJournal(tenantId, journal, rawId);
      }
    } catch (error) {
      counts.manualJournalsSkipped = 1;
      console.warn(`Manual journals sync skipped: ${error instanceof Error ? error.message : String(error)}`);
    }

    counts.normalisedLineBackfillRows = await backfillNormalisedLineReferences(tenantId);
    await finishSyncRun(runId, "completed", counts);
    console.log(`Transaction sync completed for ${startDate} to ${endDate}`, counts);
  } catch (error) {
    await finishSyncRun(runId, "failed", counts, error);
    throw error;
  }
}

export async function syncIncremental(): Promise<void> {
  const end = todayIsoDate();
  const start = isoDateDaysAgo(config.DEFAULT_SYNC_LOOKBACK_DAYS);
  await syncReferenceData();
  await syncTransactions(start, end);

  try {
    await syncBankTransfers(start, end);
  } catch (err) {
    console.warn(`Bank transfer sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await syncReports(start, end);
  } catch (err) {
    console.warn(`Report sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (config.BANK_FEED_SOURCE === "bank_statements_plus") {
    try {
      const { syncBankStatementLines } = await import("./sync-statements.js");
      const result = await syncBankStatementLines(start, end);
      if (result.scopeError) {
        console.warn(`Finance API statement-line sync skipped. Accounting API fallback remains active. ${result.scopeErrorMessage}`);
      } else {
        console.log(
          `Bank statement lines synced: ${result.synced} lines across ${result.accountsProcessed} accounts` +
          (result.accountsSkipped > 0 ? ` (${result.accountsSkipped} skipped)` : "")
        );
      }
    } catch (err) {
      console.warn(`Bank statement lines sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log(
      "Bank feed source: accounting_api fallback mode — raw Xero statement lines are unavailable; " +
      "using bank transactions, payments, transfers, reports, and direct Wise/Revolut feeds."
    );
  }

  // Wise card activity sync — fills xero_bank_statement_lines with is_reconciled derived
  // by matching against coded Xero SPEND transactions.
  if (process.env.WISE_API_TOKEN) {
    try {
      const { syncWiseActivities } = await import("../wise/sync-activities.js");
      const wr = await syncWiseActivities(start, end);
      console.log(
        `Wise activities synced: ${wr.synced} card payments ` +
        `(${wr.reconciledCount} reconciled, ${wr.unreconciledCount} unreconciled, ${wr.skipped} skipped)`
      );
    } catch (err) {
      console.warn(`Wise activities sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Revolut transaction sync — covers EUR/GBP/USD Main accounts.
  if (process.env.REVOLUT_BROKER_HMAC) {
    try {
      const { syncRevolutTransactions } = await import("../revolut/sync-transactions.js");
      const rr = await syncRevolutTransactions(start, end);
      console.log(
        `Revolut transactions synced: ${rr.synced} ` +
        `(${rr.reconciledCount} reconciled, ${rr.unreconciledCount} unreconciled, ${rr.skipped} skipped)`
      );
    } catch (err) {
      console.warn(`Revolut sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function syncBankTransfers(startDate: string, endDate: string): Promise<void> {
  const client = new XeroClient();
  const tenant = await resolveXeroTenant(client);
  const tenantId = tenant.tenantId;
  const runId = await startSyncRun("bank-transfers", tenantId, startDate, endDate);
  const counts: Record<string, number> = {};
  try {
    await upsertTenant(tenant);
    const bankTransfers = await client.getAll<AnyRecord>(tenantId, "BankTransfers", "BankTransfers", {
      where: datedWhere("Date", startDate, endDate),
      order: "Date ASC"
    });
    counts.bankTransfers = bankTransfers.length;
    for (const bankTransfer of bankTransfers) {
      if (!bankTransfer.BankTransferID) continue;
      await upsertRawObject({
        tenantId,
        objectType: "BANKTRANSFER",
        objectId: bankTransfer.BankTransferID,
        sourceUpdatedAt: sourceUpdatedAt(bankTransfer),
        payload: bankTransfer
      });
      await upsertBankTransfer(tenantId, bankTransfer);
    }
    await finishSyncRun(runId, "completed", counts);
    console.log(`Bank transfer sync completed for ${startDate} to ${endDate}`, counts);
  } catch (error) {
    await finishSyncRun(runId, "failed", counts, error);
    throw error;
  }
}

export async function syncReports(startDate: string, endDate: string): Promise<void> {
  const client = new XeroClient();
  const tenant = await resolveXeroTenant(client);
  const tenantId = tenant.tenantId;
  const runId = await startSyncRun("reports", tenantId, startDate, endDate);
  const counts: Record<string, number> = {};
  try {
    await upsertTenant(tenant);
    const reportRequests = [
      {
        type: "PROFIT_AND_LOSS",
        path: `Reports/ProfitAndLoss?fromDate=${encodeURIComponent(startDate)}&toDate=${encodeURIComponent(endDate)}`,
        periodStart: startDate,
        periodEnd: endDate
      },
      {
        type: "BALANCE_SHEET",
        path: `Reports/BalanceSheet?date=${encodeURIComponent(endDate)}`,
        periodStart: null,
        periodEnd: endDate
      },
      {
        type: "TRIAL_BALANCE",
        path: `Reports/TrialBalance?date=${encodeURIComponent(endDate)}`,
        periodStart: null,
        periodEnd: endDate
      }
    ];

    for (const request of reportRequests) {
      const payload = await client.getAccounting(tenantId, request.path);
      await upsertRawObject({
        tenantId,
        objectType: `REPORT_${request.type}`,
        objectId: `${request.type}:${startDate}:${endDate}`,
        payload
      });
      await upsertReportSnapshot({
        tenantId,
        reportType: request.type,
        reportDate: endDate,
        periodStart: request.periodStart,
        periodEnd: request.periodEnd,
        currencyCode: reportCurrencyCode(payload),
        payload
      });
      counts[request.type] = 1;
    }
    await finishSyncRun(runId, "completed", counts);
    console.log(`Report sync completed for ${startDate} to ${endDate}`, counts);
  } catch (error) {
    await finishSyncRun(runId, "failed", counts, error);
    throw error;
  }
}

async function resolveXeroTenant(client: XeroClient): Promise<AnyRecord> {
  const tenants = await client.getTenants();
  const desiredTenantId = requireXeroConfig().tenantId;
  const tenant = desiredTenantId
    ? tenants.find((item) => item.tenantId === desiredTenantId)
    : tenants[0];
  if (!tenant) {
    throw new Error(
      desiredTenantId
        ? `Xero tenant ${desiredTenantId} was not accessible`
        : "No Xero tenants were accessible"
    );
  }
  return tenant;
}

async function persistInvoiceLike(tenantId: string, invoice: AnyRecord) {
  if (!invoice.InvoiceID) return;
  const sourceType = invoice.Type === "ACCPAY" ? "BILL" : "INVOICE";
  const rawId = await upsertRawObject({
    tenantId,
    objectType: sourceType,
    objectId: invoice.InvoiceID,
    sourceUpdatedAt: sourceUpdatedAt(invoice),
    payload: invoice
  });
  await deleteFinanceLinesForSource(tenantId, sourceType, invoice.InvoiceID);
  await normaliseInvoice(tenantId, invoice, rawId);
  await upsertInvoiceBalance(tenantId, invoice);
}

async function syncOverpaymentRawObjects(
  client: XeroClient,
  tenantId: string,
  startDate: string,
  endDate: string,
  counts: Record<string, number>
) {
  try {
    const overpayments = await client.getAll<AnyRecord>(tenantId, "Overpayments", "Overpayments", {
      where: datedWhere("Date", startDate, endDate),
      order: "Date ASC"
    });
    counts.overpayments = overpayments.length;
    for (const overpayment of overpayments) {
      if (!overpayment.OverpaymentID) continue;
      await upsertRawObject({
        tenantId,
        objectType: "OVERPAYMENT",
        objectId: overpayment.OverpaymentID,
        sourceUpdatedAt: sourceUpdatedAt(overpayment),
        payload: overpayment
      });
    }
  } catch (error) {
    counts.overpaymentsSkipped = 1;
    console.warn(`Overpayments sync skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function syncPrepaymentRawObjects(
  client: XeroClient,
  tenantId: string,
  startDate: string,
  endDate: string,
  counts: Record<string, number>
) {
  try {
    const prepayments = await client.getAll<AnyRecord>(tenantId, "Prepayments", "Prepayments", {
      where: datedWhere("Date", startDate, endDate),
      order: "Date ASC"
    });
    counts.prepayments = prepayments.length;
    for (const prepayment of prepayments) {
      if (!prepayment.PrepaymentID) continue;
      await upsertRawObject({
        tenantId,
        objectType: "PREPAYMENT",
        objectId: prepayment.PrepaymentID,
        sourceUpdatedAt: sourceUpdatedAt(prepayment),
        payload: prepayment
      });
    }
  } catch (error) {
    counts.prepaymentsSkipped = 1;
    console.warn(`Prepayments sync skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function reportCurrencyCode(payload: AnyRecord): string | null {
  const report = Array.isArray(payload.Reports) ? payload.Reports[0] : null;
  if (!report) return null;
  if (typeof report.ReportTitles?.[1] === "string") {
    const match = /\b[A-Z]{3}\b/.exec(report.ReportTitles[1]);
    if (match) return match[0];
  }
  return report.ReportCurrency ?? report.CurrencyCode ?? null;
}
