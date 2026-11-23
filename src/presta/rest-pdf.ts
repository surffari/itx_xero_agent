import { createHmac } from "node:crypto";
import { execute } from "../db/mysql.js";
import { config } from "../config.js";
import { psQuery } from "./pool.js";

const PS = config.PS_TABLE_PREFIX;

export interface PdfResult {
  buffer: Buffer;
  filename: string;
  idOrderInvoice: number;
}

/**
 * Fetch a PS-generated invoice PDF.
 * Preferred route: HMAC-protected Intactix PrestaShop module endpoint.
 * Fallback route: legacy PS webservice, guarded because it may return XML metadata.
 * Non-blocking: returns null on any failure so callers can proceed without the PDF.
 * Logs failures to xero_write_log for audit visibility.
 */
export async function fetchInvoicePdf(
  psOrderId: number,
  idempotencyKeyPrefix: string,
  tenantId: string
): Promise<PdfResult | null> {
  // Look up id_order_invoice from PS DB
  const rows = await psQuery<any[]>(
    `SELECT id_order_invoice FROM ${PS}order_invoice WHERE id_order = ? LIMIT 1`,
    [psOrderId]
  );
  const idOrderInvoice: number | undefined = rows[0]?.id_order_invoice;
  if (!idOrderInvoice) {
    return null;
  }

  const ikey = `${idempotencyKeyPrefix}:pdf:${idOrderInvoice}`;
  const errors: string[] = [];
  const psBaseUrl = getPrestaShopBaseUrl();

  if (config.PS_PDF_ENDPOINT_URL && config.PS_PDF_HMAC_SECRET) {
    try {
      const pdf = await fetchInvoicePdfFromModule(psBaseUrl, idOrderInvoice);
      return { buffer: pdf, filename: `PS-Invoice-${idOrderInvoice}.pdf`, idOrderInvoice };
    } catch (err) {
      errors.push(String(err));
    }
  }

  if (config.PS_WEBSERVICE_KEY && psBaseUrl) {
    try {
      const pdf = await fetchInvoicePdfFromWebservice(psBaseUrl, idOrderInvoice);
      return { buffer: pdf, filename: `PS-Invoice-${idOrderInvoice}.pdf`, idOrderInvoice };
    } catch (err) {
      errors.push(String(err));
    }
  }

  if (errors.length > 0) {
    await execute(
      `INSERT INTO xero_write_log
         (tenant_id, operation, idempotency_key, dry_run, status, request_payload)
       VALUES (?, 'ATTACH_PDF', ?, 0, 'error', ?)
       ON DUPLICATE KEY UPDATE status='error', request_payload=VALUES(request_payload)`,
      [tenantId, ikey, JSON.stringify({ errors, idOrderInvoice, psOrderId })]
    );
  }

  return null;
}

function getPrestaShopBaseUrl(): string | undefined {
  return config.PS_WEBSERVICE_STAGING_URL ?? config.PS_WEBSERVICE_BASE_URL;
}

function stagingAuthHeaders(): Record<string, string> {
  if (!config.PS_STAGING_HTTP_AUTH) return {};
  return { Authorization: `Basic ${Buffer.from(config.PS_STAGING_HTTP_AUTH).toString("base64")}` };
}

async function fetchInvoicePdfFromModule(baseUrl: string | undefined, idOrderInvoice: number): Promise<Buffer> {
  if (!baseUrl) {
    throw new Error("PS PDF endpoint requires PS_WEBSERVICE_BASE_URL or PS_WEBSERVICE_STAGING_URL");
  }

  const ts = Math.floor(Date.now() / 1000).toString();
  const canonical = `id_order_invoice=${idOrderInvoice}&ts=${ts}`;
  const sig = createHmac("sha256", config.PS_PDF_HMAC_SECRET!).update(canonical).digest("hex");
  const url = new URL(config.PS_PDF_ENDPOINT_URL!, baseUrl);
  url.searchParams.set("id_order_invoice", String(idOrderInvoice));
  url.searchParams.set("ts", ts);
  url.searchParams.set("sig", sig);

  const headers = config.PS_WEBSERVICE_STAGING_URL ? stagingAuthHeaders() : {};
  const response = await fetch(url, { headers });
  return assertPdfResponse(response, "PS PDF endpoint");
}

async function fetchInvoicePdfFromWebservice(baseUrl: string, idOrderInvoice: number): Promise<Buffer> {
  const url =
    `${baseUrl}/api/order_invoices/${idOrderInvoice}` +
    `?output_format=PDF&ws_key=${config.PS_WEBSERVICE_KEY}`;

  const headers = config.PS_WEBSERVICE_STAGING_URL ? stagingAuthHeaders() : {};
  const response = await fetch(url, { headers });
  return assertPdfResponse(response, "PS webservice");
}

async function assertPdfResponse(response: Response, source: string): Promise<Buffer> {
  const contentType = response.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    throw new Error(`${source} ${response.status}: content-type=${contentType}, bytes=${buffer.length}`);
  }

  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(
      `${source} returned non-PDF response: status=${response.status}, content-type=${contentType}, bytes=${buffer.length}`
    );
  }

  return buffer;
}
