import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  MYSQL_HOST: z.string().default("127.0.0.1"),
  MYSQL_PORT: z.coerce.number().int().positive().default(3306),
  MYSQL_DATABASE: z.string().default("intactix_agent_db"),
  MYSQL_USER: z.string().default("intactix_agent"),
  MYSQL_PASSWORD: z.string().min(1),
  XERO_CLIENT_ID: z.string().optional(),
  XERO_CLIENT_SECRET: z.string().optional(),
  XERO_REDIRECT_URI: z.string().url().optional(),
  XERO_REFRESH_TOKEN: z.string().optional(),
  XERO_AUTH_SCOPES: z.string().default(
    "offline_access accounting.settings.read accounting.contacts.read accounting.invoices.read accounting.payments.read accounting.banktransactions.read accounting.manualjournals.read"
  ),
  BANK_FEED_SOURCE: z.enum(["accounting_api", "bank_statements_plus"]).default("accounting_api"),
  XERO_TENANT_ID: z.string().optional(),
  XERO_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  XERO_RATE_LIMIT_RETRY_MS: z.coerce.number().int().min(1000).default(65000),
  DEFAULT_SYNC_LOOKBACK_DAYS: z.coerce.number().int().min(1).default(90),
  PS_BI_HOST: z.string().default("127.0.0.1"),
  PS_BI_PORT: z.coerce.number().int().positive().default(3306),
  PS_BI_DATABASE: z.string().default("gopure_bi"),
  PS_BI_USER: z.string().default("gp_bi_user"),
  PS_BI_PASSWORD: z.string().min(1),
  PS_TABLE_PREFIX: z.string().default("pscw_"),
  PS_WEBSERVICE_KEY: z.string().optional(),
  PS_WEBSERVICE_BASE_URL: z.string().url().optional(),
  PS_WEBSERVICE_STAGING_URL: z.string().url().optional(),
  PS_PDF_ENDPOINT_URL: z.string().optional(),
  PS_PDF_HMAC_SECRET: z.string().optional(),
  PS_STAGING_HTTP_AUTH: z.string().optional(),
  XERO_WRITE_ENABLED: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  MAILBOX_IMAP_HOST: z.string().optional(),
  MAILBOX_IMAP_PORT: z.coerce.number().int().positive().default(993),
  MAILBOX_IMAP_SECURE: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  MAILBOX_IMAP_USER: z.string().optional(),
  MAILBOX_IMAP_PASSWORD: z.string().optional()
});

export const config = envSchema.parse(process.env);

export function requireMailboxConfig() {
  const missing = [
    ["MAILBOX_IMAP_HOST", config.MAILBOX_IMAP_HOST],
    ["MAILBOX_IMAP_USER", config.MAILBOX_IMAP_USER],
    ["MAILBOX_IMAP_PASSWORD", config.MAILBOX_IMAP_PASSWORD]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required mailbox environment variables: ${missing.join(", ")}`);
  }

  return {
    host: config.MAILBOX_IMAP_HOST!,
    port: config.MAILBOX_IMAP_PORT,
    secure: config.MAILBOX_IMAP_SECURE,
    user: config.MAILBOX_IMAP_USER!,
    password: config.MAILBOX_IMAP_PASSWORD!
  };
}

export function requireXeroConfig() {
  const missing = [
    ["XERO_CLIENT_ID", config.XERO_CLIENT_ID],
    ["XERO_CLIENT_SECRET", config.XERO_CLIENT_SECRET],
    ["XERO_REFRESH_TOKEN", config.XERO_REFRESH_TOKEN]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required Xero environment variables: ${missing.join(", ")}`);
  }

  return {
    clientId: config.XERO_CLIENT_ID!,
    clientSecret: config.XERO_CLIENT_SECRET!,
    refreshToken: config.XERO_REFRESH_TOKEN!,
    tenantId: config.XERO_TENANT_ID || undefined
  };
}
