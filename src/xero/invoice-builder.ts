import { psQuery } from "../presta/pool.js";
import { query } from "../db/mysql.js";
import { config } from "../config.js";
import { COUNTRY_VAT_RULES } from "../vat/rates.js";

const PS = config.PS_TABLE_PREFIX;

const BRANDING_THEME_ID = "61f9feba-43dd-4e80-bd27-40a0f9b54d43";
const CUSTOMER_SHIPPING_REVENUE_ACCOUNT = "208";

export interface PsOrderSummary {
  id_order: number;
  reference: string;
  invoice_number: string | null;
  date_add: string;
  id_currency: number;         // 2=EUR, 3=GBP
  total_paid_tax_incl: number;
  total_paid_tax_excl: number;
  total_shipping_tax_incl: number;
  ship_country: string;
  customer_firstname: string;
  customer_lastname: string;
}

export interface InvoiceBuildResult {
  status: "ok" | "flagged";
  flag?: string;
  payload?: object;
  psReference: string;
  psInvoiceNumber: string | null;
}

export async function buildInvoiceFromPsOrder(
  ps: PsOrderSummary,
  eurAmountOverride?: number
): Promise<InvoiceBuildResult> {
  const { reference, invoice_number, date_add, id_currency, ship_country } = ps;

  const currencyCode = invoiceCurrencyCode(id_currency, eurAmountOverride);
  if (!currencyCode) {
    return {
      status: "flagged",
      flag: `UNKNOWN_CURRENCY: PS id_currency=${id_currency} for order ${reference} — human must confirm invoice currency`,
      psReference: reference,
      psInvoiceNumber: invoice_number,
    };
  }

  // --- Country rule ---
  const rule = COUNTRY_VAT_RULES[ship_country];
  if (!rule) {
    return {
      status: "flagged",
      flag: `UNKNOWN_COUNTRY: ${ship_country} has no entry in COUNTRY_VAT_RULES — human must confirm coding`,
      psReference: reference,
      psInvoiceNumber: invoice_number,
    };
  }
  if (!rule.taxType) {
    return {
      status: "flagged",
      flag: `MISSING_XERO_RATE: ${ship_country} is known but has no Xero tax type configured — create the tax rate in Xero, then update COUNTRY_VAT_RULES`,
      psReference: reference,
      psInvoiceNumber: invoice_number,
    };
  }

  // --- Amounts (invoice currency) ---
  let totalIncl: number;
  let shippingIncl: number;

  if (id_currency === 3 && eurAmountOverride != null) {
    // Confirmed GBP conversion: preserve shipping proportion from PS.
    const shippingRatio =
      ps.total_paid_tax_incl > 0 ? ps.total_shipping_tax_incl / ps.total_paid_tax_incl : 0;
    totalIncl = eurAmountOverride;
    shippingIncl = Math.round(eurAmountOverride * shippingRatio * 100) / 100;
  } else {
    totalIncl = round2(Number(ps.total_paid_tax_incl));
    shippingIncl = round2(Number(ps.total_shipping_tax_incl));
  }

  const productsIncl = round2(totalIncl - shippingIncl);

  // --- Invoice date / due date ---
  // MySQL returns DATETIME as a JS Date object; normalise to YYYY-MM-DD string.
  const rawDate = date_add as unknown;
  const invoiceDate = rawDate instanceof Date
    ? rawDate.toISOString().substring(0, 10)
    : String(rawDate).substring(0, 10);
  const dueDate = addDays(invoiceDate, 14);

  // --- Contact resolution ---
  // Prefer ContactID from warehouse to avoid creating duplicate Xero contacts on POST.
  const contactName = `${ps.customer_firstname} ${ps.customer_lastname}`.trim() || "Unknown";
  const contact = await resolveContact(contactName);

  // --- Line items ---
  const lineItems: object[] = [];

  lineItems.push({
    Description: "Products",
    UnitAmount: productsIncl,
    AccountCode: rule.accountCode,
    TaxType: rule.taxType,
    Quantity: 1,
  });

  if (shippingIncl > 0) {
    lineItems.push({
      Description: "Shipping",
      UnitAmount: shippingIncl,
      AccountCode: CUSTOMER_SHIPPING_REVENUE_ACCOUNT,
      TaxType: rule.taxType,
      Quantity: 1,
    });
  }

  const payload = {
    Type: "ACCREC",
    Status: "DRAFT",
    Contact: contact,
    Reference: reference,
    InvoiceNumber: invoice_number ?? undefined,
    DateString: invoiceDate,
    DueDateString: dueDate,
    CurrencyCode: currencyCode,
    ...(currencyCode === "EUR" ? { CurrencyRate: 1 } : {}),
    LineAmountTypes: "Inclusive",
    BrandingThemeID: BRANDING_THEME_ID,
    LineItems: lineItems,
  };

  return {
    status: "ok",
    payload,
    psReference: reference,
    psInvoiceNumber: invoice_number,
  };
}

/**
 * Resolve a Xero contact by name from the local warehouse.
 * Returns { ContactID, Name } if unique match found, else { Name } (bare name fallback).
 * Bare-name fallback: Xero will attempt to match by name server-side; creates new if no match.
 */
async function resolveContact(name: string): Promise<{ ContactID?: string; Name: string }> {
  const rows = await query<any[]>(
    `SELECT contact_id FROM xero_contacts WHERE LOWER(name) = LOWER(?) AND status != 'ARCHIVED' LIMIT 2`,
    [name]
  );
  if (rows.length === 1) {
    return { ContactID: rows[0].contact_id, Name: name };
  }
  // Multiple matches or none — fall back to bare name so Xero resolves it
  return { Name: name };
}

export async function loadPsOrderForInvoice(reference: string): Promise<PsOrderSummary | null> {
  const rows = await psQuery<any[]>(
    `SELECT o.id_order, o.reference,
            oi.number as invoice_number,
            COALESCE(oi.date_add, o.date_add) as date_add, o.id_currency,
            o.total_paid_tax_incl, o.total_paid_tax_excl, o.total_shipping_tax_incl,
            co.iso_code as ship_country,
            c.firstname as customer_firstname, c.lastname as customer_lastname
     FROM ${PS}orders o
     LEFT JOIN ${PS}order_invoice oi ON oi.id_order = o.id_order
     JOIN ${PS}address a ON o.id_address_delivery = a.id_address
     JOIN ${PS}country co ON a.id_country = co.id_country
     JOIN ${PS}customer c ON o.id_customer = c.id_customer
     WHERE o.reference = ?
     LIMIT 1`,
    [reference]
  );
  return rows[0] ?? null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function invoiceCurrencyCode(idCurrency: number, eurAmountOverride?: number): "EUR" | "GBP" | null {
  if (idCurrency === 2) return "EUR";
  if (idCurrency === 3 && eurAmountOverride != null) return "EUR";
  if (idCurrency === 3) return "GBP";
  return null;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().substring(0, 10);
}
