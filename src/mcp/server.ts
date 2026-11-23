#!/usr/bin/env node
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closePool, execute, query } from "../db/mysql.js";
import { closePsPool, psQuery } from "../presta/pool.js";
import { reconcilePeriod } from "../reconcile/engine.js";
import { backtestInvoiceBuilder } from "../apply/backtest.js";
import { buildInvoiceFromPsOrder, loadPsOrderForInvoice } from "../xero/invoice-builder.js";
import { XeroWriteClient } from "../xero/write-client.js";
import { answerDecision, applyRules, invalidateRuleCache, promoteToRule } from "../learn/rules.js";
import { getSupplierProfile, listSupplierProfiles, upsertSupplierProfile } from "../learn/profiles.js";
import { applyProposals, applyInboxMatch } from "../apply/orchestrator.js";
import { fetchInvoicePdf } from "../presta/rest-pdf.js";
import { detectSpendOrphans } from "../reconcile/spend-orphans.js";
import { detectStatementOrphans } from "../reconcile/statement-orphans.js";
import { syncBankStatementLines } from "../xero/sync-statements.js";
import { XeroFilesClient } from "../xero/files-client.js";
import { MailboxClient, recordNewMailboxFiles } from "../email/imap-client.js";
import { checkAccountCodeForBill } from "../bills/account-code-guard.js";
import { checkDuplicate } from "../bills/routing.js";
import { resolveContactForBill } from "../bills/contact-resolution-guard.js";
import { checkCuroDocument } from "../bills/curo-document-guard.js";
import { config } from "../config.js";
import {
  syncBankTransfers,
  syncIncremental,
  syncReferenceData,
  syncReports,
  syncTransactions
} from "../xero/sync.js";
import { auditVatRates, investigateCountryVat } from "../vat/checker.js";

const server = new McpServer(
  { name: "intactix-tools", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Tools for the Intactix accounting agent: trigger Xero syncs and query the local warehouse (intactix_agent_db). " +
      "All sync operations are read-only from Xero. DB queries run against the local MySQL warehouse only. " +
      "Never compute matching, VAT arithmetic, or confidence scores — use the tool results to reason, then ask questions. " +
      "SESSION START: always call list_sync_runs first. If no successful sync exists, or the last sync is older than 24 hours, " +
      "run sync_incremental before any analysis or reconciliation work. " +
      "BILLS MANAGEMENT: poll_mailbox_inbox (xero@intactix.io) is the PRIMARY supplier-invoice source — download_mailbox_attachment to read each PDF, then create_bill_from_mailbox_file (dry_run=true first). " +
      "poll_xero_inbox / the Xero Files inbox is a legacy fallback source only. " +
      "SPEND ORPHANS: periodically call detect_spend_orphans to flag unmatched bank spend, then poll_mailbox_inbox to check for new receipts. " +
      "WRITES: XERO_WRITE_ENABLED=true — draft-first, always dry_run=true on first pass, then apply only after reviewing the dry-run output."
  }
);

// --- Sync tools ---

server.tool("sync_reference", "Sync Xero reference data: org, accounts, tax rates, contacts, tracking categories", async () => {
  try {
    await syncReferenceData();
    return { content: [{ type: "text", text: "Reference data sync completed." }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Sync failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

server.tool(
  "sync_transactions",
  "Sync Xero transactions (invoices, bills, bank transactions, payments, credit notes, manual journals) for a date range",
  { start: z.string().describe("Start date YYYY-MM-DD"), end: z.string().describe("End date YYYY-MM-DD") },
  async ({ start, end }) => {
    try {
      await syncTransactions(start, end);
      return { content: [{ type: "text", text: `Transaction sync completed for ${start} to ${end}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Sync failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "sync_bank_transfers",
  "Sync Xero bank transfers for a date range",
  { start: z.string().describe("Start date YYYY-MM-DD"), end: z.string().describe("End date YYYY-MM-DD") },
  async ({ start, end }) => {
    try {
      await syncBankTransfers(start, end);
      return { content: [{ type: "text", text: `Bank transfer sync completed for ${start} to ${end}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Sync failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "sync_reports",
  "Sync Xero P&L, Balance Sheet, and Trial Balance report snapshots for a date range",
  { start: z.string().describe("Start date YYYY-MM-DD"), end: z.string().describe("End date YYYY-MM-DD") },
  async ({ start, end }) => {
    try {
      await syncReports(start, end);
      return { content: [{ type: "text", text: `Report sync completed for ${start} to ${end}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Sync failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool("sync_incremental", "Sync reference data + last 90 days of transactions in one step", async () => {
  try {
    await syncIncremental();
    return { content: [{ type: "text", text: "Incremental sync completed." }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Sync failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

// --- Warehouse query tools ---

server.tool("list_sync_runs", "List recent sync runs with status and record counts", async () => {
  const rows = await query(
    "SELECT id, sync_type, tenant_id, period_start, period_end, status, object_counts, error_message, started_at, completed_at FROM xero_sync_runs ORDER BY started_at DESC LIMIT 20"
  );
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
});

server.tool("list_accounts", "List all Xero accounts from the warehouse", async () => {
  const rows = await query(
    "SELECT account_id, code, name, type, class, status, tax_type FROM xero_accounts ORDER BY code"
  );
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
});

server.tool("list_tax_rates", "List all Xero tax rates from the warehouse", async () => {
  const rows = await query(
    "SELECT tax_type, name, status, effective_rate FROM xero_tax_rates ORDER BY name"
  );
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
});

server.tool(
  "audit_vat_rates",
  "Audit VAT rate consistency: checks for missing Xero tax rates for countries with PS orders, mismatches between Xero effective_rate and PS order_detail.tax_rate, and flags seeded reference rates that differ from Xero (INFO only — reference rates are unverified). Run after sync_reference for fresh data.",
  {
    lookback_days: z.coerce.number().int().min(1).max(730).default(365).describe(
      "How many days of PS orders to check for country coverage. Default 365 days."
    ),
  },
  async ({ lookback_days }) => {
    const tenantId = config.XERO_TENANT_ID;
    if (!tenantId) throw new Error("XERO_TENANT_ID not configured");
    const result = await auditVatRates(tenantId, lookback_days);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "investigate_country_vat",
  "Deep-dive into a single country's VAT rate situation. Returns: current COUNTRY_VAT_RULES mapping, all PS tax rates actually charged for that country, all Xero rates in the warehouse whose name matches the country ISO code, and derived flags (MULTIPLE_ACTIVE_RATES, PS_XERO_MISMATCH, CANDIDATE_MATCH, XERO_EXPECTED_MISMATCH, etc.). Use when audit_vat_rates reports an ambiguity or mismatch and you need to formulate a concrete fix proposal.",
  {
    country_iso: z.string().min(2).max(2).describe("Two-letter ISO country code, e.g. 'EE', 'SK'"),
    lookback_days: z.coerce.number().int().min(1).max(730).default(365).describe(
      "How many days of PS orders to look back for actuals. Default 365."
    ),
  },
  async ({ country_iso, lookback_days }) => {
    const tenantId = config.XERO_TENANT_ID;
    if (!tenantId) throw new Error("XERO_TENANT_ID not configured");
    const result = await investigateCountryVat(tenantId, country_iso, lookback_days);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool("list_contacts", "List Xero contacts (suppliers and customers) from the warehouse", {
  limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max rows to return"),
  is_supplier: z.boolean().optional().describe("Filter to suppliers only"),
  is_customer: z.boolean().optional().describe("Filter to customers only"),
  name_contains: z.string().optional().describe("Filter by contact name substring")
}, async ({ limit, is_supplier, is_customer, name_contains }) => {
  let sql = "SELECT contact_id, name, email_address, is_supplier, is_customer, tax_number FROM xero_contacts WHERE 1=1";
  const params: any[] = [];
  if (is_supplier === true) { sql += " AND is_supplier = 1"; }
  if (is_customer === true) { sql += " AND is_customer = 1"; }
  if (name_contains) { sql += " AND name LIKE ?"; params.push(`%${name_contains}%`); }
  sql += " ORDER BY name LIMIT ?";
  params.push(limit);
  const rows = await query(sql, params);
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
});

server.tool("list_invoice_balances", "List invoice/bill balance summaries from the warehouse", {
  invoice_type: z.enum(["ACCREC", "ACCPAY"]).optional().describe("ACCREC=sales invoices, ACCPAY=purchase bills"),
  status: z.string().optional().describe("e.g. AUTHORISED, PAID, DRAFT"),
  limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max rows to return"),
  start_date: z.string().optional().describe("Invoice date from YYYY-MM-DD"),
  end_date: z.string().optional().describe("Invoice date to YYYY-MM-DD")
}, async ({ invoice_type, status, limit, start_date, end_date }) => {
  let sql = "SELECT invoice_id, invoice_type, invoice_number, reference, contact_id, invoice_date, due_date, status, currency_code, sub_total, total_tax, total, amount_due, amount_paid FROM xero_invoice_balances WHERE 1=1";
  const params: any[] = [];
  if (invoice_type) { sql += " AND invoice_type = ?"; params.push(invoice_type); }
  if (status) { sql += " AND status = ?"; params.push(status); }
  if (start_date) { sql += " AND invoice_date >= ?"; params.push(start_date); }
  if (end_date) { sql += " AND invoice_date <= ?"; params.push(end_date); }
  sql += " ORDER BY invoice_date DESC LIMIT ?";
  params.push(limit);
  const rows = await query(sql, params);
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
});

server.tool("query_warehouse", "Run a read-only SELECT query against intactix_agent_db. Use SHOW TABLES or DESCRIBE <table> to explore the schema.", {
  sql: z.string().describe("A read-only SELECT, SHOW, or DESCRIBE statement"),
  params: z.array(z.union([z.string(), z.number(), z.null()])).default([]).describe("Positional ? parameters")
}, async ({ sql: sqlStr, params }) => {
  const trimmed = sqlStr.trim().toUpperCase();
  if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("SHOW") && !trimmed.startsWith("DESCRIBE") && !trimmed.startsWith("EXPLAIN")) {
    return { content: [{ type: "text", text: "Only SELECT, SHOW, DESCRIBE, and EXPLAIN are allowed." }], isError: true };
  }
  try {
    const rows = await query(sqlStr, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Query failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

// --- Reconciliation tools ---

server.tool(
  "reconcile_period",
  "Run the reconciliation engine for a date range. Matches Xero ACCREC invoices to PS orders by reference, flags exceptions, assembles VAT inputs. Returns summary counts and run ID for querying results.",
  {
    start: z.string().describe("Start date YYYY-MM-DD (invoice date in Xero / order date in PS)"),
    end: z.string().describe("End date YYYY-MM-DD (inclusive)")
  },
  async ({ start, end }) => {
    try {
      const result = await reconcilePeriod(start, end);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            run_id: result.runId,
            period: `${result.periodStart} to ${result.periodEnd}`,
            summary: result.summary
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Reconciliation failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "list_reconciliation_runs",
  "List recent reconciliation runs with status and summary counts",
  async () => {
    const rows = await query(
      "SELECT id, period_start, period_end, status, summary, started_at, completed_at, error_message FROM reconciliation_runs ORDER BY started_at DESC LIMIT 20"
    );
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "list_reconciliation_results",
  "Query reconciliation results for a run. Filter by match_status to focus on exceptions.",
  {
    run_id: z.coerce.number().int().describe("Run ID from reconcile_period or list_reconciliation_runs"),
    match_status: z.enum(["MATCHED", "REF_MATCH_INV_DIFF", "XERO_ONLY"]).optional().describe("Filter by match status"),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max rows")
  },
  async ({ run_id, match_status, limit }) => {
    let sql = `SELECT xero_reference, xero_invoice_number, xero_date, xero_status, xero_currency,
                      xero_total, xero_tax_amount, xero_tax_type, match_status,
                      ps_order_id, ps_invoice_number, ps_date, ps_ship_country, ps_order_state,
                      ps_total_incl, ps_total_excl, ps_vat_inputs
               FROM reconciliation_results WHERE run_id = ?`;
    const params: any[] = [run_id];
    if (match_status) { sql += " AND match_status = ?"; params.push(match_status); }
    sql += " ORDER BY xero_date DESC LIMIT ?";
    params.push(limit);
    const rows = await query(sql, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "list_ps_orphans",
  "List PS orders from a reconciliation run that have no matching Xero invoice",
  {
    run_id: z.coerce.number().int().describe("Run ID"),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max rows")
  },
  async ({ run_id, limit }) => {
    const rows = await query(
      `SELECT ps_reference, ps_invoice_number, ps_state, ps_date, ps_ship_country,
              ps_currency_id, ps_total_incl
       FROM reconciliation_ps_orphans WHERE run_id = ?
       ORDER BY ps_date DESC LIMIT ?`,
      [run_id, limit]
    );
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// --- Invoice write tools ---

server.tool(
  "backtest_invoice_builder",
  "Compare the invoice payloads that the builder WOULD generate against existing matched Xero invoices for a period. Zero writes — pure validation. Run against March 2026 before creating any Q2 invoices.",
  {
    start: z.string().describe("Period start YYYY-MM-DD"),
    end: z.string().describe("Period end YYYY-MM-DD"),
    sample_limit: z.coerce.number().int().min(1).max(50).default(10).describe("Max mismatch samples to return")
  },
  async ({ start, end, sample_limit }) => {
    try {
      const result = await backtestInvoiceBuilder(start, end, sample_limit);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Backtest failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "preview_invoice_for_ps_order",
  "Preview the Xero invoice payload that would be created for a PS order reference. No write to Xero. Use to review before create_xero_invoices_from_ps_orphans.",
  {
    reference: z.string().describe("PS order reference e.g. VLEUKUOOM"),
    eur_amount_override: z.number().optional().describe("Legacy override: force a GBP PS order into an EUR invoice with this EUR total. Normally omit so GBP orders stay GBP.")
  },
  async ({ reference, eur_amount_override }) => {
    try {
      const ps = await loadPsOrderForInvoice(reference);
      if (!ps) return { content: [{ type: "text", text: `PS order not found: ${reference}` }], isError: true };
      const result = await buildInvoiceFromPsOrder(ps, eur_amount_override);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Preview failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "create_xero_invoices_from_ps_orphans",
  "Create Xero DRAFT invoices for PS orphan orders from a reconciliation run. Call repeatedly with the same run_id — already-logged dry-run/success entries are skipped automatically so each call processes the next unseen batch. GBP PS orders are flagged until a human confirms the EUR invoice total.",
  {
    run_id: z.coerce.number().int().describe("Reconciliation run ID (from list_reconciliation_runs)"),
    dry_run: z.boolean().default(true).describe("true=preview only, false=create drafts in Xero (requires XERO_WRITE_ENABLED=true)"),
    limit: z.coerce.number().int().min(1).default(50).describe("Max orphans to process in this batch. 50 is a safe default for both dry-run and live runs. Already-logged entries are skipped so repeated calls naturally page forward."),
    gbp_eur_rates: z.record(z.string(), z.number()).optional().describe("Confirmed map: PS reference -> EUR invoice total for GBP orders. GBP orders without a confirmed EUR amount are flagged.")
  },
  async ({ run_id, dry_run, limit, gbp_eur_rates }) => {
    if (!dry_run && config.XERO_WRITE_ENABLED !== true) {
      return {
        content: [{
          type: "text",
          text: "WRITE_BLOCKED: XERO_WRITE_ENABLED is not true. Set it in .env. Use dry_run=true to preview."
        }],
        isError: true
      };
    }

    try {
      const orphans = await query<any[]>(
        `SELECT ps_reference, ps_invoice_number, ps_state, ps_date, ps_ship_country, ps_currency_id, ps_total_incl
         FROM reconciliation_ps_orphans
         WHERE run_id = ?
           AND ps_reference NOT IN (
             SELECT ps_reference COLLATE utf8mb4_unicode_ci FROM xero_write_log
             WHERE operation = 'CREATE_INVOICE' AND status IN ('success', 'dry_run')
           )
         ORDER BY ps_date ASC LIMIT ?`,
        [run_id, limit]
      );

      const writeClient = new XeroWriteClient();
      const tenantId = config.XERO_TENANT_ID ?? "";

      const results: object[] = [];
      let created = 0, skipped = 0, flagged = 0, errored = 0;

      for (const orphan of orphans) {
        try {
          const eurOverride = gbp_eur_rates?.[orphan.ps_reference];

          // Idempotency: warehouse first (no API call), Xero live only for genuinely new orders
          const warehouseHit = await query<any[]>(
            `SELECT invoice_id FROM xero_invoice_balances
             WHERE tenant_id = ? AND reference = ? AND invoice_type = 'ACCREC'
               AND status NOT IN ('DELETED','VOIDED') LIMIT 1`,
            [tenantId, orphan.ps_reference]
          );
          if (warehouseHit[0]) {
            skipped++;
            results.push({ reference: orphan.ps_reference, status: "skipped", reason: `already exists in Xero (warehouse: ${warehouseHit[0].invoice_id})` });
            continue;
          }
          const existing = await writeClient.findInvoiceByReference(tenantId, orphan.ps_reference);
          if (existing) {
            skipped++;
            results.push({ reference: orphan.ps_reference, status: "skipped", reason: `Xero invoice ${existing.InvoiceNumber} already exists` });
            continue;
          }

          const ps = await loadPsOrderForInvoice(orphan.ps_reference);
          if (!ps) {
            errored++;
            results.push({ reference: orphan.ps_reference, status: "error", reason: "PS order not found in gopure_bi" });
            continue;
          }

          const buildResult = await buildInvoiceFromPsOrder(ps, eurOverride);

          if (buildResult.status === "flagged") {
            const flagKey = `CREATE_INVOICE:${orphan.ps_reference}:flag`;
            await execute(
              `INSERT IGNORE INTO xero_write_log
                 (tenant_id, operation, idempotency_key, dry_run, status, flag_reason, ps_reference)
               VALUES (?, 'CREATE_INVOICE', ?, ?, 'flagged', ?, ?)`,
              [tenantId, flagKey, dry_run ? 1 : 0, buildResult.flag ?? null, orphan.ps_reference]
            );
            flagged++;
            results.push({ reference: orphan.ps_reference, status: "flagged", reason: buildResult.flag });
            continue;
          }

          const idempotencyKey = `CREATE_INVOICE:${orphan.ps_reference}:${dry_run ? "dry" : "live"}`;
          const created_obj = await writeClient.createInvoice(
            tenantId, buildResult.payload!, idempotencyKey, orphan.ps_reference, dry_run
          );
          created++;
          results.push({
            reference: orphan.ps_reference,
            status: dry_run ? "dry_run" : "created",
            payload: dry_run ? buildResult.payload : { InvoiceID: created_obj.InvoiceID }
          });
        } catch (e) {
          errored++;
          results.push({ reference: orphan.ps_reference, status: "error", reason: e instanceof Error ? e.message : String(e) });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            dry_run,
            run_id,
            totals: { processed: orphans.length, created, skipped, flagged, errored },
            results
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Tool failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "list_write_log",
  "List the Xero write audit log — all invoice creation attempts (dry-run and live)",
  {
    status: z.string().optional().describe("Filter by status: pending, success, dry_run, skipped, error, flagged"),
    limit: z.coerce.number().int().min(1).max(200).default(50).describe("Max rows")
  },
  async ({ status, limit }) => {
    let sql = `SELECT id, operation, idempotency_key, dry_run, status, flag_reason, xero_object_id, ps_reference, created_at
               FROM xero_write_log WHERE 1=1`;
    const params: any[] = [];
    if (status) { sql += " AND status = ?"; params.push(status); }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = await query(sql, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// --- PrestaShop BI tools ---

const PS_PREFIX = process.env.PS_TABLE_PREFIX || "pscw_";

server.tool(
  "lookup_ps_order",
  "Look up a PrestaShop order from the BI replica by Xero reference. Returns order header, ship-to country, and order lines with tax rates.",
  { reference: z.string().describe("The PrestaShop order reference (same value as Xero invoice reference field)") },
  async ({ reference }) => {
    const orders = await psQuery(
      `SELECT o.id_order, o.reference, o.date_add, o.id_currency, o.total_paid_tax_incl, o.total_paid_tax_excl, o.total_shipping_tax_incl,
              a.id_country, co.iso_code AS ship_country
       FROM ${PS_PREFIX}orders o
       JOIN ${PS_PREFIX}address a ON o.id_address_delivery = a.id_address
       JOIN ${PS_PREFIX}country co ON a.id_country = co.id_country
       WHERE o.reference = ?`,
      [reference]
    );
    if (!orders.length) {
      return { content: [{ type: "text", text: `No PS order found with reference ${reference}` }], isError: true };
    }
    const order = orders[0];
    const lines = await psQuery(
      `SELECT id_order_detail, product_name, product_quantity, tax_rate,
              unit_price_tax_excl, unit_price_tax_incl, total_price_tax_excl, total_price_tax_incl
       FROM ${PS_PREFIX}order_detail WHERE id_order = ?`,
      [order.id_order]
    );
    return { content: [{ type: "text", text: JSON.stringify({ order, lines }, null, 2) }] };
  }
);

server.tool(
  "list_ps_orders",
  "List PrestaShop orders from the BI replica for a date range. Returns order header + ship-to country per row.",
  {
    start_date: z.string().describe("Start date YYYY-MM-DD (inclusive)"),
    end_date: z.string().describe("End date YYYY-MM-DD (inclusive)"),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max rows"),
    ship_country: z.string().optional().describe("Filter by ISO country code, e.g. GB, NL, DE")
  },
  async ({ start_date, end_date, limit, ship_country }) => {
    let sql = `SELECT o.id_order, o.reference, o.date_add, o.id_currency, o.total_paid_tax_incl, o.total_paid_tax_excl, o.total_shipping_tax_incl, co.iso_code AS ship_country
               FROM ${PS_PREFIX}orders o
               JOIN ${PS_PREFIX}address a ON o.id_address_delivery = a.id_address
               JOIN ${PS_PREFIX}country co ON a.id_country = co.id_country
               WHERE o.date_add >= ? AND o.date_add < DATE_ADD(?, INTERVAL 1 DAY)`;
    const params: any[] = [start_date, end_date];
    if (ship_country) { sql += " AND co.iso_code = ?"; params.push(ship_country.toUpperCase()); }
    sql += " ORDER BY o.date_add DESC LIMIT ?";
    params.push(limit);
    const rows = await psQuery(sql, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "query_ps",
  "Run a read-only SELECT query against the gopure_bi PrestaShop replica. Use SHOW TABLES or DESCRIBE to explore. Table prefix is pscw_.",
  {
    sql: z.string().describe("A read-only SELECT, SHOW, or DESCRIBE statement"),
    params: z.array(z.union([z.string(), z.number(), z.null()])).default([]).describe("Positional ? parameters")
  },
  async ({ sql: sqlStr, params }) => {
    const trimmed = sqlStr.trim().toUpperCase();
    if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("SHOW") && !trimmed.startsWith("DESCRIBE") && !trimmed.startsWith("EXPLAIN")) {
      return { content: [{ type: "text", text: "Only SELECT, SHOW, DESCRIBE, and EXPLAIN are allowed." }], isError: true };
    }
    try {
      const rows = await psQuery(sqlStr, params);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Query failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Learning loop tools
// ---------------------------------------------------------------------------

server.tool(
  "list_decision_queue",
  "List items in the decision queue. Use this to see what the engine could not resolve.",
  {
    status: z.enum(["open", "answered", "promoted", "dismissed", "all"]).default("open"),
    domain: z.enum(["MATCH", "TAX_CODE", "ACCOUNT_CODE", "SUPPLIER_PROFILE", "OTHER", "all"]).default("all"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  },
  async ({ status, domain, limit }) => {
    let sql = `SELECT id, queue_key, domain, transaction_type, contact_name,
                      xero_invoice_id, ps_order_id, run_id, question, status,
                      answer, answered_by, answered_at, promoted_rule_id, created_at
               FROM decision_queue WHERE 1=1`;
    const params: any[] = [];
    if (status !== "all") { sql += " AND status = ?"; params.push(status); }
    if (domain !== "all") { sql += " AND domain = ?"; params.push(domain); }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = await query(sql, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "get_decision",
  "Get full evidence and question for a single decision queue item by ID.",
  { id: z.coerce.number().int().positive() },
  async ({ id }) => {
    const rows = await query<any[]>(
      `SELECT * FROM decision_queue WHERE id = ?`,
      [id]
    );
    if (rows.length === 0) {
      return { content: [{ type: "text", text: `No decision queue item with id=${id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(rows[0], null, 2) }] };
  }
);

server.tool(
  "answer_decision",
  "Record your answer to an open decision queue item. After answering, call promote_to_rule to create a durable rule.",
  {
    id: z.coerce.number().int().positive().describe("decision_queue.id"),
    answer: z.string().min(1).describe("Your answer, as specific as possible (account code, tax code, reasoning)"),
    answered_by: z.enum(["human", "agent"]).default("agent"),
  },
  async ({ id, answer, answered_by }) => {
    await answerDecision(id, answer, answered_by);
    return { content: [{ type: "text", text: `Decision ${id} marked answered. Call promote_to_rule to create a durable rule from this answer.` }] };
  }
);

server.tool(
  "promote_to_rule",
  "Create a durable agent_rule from an answered decision queue item. The rule will be applied in future reconciliation runs.",
  {
    decision_id: z.coerce.number().int().positive().describe("decision_queue.id (must be in 'answered' status)"),
    rule_name: z.string().min(1).describe("Short descriptive name for the rule"),
    priority: z.coerce.number().int().min(1).max(9999).default(500).describe("Lower = higher priority (seed rules use 100-400)"),
    scope: z.string().default("ALL").describe("ALL / SALES / PURCHASES / BANK"),
    match_transaction_type: z.string().optional().describe("ACCPAY / ACCREC / BANK_SPEND / BANK_RECEIVE — null matches any"),
    match_contact_name_re: z.string().optional().describe("JS REGEXP (case-insensitive) matching the contact/supplier name"),
    match_account_code: z.string().optional().describe("Exact Xero account code to match on the existing line"),
    match_description_re: z.string().optional().describe("JS REGEXP against line description"),
    match_ship_country_iso: z.string().optional().describe("ISO country code, 'EU', or 'NON_EU'"),
    assigned_account_code: z.string().optional().describe("Xero account code to propose"),
    assigned_account_name: z.string().optional().describe("Human-readable account name"),
    assigned_tax_code: z.string().optional().describe("Xero tax type code, e.g. TAX021, TAX023, TAX011"),
    assigned_contact_name: z.string().optional().describe("Contact name to propose (for contact-split rules)"),
    confidence: z.coerce.number().min(0).max(1).default(0.85).describe("0.0–1.0; items below 0.75 go to the queue"),
    notes: z.string().optional().describe("Why this rule exists; what evidence supports it"),
  },
  async (params) => {
    const rows = await query<any[]>(
      `SELECT status FROM decision_queue WHERE id = ?`,
      [params.decision_id]
    );
    if (rows.length === 0) {
      return { content: [{ type: "text", text: `Decision ${params.decision_id} not found.` }], isError: true };
    }
    if (rows[0].status === "open") {
      return { content: [{ type: "text", text: `Decision ${params.decision_id} is still open. Call answer_decision first.` }], isError: true };
    }
    const ruleId = await promoteToRule(params.decision_id, {
      priority: params.priority,
      ruleName: params.rule_name,
      scope: params.scope,
      matchTransactionType: params.match_transaction_type,
      matchContactNameRe: params.match_contact_name_re,
      matchAccountCode: params.match_account_code,
      matchDescriptionRe: params.match_description_re,
      matchShipCountryIso: params.match_ship_country_iso,
      assignedAccountCode: params.assigned_account_code,
      assignedAccountName: params.assigned_account_name,
      assignedTaxCode: params.assigned_tax_code,
      assignedContactName: params.assigned_contact_name,
      confidence: params.confidence,
      notes: params.notes,
    });
    return { content: [{ type: "text", text: `Rule created with id=${ruleId}. It will apply in the next reconciliation run.` }] };
  }
);

server.tool(
  "list_rules",
  "List active reconciliation/coding rules from the agent_rules table.",
  {
    scope: z.string().optional().describe("Filter by scope: ALL / SALES / PURCHASES / BANK"),
    source: z.enum(["SEED", "HUMAN", "AGENT", "all"]).default("all"),
    include_inactive: z.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  },
  async ({ scope, source, include_inactive, limit }) => {
    let sql = `SELECT id, priority, rule_name, scope, match_transaction_type, match_contact_name_re,
                      match_account_code, assigned_account_code, assigned_account_name,
                      assigned_tax_code, confidence, source, active, notes, created_at
               FROM agent_rules WHERE 1=1`;
    const params: any[] = [];
    if (!include_inactive) { sql += " AND active = TRUE"; }
    if (scope) { sql += " AND scope = ?"; params.push(scope); }
    if (source !== "all") { sql += " AND source = ?"; params.push(source); }
    sql += " ORDER BY priority ASC, id ASC LIMIT ?";
    params.push(limit);
    const rows = await query(sql, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "add_rule",
  "Manually add a new coding/reconciliation rule to the agent_rules table (no associated decision required).",
  {
    rule_name: z.string().min(1),
    priority: z.coerce.number().int().min(1).max(9999).default(500),
    scope: z.string().default("ALL"),
    match_transaction_type: z.string().optional(),
    match_contact_name_re: z.string().optional(),
    match_account_code: z.string().optional(),
    match_description_re: z.string().optional(),
    match_ship_country_iso: z.string().optional(),
    match_currency: z.string().optional(),
    assigned_account_code: z.string().optional(),
    assigned_account_name: z.string().optional(),
    assigned_tax_code: z.string().optional(),
    assigned_contact_name: z.string().optional(),
    confidence: z.coerce.number().min(0).max(1).default(0.85),
    source: z.enum(["SEED", "HUMAN", "AGENT"]).default("HUMAN"),
    notes: z.string().optional(),
  },
  async (params) => {
    const row = await execute(
      `INSERT INTO agent_rules
         (priority, rule_name, scope, match_transaction_type, match_contact_name_re,
          match_account_code, match_description_re, match_ship_country_iso, match_currency,
          assigned_account_code, assigned_account_name, assigned_tax_code, assigned_contact_name,
          confidence, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.priority, params.rule_name, params.scope,
        params.match_transaction_type ?? null, params.match_contact_name_re ?? null,
        params.match_account_code ?? null, params.match_description_re ?? null,
        params.match_ship_country_iso ?? null, params.match_currency ?? null,
        params.assigned_account_code ?? null, params.assigned_account_name ?? null,
        params.assigned_tax_code ?? null, params.assigned_contact_name ?? null,
        params.confidence, params.source, params.notes ?? null,
      ]
    );
    invalidateRuleCache();
    return { content: [{ type: "text", text: `Rule created with id=${row.insertId}.` }] };
  }
);

server.tool(
  "deactivate_rule",
  "Deactivate a rule so it no longer fires in reconciliation. The rule is soft-deleted and can be reactivated.",
  { id: z.coerce.number().int().positive() },
  async ({ id }) => {
    await execute(`UPDATE agent_rules SET active = FALSE, updated_at = NOW() WHERE id = ?`, [id]);
    invalidateRuleCache();
    return { content: [{ type: "text", text: `Rule ${id} deactivated.` }] };
  }
);

server.tool(
  "test_rule_match",
  "Test which rule (if any) fires for given transaction inputs. Useful for debugging rule coverage before running a full reconciliation.",
  {
    transaction_type: z.string().optional().describe("ACCPAY / ACCREC / BANK_SPEND / BANK_RECEIVE"),
    contact_name: z.string().optional(),
    account_code: z.string().optional(),
    description: z.string().optional(),
    ship_country_iso: z.string().optional(),
    currency: z.string().optional(),
  },
  async (params) => {
    const hit = await applyRules({
      transactionType: params.transaction_type,
      contactName: params.contact_name,
      accountCode: params.account_code,
      description: params.description,
      shipCountryIso: params.ship_country_iso,
      currency: params.currency,
    });
    if (!hit) {
      return { content: [{ type: "text", text: "No rule matched. This transaction would be sent to the decision queue." }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(hit, null, 2) }] };
  }
);

server.tool(
  "list_coding_proposals",
  "List purchase bill coding proposals from the most recent or a specific reconciliation run.",
  {
    run_id: z.coerce.number().int().positive().optional().describe("Specific run — omit for latest"),
    proposal_status: z.enum(["proposed", "queued", "approved", "all"]).default("all"),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  },
  async ({ run_id, proposal_status, limit }) => {
    let resolvedRunId = run_id;
    if (!resolvedRunId) {
      const latest = await query<any[]>(
        `SELECT MAX(run_id) as max_run FROM coding_proposals`
      );
      resolvedRunId = latest[0]?.max_run;
      if (!resolvedRunId) {
        return { content: [{ type: "text", text: "No coding proposals found. Run reconcile_period first." }] };
      }
    }
    let sql = `SELECT id, source_ref, source_type, xero_invoice_id, contact_name, transaction_date,
                      currency_code, total, current_account_code, current_tax_code,
                      proposed_account_code, proposed_account_name, proposed_tax_code,
                      matched_rule_name, coding_confidence, proposal_status, notes
               FROM coding_proposals WHERE run_id = ?`;
    const params: any[] = [resolvedRunId];
    if (proposal_status !== "all") { sql += " AND proposal_status = ?"; params.push(proposal_status); }
    sql += " ORDER BY coding_confidence ASC, contact_name ASC LIMIT ?";
    params.push(limit);
    const rows = await query(sql, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// --- Supplier tax profiles ---

server.tool(
  "list_supplier_profiles",
  "List known supplier tax profiles. Optionally filter by a substring of the contact name. " +
  "Profiles hold verified facts (country, VAT ID, supply type, default tax/account codes) " +
  "used to auto-code purchase bills. Profiles take precedence over agent_rules.",
  {
    search: z.string().optional().describe("Substring to filter by contact name — omit for all"),
  },
  async ({ search }) => {
    const profiles = await listSupplierProfiles(search);
    if (profiles.length === 0) {
      return { content: [{ type: "text", text: search ? `No profiles match '${search}'.` : "No supplier profiles yet. Use upsert_supplier_profile to create one." }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(profiles, null, 2) }] };
  }
);

server.tool(
  "get_supplier_profile",
  "Look up a supplier's tax profile by exact contact name (case-insensitive). " +
  "Returns null if no profile exists — in that case the engine falls back to agent_rules.",
  {
    contact_name: z.string().describe("Exact Xero contact name"),
  },
  async ({ contact_name }) => {
    const profile = await getSupplierProfile(contact_name);
    if (!profile) {
      return { content: [{ type: "text", text: `No profile found for '${contact_name}'. The engine will fall back to agent_rules for this supplier.` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
  }
);

server.tool(
  "upsert_supplier_profile",
  "Create or update a supplier tax profile. Call this after resolving a SUPPLIER_PROFILE or ACCOUNT_CODE decision " +
  "so future bills from this supplier auto-classify without queuing. " +
  "Profile takes precedence over agent_rules when confidence >= 0.75. " +
  "Supply only the fields you know — existing values are preserved for fields you omit.",
  {
    contact_name: z.string().describe("Exact Xero contact name (primary key)"),
    country_iso: z.string().length(2).optional().describe("Supplier's country ISO-2 (e.g. NL, DE, SG)"),
    vat_id: z.string().optional().describe("EU VAT registration number if known"),
    entity_type: z.enum(["company", "individual", "platform"]).optional().default("company"),
    supply_type: z.enum(["goods", "services", "mixed"]).optional().default("services"),
    default_tax_code: z.string().optional().describe("Xero TaxType (e.g. TAX021 for EU reverse charge, TAX023 for no VAT)"),
    default_account_code: z.string().optional().describe("Xero account code (e.g. 480 for contractor services)"),
    notes: z.string().optional().describe("Free-text notes: why this treatment, source of decision, etc."),
    confidence: z.number().min(0).max(1).optional().default(0.85)
      .describe("Confidence in this profile (0–1). Use 0.85 for human-confirmed; 0.50 for agent-inferred pending review."),
  },
  async (params) => {
    const id = await upsertSupplierProfile({
      contactName: params.contact_name,
      countryIso: params.country_iso ?? null,
      vatId: params.vat_id ?? null,
      entityType: params.entity_type,
      supplyType: params.supply_type,
      defaultTaxCode: params.default_tax_code ?? null,
      defaultAccountCode: params.default_account_code ?? null,
      notes: params.notes ?? null,
      confidence: params.confidence,
    });
    return { content: [{ type: "text", text: `Supplier profile saved (id=${id}) for '${params.contact_name}'. Future ACCPAY bills from this supplier will use account ${params.default_account_code ?? "?"} / tax ${params.default_tax_code ?? "unset"} at confidence ${params.confidence}.` }] };
  }
);

// ---------------------------------------------------------------------------
// Phase 3 — Write layer tools
// ---------------------------------------------------------------------------

server.tool(
  "apply_proposals",
  "Apply a batch of coding proposals to Xero as DRAFT records. " +
  "ACCREC proposals create new DRAFT sales invoices; ACCPAY proposals recode existing bills. " +
  "Always run with dry_run=true first to verify what would be created before committing. " +
  "Every write lands in Xero as DRAFT — a human must approve in the Xero UI before anything posts. " +
  "Requires XERO_WRITE_ENABLED=true in .env and write scopes on the OAuth token. " +
  "Safety rails enforced automatically: existence check (live Xero), period-lock warning, kill switch, idempotency.",
  {
    proposal_ids: z.array(z.string()).min(1).describe(
      "List of proposal identifiers. Format: 'accrec:<reconciliation_ps_orphans.id>' to create a new sales invoice, " +
      "'accpay:<coding_proposals.id>' to recode an existing bill."
    ),
    dry_run: z.boolean().describe(
      "true = log intent only, no Xero API calls; false = write DRAFTs to Xero. Always use true first."
    ),
    contact_overrides: z.record(z.string(), z.string()).optional().describe(
      "Map of PS reference (for accrec) or Xero invoice ID (for accpay) to Xero ContactID. " +
      "Use this after calling lookup_xero_contacts to confirm which contact to use. " +
      "If omitted, the invoice builder resolves contacts from the local warehouse."
    ),
    tenant_id: z.string().optional().describe("Xero tenant ID. Defaults to the configured XERO_TENANT_ID."),
  },
  async ({ proposal_ids, dry_run, contact_overrides, tenant_id }) => {
    const { resolveTenantId } = await import("../db/repositories.js");
    const tenantId = tenant_id ?? await resolveTenantId(config.XERO_TENANT_ID);
    const summary = await applyProposals(tenantId, proposal_ids, {
      dryRun: dry_run,
      contactOverrides: contact_overrides,
    });
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

server.tool(
  "get_write_log",
  "Audit trail of all Xero write operations: invoice creation, bill recoding, PDF attachments. " +
  "Use this to verify what was applied, investigate failures, and review dry-run previews.",
  {
    tenant_id: z.string().optional().describe("Filter by tenant ID. Defaults to the configured XERO_TENANT_ID."),
    status: z.enum(["pending", "success", "dry_run", "error"]).optional().describe("Filter by operation status."),
    operation: z.enum(["CREATE_INVOICE", "CREATE_BILL", "RECODE_BILL", "ATTACH_PDF"]).optional()
      .describe("Filter by operation type."),
    limit: z.number().int().min(1).max(200).default(50).describe("Max rows to return (default 50)."),
  },
  async ({ tenant_id, status, operation, limit }) => {
    const { resolveTenantId } = await import("../db/repositories.js");
    const tenantId = tenant_id ?? await resolveTenantId(config.XERO_TENANT_ID);
    const conditions: string[] = ["tenant_id = ?"];
    const params: any[] = [tenantId];
    if (status) { conditions.push("status = ?"); params.push(status); }
    if (operation) { conditions.push("operation = ?"); params.push(operation); }
    params.push(limit);
    const rows = await query<any[]>(
      `SELECT id, operation, status, dry_run, ps_reference, xero_object_id, created_at,
              LEFT(request_payload, 500) as request_snippet
       FROM xero_write_log
       WHERE ${conditions.join(" AND ")}
       ORDER BY id DESC LIMIT ?`,
      params
    );
    if (!rows.length) return { content: [{ type: "text", text: "No write log entries match the filter." }] };
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "lookup_xero_contacts",
  "Search for Xero contacts in the local warehouse by name fragment. " +
  "Use this before calling apply_proposals to understand the existing contact convention " +
  "on the 200+ ACCREC invoices already in Xero, and to find the ContactID to pass as a contact_override. " +
  "The agent must decide the correct contact — this tool provides the data.",
  {
    query: z.string().min(1).describe("Name fragment to search for (case-insensitive LIKE match)."),
    limit: z.number().int().min(1).max(50).default(10).describe("Max results to return."),
  },
  async ({ query: nameQuery, limit }) => {
    const rows = await query<any[]>(
      `SELECT contact_id, name, email_address, status, updated_date_utc
       FROM xero_contacts
       WHERE LOWER(name) LIKE LOWER(?) AND status != 'ARCHIVED'
       ORDER BY name
       LIMIT ?`,
      [`%${nameQuery}%`, limit]
    );
    if (!rows.length) return { content: [{ type: "text", text: `No contacts found matching '${nameQuery}'.` }] };
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.tool(
  "attach_pdf_to_invoice",
  "Manually attach a PrestaShop invoice PDF to an existing Xero invoice. " +
  "Use when PDF attachment failed during apply_proposals (check get_write_log for ATTACH_PDF errors), " +
  "or for invoices that were created before Phase 3. " +
  "Requires PS_WEBSERVICE_KEY and PS_WEBSERVICE_BASE_URL in .env.",
  {
    xero_invoice_id: z.string().describe("Xero InvoiceID (UUID) to attach the PDF to."),
    ps_order_id: z.number().int().positive().describe("PrestaShop order ID (id_order) to fetch the PDF for."),
    tenant_id: z.string().optional().describe("Xero tenant ID. Defaults to the configured XERO_TENANT_ID."),
  },
  async ({ xero_invoice_id, ps_order_id, tenant_id }) => {
    const { resolveTenantId } = await import("../db/repositories.js");
    const tenantId = tenant_id ?? await resolveTenantId(config.XERO_TENANT_ID);
    const writeClient = new XeroWriteClient();
    const ikey = `manual-attach:${xero_invoice_id}`;
    const pdf = await fetchInvoicePdf(ps_order_id, ikey, tenantId);
    if (!pdf) {
      return { content: [{ type: "text", text: `Could not fetch PDF for PS order ${ps_order_id}. Check PS_WEBSERVICE_KEY and PS_WEBSERVICE_BASE_URL in .env, and verify the order has an invoice.` }] };
    }
    const result = await writeClient.attachPdf(tenantId, xero_invoice_id, pdf.filename, pdf.buffer, false);
    return { content: [{ type: "text", text: JSON.stringify({ invoiceId: xero_invoice_id, filename: pdf.filename, ...result }, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Spend orphan + inbox receipt matching tools
// ---------------------------------------------------------------------------

const filesClient = new XeroFilesClient();
const inboxWriteClient = new XeroWriteClient();
const mailboxClient = new MailboxClient();

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

server.tool(
  "detect_spend_orphans",
  "Scan synced Xero bank transactions for SPEND_MONEY entries that have no ACCPAY bill and are not reconciled. " +
  "Inserts new rows into bank_spend_orphans and enqueues a chase question in the decision queue for each unmatched spend. " +
  "Re-runs are safe — already-chasing/coded/dismissed rows are not overwritten. " +
  "Excludes own bank account codes (100-120), bank fees (404), and already-processed transactions. " +
  "For Wise card spends, identifies the cardholder (Jani/Mari) from the transaction reference.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    lookback_days: z.coerce.number().int().min(1).max(730).default(365).describe("How many days back to scan"),
  },
  async ({ tenant_id, lookback_days }) => {
    try {
      const summary = await detectSpendOrphans(tenant_id, null, { lookbackDays: lookback_days });
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `detect_spend_orphans failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "list_spend_orphans",
  "List bank_spend_orphans rows. Filter by status and/or cardholder. " +
  "Status lifecycle: flagged → chasing → received → matched → coded | dismissed. " +
  "'chasing' means a decision queue entry exists asking for the receipt. " +
  "'coded' means a DRAFT ACCPAY bill has been created in Xero.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    status: z.enum(["flagged", "chasing", "received", "matched", "coded", "dismissed"]).optional()
      .describe("Filter by status (omit for all open: flagged + chasing + received + matched)"),
    cardholder: z.enum(["jani", "mari"]).optional().describe("Filter to a specific cardholder"),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  },
  async ({ tenant_id, status, cardholder, limit }) => {
    try {
      const conditions: string[] = ["tenant_id = ?"];
      const params: any[] = [tenant_id];
      if (status) {
        conditions.push("status = ?");
        params.push(status);
      } else {
        conditions.push("status NOT IN ('coded','dismissed')");
      }
      if (cardholder) {
        conditions.push("cardholder = ?");
        params.push(cardholder);
      }
      params.push(limit);
      const rows = await query<any[]>(
        `SELECT id, xero_bank_tx_id, transaction_date, amount, currency, contact_name,
                description, cardholder, card_last4, bank_account_code, status,
                matched_file_id, matched_invoice_id, notes, created_at
         FROM bank_spend_orphans
         WHERE ${conditions.join(" AND ")}
         ORDER BY transaction_date DESC
         LIMIT ?`,
        params
      );
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `list_spend_orphans failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "poll_xero_inbox",
  "Fetch the list of files currently in the Xero Files inbox (bills@ email drop). " +
  "Inserts any previously unseen files into xero_inbox_files with status='new'. " +
  "Returns only newly discovered files so the agent knows what to inspect. " +
  "Requires files.read OAuth scope — add it to XERO_AUTH_SCOPES and re-run auth if this fails with a 403.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
  },
  async ({ tenant_id }) => {
    try {
      const inboxFiles = await filesClient.listInboxFiles(tenant_id);
      const newFiles: any[] = [];
      for (const f of inboxFiles) {
        if (!f.fileId) continue;
        const existing = await query<any[]>(
          `SELECT id, status FROM xero_inbox_files WHERE tenant_id = ? AND file_id = ?`,
          [tenant_id, f.fileId]
        );
        if (existing.length === 0) {
          await execute(
            `INSERT INTO xero_inbox_files (tenant_id, file_id, file_name, mime_type, size_bytes, created_date_utc, status)
             VALUES (?, ?, ?, ?, ?, ?, 'new')
             ON DUPLICATE KEY UPDATE file_name=VALUES(file_name)`,
            [tenant_id, f.fileId, f.fileName, f.mimeType, f.sizeBytes,
             f.createdDateUtc ? new Date(f.createdDateUtc).toISOString().replace("T", " ").substring(0, 19) : null]
          );
          newFiles.push(f);
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ inboxTotal: inboxFiles.length, newFiles, message: newFiles.length === 0 ? "No new files since last poll." : `${newFiles.length} new file(s) found. Use download_inbox_file to read each one, then match_inbox_file_to_spend.` }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `poll_xero_inbox failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "list_inbox_files",
  "List Xero inbox files known to the local warehouse with their extraction, orphan-link, and bill-link state. " +
  "Use this before claiming a receipt is missing: status='new' or status='processing' means the file exists but has not been matched/coded yet.",
  {
    tenant_id: z.string().optional().describe("Xero tenant ID — defaults to XERO_TENANT_ID in .env"),
    status: z.enum(["new", "processing", "matched", "no_match", "error", "all"]).default("all")
      .describe("Inbox file status filter"),
    filename_contains: z.string().optional().describe("Case-insensitive filename substring filter"),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max rows"),
  },
  async ({ tenant_id, status, filename_contains, limit }) => {
    try {
      const tenantId = tenant_id ?? config.XERO_TENANT_ID;
      if (!tenantId) throw new Error("tenant_id is required");

      const conditions = ["f.tenant_id = ?"];
      const params: any[] = [tenantId];
      if (status !== "all") {
        conditions.push("f.status = ?");
        params.push(status);
      }
      if (filename_contains) {
        conditions.push("LOWER(f.file_name) LIKE ?");
        params.push(`%${filename_contains.toLowerCase()}%`);
      }

      const rows = await query<any[]>(
        `SELECT
           f.id,
           f.file_id,
           f.file_name,
           f.mime_type,
           f.size_bytes,
           f.created_date_utc,
           f.status,
           f.extracted_supplier,
           f.extracted_amount,
           f.extracted_currency,
           f.extracted_date,
           f.matched_orphan_id,
           f.matched_invoice_id,
           bso.status AS orphan_status,
           bso.transaction_date AS orphan_date,
           bso.amount AS orphan_amount,
           bso.currency AS orphan_currency,
           bso.payee AS orphan_payee,
           inv.invoice_number,
           inv.reference AS bill_reference,
           inv.contact_name AS bill_contact,
           inv.invoice_date AS bill_date,
           inv.status AS bill_status,
           inv.currency_code AS bill_currency,
           inv.total AS bill_total
         FROM xero_inbox_files f
         LEFT JOIN bank_spend_orphans bso
           ON bso.tenant_id = f.tenant_id
          AND bso.id = f.matched_orphan_id
         LEFT JOIN xero_invoice_balances inv
           ON inv.tenant_id = f.tenant_id
          AND inv.invoice_id = f.matched_invoice_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY f.created_date_utc DESC, f.id DESC
         LIMIT ?`,
        [...params, limit]
      );

      const formatted = rows.map((r) => ({
        file_id: r.file_id,
        file_name: r.file_name,
        uploaded: r.created_date_utc instanceof Date
          ? r.created_date_utc.toISOString().substring(0, 10)
          : String(r.created_date_utc ?? "").substring(0, 10),
        status: r.status,
        extracted: r.extracted_amount == null ? null : {
          supplier: r.extracted_supplier,
          amount: Number(r.extracted_amount),
          currency: r.extracted_currency,
          date: r.extracted_date instanceof Date
            ? r.extracted_date.toISOString().substring(0, 10)
            : String(r.extracted_date ?? "").substring(0, 10),
        },
        orphan: r.matched_orphan_id == null ? null : {
          id: r.matched_orphan_id,
          status: r.orphan_status,
          date: r.orphan_date instanceof Date
            ? r.orphan_date.toISOString().substring(0, 10)
            : String(r.orphan_date ?? "").substring(0, 10),
          amount: Number(r.orphan_amount),
          currency: r.orphan_currency,
          payee: r.orphan_payee,
        },
        bill: r.matched_invoice_id == null ? null : {
          invoice_id: r.matched_invoice_id,
          invoice_number: r.invoice_number,
          reference: r.bill_reference,
          contact: r.bill_contact,
          date: r.bill_date instanceof Date
            ? r.bill_date.toISOString().substring(0, 10)
            : String(r.bill_date ?? "").substring(0, 10),
          status: r.bill_status,
          total: r.bill_total == null ? null : Number(r.bill_total),
          currency: r.bill_currency,
        },
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ count: formatted.length, rows: formatted }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `list_inbox_files failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "poll_mailbox_inbox",
  "Fetch new supplier invoice emails from the xero@intactix.io mailbox (IMAP, read-only — never marks/moves/deletes mail). " +
  "This is the PRIMARY supplier-invoice source; poll_xero_inbox/the Xero Files inbox is a legacy fallback. " +
  "Inserts one row per PDF attachment into mailbox_invoice_files with status='new', keyed on IMAP UID so a message is never processed twice. " +
  "Returns only newly discovered attachments. Requires MAILBOX_IMAP_HOST/PORT/USER/PASSWORD in .env.",
  {},
  async () => {
    try {
      const newFiles = await recordNewMailboxFiles(mailboxClient);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            newFiles,
            message: newFiles.length === 0
              ? "No new supplier invoice emails since last poll."
              : `${newFiles.length} new attachment(s) found. Use list_mailbox_files to get their id, download_mailbox_attachment to read each one, then extract fields and call create_bill_from_mailbox_file (dry_run=true first) or match_inbox_file_to_spend for card-spend chasing.`,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `poll_mailbox_inbox failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "list_mailbox_files",
  "List supplier invoice mailbox attachments known to the local warehouse with their extraction and bill-link state. " +
  "Use this before claiming an invoice email is missing: status='new' or status='processing' means the attachment exists but has not been coded yet.",
  {
    status: z.enum(["new", "processing", "matched", "no_match", "error", "all"]).default("all")
      .describe("Mailbox file status filter"),
    filename_contains: z.string().optional().describe("Case-insensitive filename substring filter"),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max rows"),
  },
  async ({ status, filename_contains, limit }) => {
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      if (status !== "all") {
        conditions.push("status = ?");
        params.push(status);
      }
      if (filename_contains) {
        conditions.push("LOWER(attachment_filename) LIKE ?");
        params.push(`%${filename_contains.toLowerCase()}%`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const rows = await query<any[]>(
        `SELECT id, uid, message_id, from_address, subject, received_at, attachment_filename, attachment_size,
                status, extracted_supplier, extracted_amount, extracted_currency, extracted_date,
                matched_orphan_id, matched_invoice_id
         FROM mailbox_invoice_files
         ${where}
         ORDER BY received_at DESC, id DESC
         LIMIT ?`,
        [...params, limit]
      );

      return { content: [{ type: "text", text: JSON.stringify({ count: rows.length, rows }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `list_mailbox_files failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "audit_inbox_bill_state",
  "Audit Xero inbox file state against spend orphans, write logs, and synced ACCPAY bills. " +
  "Use this before saying a receipt is missing or before creating a bill, especially when the Xero inbox has a backlog.",
  {
    tenant_id: z.string().optional().describe("Xero tenant ID — defaults to XERO_TENANT_ID in .env"),
    stale_processing_hours: z.coerce.number().int().min(1).max(720).default(24)
      .describe("Age threshold for processing files to count as stale"),
    sample_limit: z.coerce.number().int().min(1).max(100).default(25)
      .describe("Max sample rows per exception category"),
  },
  async ({ tenant_id, stale_processing_hours, sample_limit }) => {
    try {
      const tenantId = tenant_id ?? config.XERO_TENANT_ID;
      if (!tenantId) throw new Error("tenant_id is required");

      const [inboxStatus, linkHealth, orphanStatus, writeStatus] = await Promise.all([
        query<any[]>(
          `SELECT status, COUNT(*) AS count
           FROM xero_inbox_files
           WHERE tenant_id = ?
           GROUP BY status
           ORDER BY status`,
          [tenantId]
        ),
        query<any[]>(
          `SELECT
             COUNT(*) AS inbox_total,
             SUM(f.status IN ('new','processing') AND f.matched_orphan_id IS NULL AND f.matched_invoice_id IS NULL) AS unmatched_files,
             SUM(f.status = 'processing' AND f.updated_at < DATE_SUB(NOW(), INTERVAL ? HOUR)) AS stale_processing,
             SUM(f.status = 'matched' AND f.matched_orphan_id IS NOT NULL) AS matched_with_orphan,
             SUM(f.status = 'matched' AND f.matched_invoice_id IS NOT NULL) AS matched_with_invoice,
             SUM(f.status = 'matched' AND f.matched_invoice_id IS NOT NULL AND inv.invoice_id IS NULL) AS matched_missing_synced_bill
           FROM xero_inbox_files f
           LEFT JOIN xero_invoice_balances inv
             ON inv.tenant_id = f.tenant_id
            AND inv.invoice_id = f.matched_invoice_id
           WHERE f.tenant_id = ?`,
          [stale_processing_hours, tenantId]
        ),
        query<any[]>(
          `SELECT
             status,
             COUNT(*) AS count,
             SUM(matched_file_id IS NOT NULL) AS with_file,
             SUM(matched_invoice_id IS NOT NULL) AS with_invoice
           FROM bank_spend_orphans
           WHERE tenant_id = ?
           GROUP BY status
           ORDER BY status`,
          [tenantId]
        ),
        query<any[]>(
          `SELECT operation, status, dry_run, COUNT(*) AS count
           FROM xero_write_log
           WHERE tenant_id = ?
             AND operation IN ('CREATE_BILL', 'RECODE_BILL', 'ATTACH_PDF')
           GROUP BY operation, status, dry_run
           ORDER BY operation, status, dry_run`,
          [tenantId]
        ),
      ]);

      const unmatched = await query<any[]>(
        `SELECT id, file_id, file_name, status, created_date_utc, updated_at,
                extracted_supplier, extracted_amount, extracted_currency, extracted_date
         FROM xero_inbox_files
         WHERE tenant_id = ?
           AND status IN ('new','processing')
           AND matched_orphan_id IS NULL
           AND matched_invoice_id IS NULL
         ORDER BY created_date_utc DESC
         LIMIT ?`,
        [tenantId, sample_limit]
      );

      const billRows = await query<any[]>(
        `SELECT invoice_id, invoice_number, reference, contact_name, invoice_date, status, currency_code, total
         FROM xero_invoice_balances
         WHERE tenant_id = ?
           AND invoice_type = 'ACCPAY'
           AND status NOT IN ('DELETED','VOIDED')
           AND (COALESCE(invoice_number, '') <> '' OR COALESCE(reference, '') <> '')
         ORDER BY invoice_date DESC
         LIMIT 1000`,
        [tenantId]
      );

      const likelyExistingBillMatches: any[] = [];
      for (const file of unmatched) {
        const fileName = String(file.file_name ?? "").toLowerCase();
        const matches = billRows.filter((bill) => {
          const invoiceNumber = String(bill.invoice_number ?? "").trim().toLowerCase();
          const reference = String(bill.reference ?? "").trim().toLowerCase();
          return (invoiceNumber.length >= 4 && fileName.includes(invoiceNumber)) ||
            (reference.length >= 4 && fileName.includes(reference));
        });
        for (const bill of matches.slice(0, 3)) {
          likelyExistingBillMatches.push({
            file_id: file.file_id,
            file_name: file.file_name,
            file_status: file.status,
            matched_on: String(bill.invoice_number ?? "").trim() &&
              fileName.includes(String(bill.invoice_number).trim().toLowerCase())
              ? "invoice_number"
              : "reference",
            bill: {
              invoice_id: bill.invoice_id,
              invoice_number: bill.invoice_number,
              reference: bill.reference,
              contact: bill.contact_name,
              date: bill.invoice_date instanceof Date
                ? bill.invoice_date.toISOString().substring(0, 10)
                : String(bill.invoice_date ?? "").substring(0, 10),
              status: bill.status,
              total: bill.total == null ? null : Number(bill.total),
              currency: bill.currency_code,
            },
          });
        }
        if (likelyExistingBillMatches.length >= sample_limit) break;
      }

      const staleProcessing = await query<any[]>(
        `SELECT file_id, file_name, status, created_date_utc, updated_at,
                extracted_supplier, extracted_amount, extracted_currency, extracted_date
         FROM xero_inbox_files
         WHERE tenant_id = ?
           AND status = 'processing'
           AND matched_orphan_id IS NULL
           AND matched_invoice_id IS NULL
           AND updated_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
         ORDER BY updated_at ASC
         LIMIT ?`,
        [tenantId, stale_processing_hours, sample_limit]
      );

      const matchedMissingSyncedBill = await query<any[]>(
        `SELECT f.file_id, f.file_name, f.matched_orphan_id, f.matched_invoice_id,
                bso.transaction_date, bso.amount, bso.currency, bso.payee
         FROM xero_inbox_files f
         LEFT JOIN bank_spend_orphans bso
           ON bso.tenant_id = f.tenant_id
          AND bso.id = f.matched_orphan_id
         LEFT JOIN xero_invoice_balances inv
           ON inv.tenant_id = f.tenant_id
          AND inv.invoice_id = f.matched_invoice_id
         WHERE f.tenant_id = ?
           AND f.status = 'matched'
           AND f.matched_invoice_id IS NOT NULL
           AND inv.invoice_id IS NULL
         ORDER BY f.updated_at DESC
         LIMIT ?`,
        [tenantId, sample_limit]
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: {
              inbox_by_status: inboxStatus,
              link_health: linkHealth[0],
              spend_orphans_by_status: orphanStatus,
              write_log_by_status: writeStatus,
            },
            exceptions: {
              unmatched_files_sample: unmatched,
              stale_processing_sample: staleProcessing,
              matched_missing_synced_bill: matchedMissingSyncedBill,
              likely_existing_bill_matches: likelyExistingBillMatches,
            },
            next_steps: [
              "For likely_existing_bill_matches, link/archive manually or add a DB repair tool after confirming attachment state in Xero.",
              "For stale_processing_sample, re-download/extract the file or reset to new after inspecting the failure.",
              "For unmatched_files_sample, extract document fields, run match_inbox_file_to_spend, dry-run apply_inbox_match, then create DRAFT only after review.",
              "If matched_missing_synced_bill is non-empty, sync_transactions for the affected invoice date range before treating those bills as missing."
            ],
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `audit_inbox_bill_state failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "download_inbox_file",
  "Download the binary content of a Xero inbox file and return it base64-encoded. " +
  "Pass this to a vision/document-reading tool to extract supplier name, amount, currency, and date from the receipt or invoice. " +
  "Updates xero_inbox_files.status to 'processing'.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    file_id: z.string().describe("Xero file ID from poll_xero_inbox"),
  },
  async ({ tenant_id, file_id }) => {
    try {
      await execute(
        `UPDATE xero_inbox_files SET status='processing' WHERE tenant_id=? AND file_id=? AND status='new'`,
        [tenant_id, file_id]
      );
      const { buffer, mimeType } = await filesClient.downloadFile(tenant_id, file_id);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            file_id,
            mime_type: mimeType,
            size_bytes: buffer.length,
            content_base64: buffer.toString("base64"),
            instructions: "Decode content_base64 and pass to a vision/PDF reader. Extract: supplier_name, amount, currency (ISO), date (YYYY-MM-DD). Then call match_inbox_file_to_spend with the extracted fields.",
          }, null, 2),
        }],
      };
    } catch (err) {
      await execute(
        `UPDATE xero_inbox_files SET status='error' WHERE tenant_id=? AND file_id=?`,
        [tenant_id, file_id]
      ).catch(() => {});
      return { content: [{ type: "text", text: `download_inbox_file failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "attach_mailbox_file_to_bill",
  "Attach a supplier invoice PDF from the invoice mailbox to an EXISTING Xero bill (ACCPAY). " +
  "Use for bills that were created without a PDF. Attach-only: never changes amounts, tax, status or contact. " +
  "Defaults to dry_run=true; call with dry_run=false only after the human approved the bill/file pair. " +
  "Refuses non-PDF files and any file whose name contains 'Settlement' (CURO settlement docs are never bills).",
  {
    xero_invoice_id: z.string().describe("Xero InvoiceID (UUID) of the existing bill."),
    mailbox_file_id: z.coerce.number().int().positive().describe("id from list_mailbox_files."),
    dry_run: z.boolean().default(true).describe("true = log only, no Xero call."),
    tenant_id: z.string().optional().describe("Xero tenant ID. Defaults to the configured XERO_TENANT_ID."),
  },
  async ({ xero_invoice_id, mailbox_file_id, dry_run, tenant_id }) => {
    try {
      const rows = await query<any[]>(
        `SELECT id, uid, attachment_filename FROM mailbox_invoice_files WHERE id = ?`,
        [mailbox_file_id]
      );
      const file = rows[0];
      if (!file) {
        return { content: [{ type: "text", text: `Mailbox file ${mailbox_file_id} is not known locally.` }], isError: true };
      }
      const name: string = file.attachment_filename;
      if (/settlement/i.test(name)) {
        return { content: [{ type: "text", text: `Refused: "${name}" is a settlement document and is never attached to a bill.` }], isError: true };
      }
      if (!/\.pdf$/i.test(name)) {
        return { content: [{ type: "text", text: `Refused: "${name}" is not a PDF (attachPdf sends application/pdf).` }], isError: true };
      }
      const { resolveTenantId } = await import("../db/repositories.js");
      const tenantId = tenant_id ?? await resolveTenantId(config.XERO_TENANT_ID);
      const buffer = await mailboxClient.downloadAttachment(Number(file.uid), name);
      const writeClient = new XeroWriteClient();
      const result = await writeClient.attachPdf(tenantId, xero_invoice_id, name, buffer, dry_run);
      return { content: [{ type: "text", text: JSON.stringify({ invoiceId: xero_invoice_id, mailbox_file_id, filename: name, bytes: buffer.length, dry_run, ...result }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `attach_mailbox_file_to_bill failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "download_mailbox_attachment",
  "Download the binary content of a supplier invoice mailbox attachment and return it base64-encoded. " +
  "Pass this to a vision/document-reading tool to extract supplier name, amount, currency, and date. " +
  "Updates mailbox_invoice_files.status to 'processing'.",
  {
    mailbox_file_id: z.coerce.number().int().positive().describe("id from list_mailbox_files / poll_mailbox_inbox"),
  },
  async ({ mailbox_file_id }) => {
    try {
      const rows = await query<any[]>(
        `SELECT id, uid, attachment_filename FROM mailbox_invoice_files WHERE id = ?`,
        [mailbox_file_id]
      );
      const file = rows[0];
      if (!file) {
        return { content: [{ type: "text", text: `Mailbox file ${mailbox_file_id} is not known locally. Run poll_mailbox_inbox first.` }], isError: true };
      }
      await execute(
        `UPDATE mailbox_invoice_files SET status='processing' WHERE id=? AND status='new'`,
        [mailbox_file_id]
      );
      const buffer = await mailboxClient.downloadAttachment(Number(file.uid), file.attachment_filename);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            mailbox_file_id,
            filename: file.attachment_filename,
            mime_type: "application/pdf",
            size_bytes: buffer.length,
            content_base64: buffer.toString("base64"),
            instructions: "Decode content_base64 and pass to a vision/PDF reader. Extract: supplier_name, amount, currency (ISO), date (YYYY-MM-DD), invoice_number. Then call create_bill_from_mailbox_file (dry_run=true first), or match_inbox_file_to_spend if this is chasing a known card-spend line.",
          }, null, 2),
        }],
      };
    } catch (err) {
      await execute(
        `UPDATE mailbox_invoice_files SET status='error' WHERE id=?`,
        [mailbox_file_id]
      ).catch(() => {});
      return { content: [{ type: "text", text: `download_mailbox_attachment failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "match_inbox_file_to_spend",
  "Given fields extracted from an inbox receipt or invoice, query bank_spend_orphans for candidate matches. " +
  "Matches on amount (±0.50 tolerance), date (±7 days), and optionally currency and supplier name. " +
  "For Wise card spend, also surfaces non-EUR supplier documents paid from the EUR account. " +
  "Returns ranked candidates with a basic confidence score. " +
  "Once you select the correct match, call apply_inbox_match to create the DRAFT bill.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    file_id: z.string().describe("Xero file ID being matched"),
    supplier_name: z.string().describe("Supplier name extracted from the document"),
    amount: z.coerce.number().describe("Total amount extracted from the document (positive)"),
    currency: z.string().length(3).describe("ISO 4217 currency code extracted from the document"),
    date: z.string().describe("Invoice/receipt date (YYYY-MM-DD) extracted from the document"),
  },
  async ({ tenant_id, file_id, supplier_name, amount, currency, date }) => {
    try {
      const rows = await query<any[]>(
        `SELECT id, xero_bank_tx_id, transaction_date, amount, currency, contact_name,
                payee, description, reference, cardholder, card_last4, bank_account_code, status
         FROM bank_spend_orphans
         WHERE tenant_id = ?
           AND status IN ('flagged','chasing','received')
           AND transaction_date BETWEEN DATE_SUB(?, INTERVAL 7 DAY) AND DATE_ADD(?, INTERVAL 7 DAY)
           AND (
             ABS(amount - ?) <= 0.50
             OR (
               ? <> 'EUR'
               AND currency = 'EUR'
               AND (
                 reference LIKE '%Wise card payment%'
                 OR description LIKE '%Wise card payment%'
               )
             )
           )
         ORDER BY
           CASE WHEN ABS(amount - ?) <= 0.50 THEN 0 ELSE 1 END,
           ABS(DATEDIFF(transaction_date, ?)),
           ABS(amount - ?)
         LIMIT 25`,
        [tenant_id, date, date, amount, currency, amount, date, amount]
      );

      const scored = rows.map((r) => {
        let confidence = 0.5;
        const exactAmount = Math.abs(Number(r.amount) - amount) < 0.01;
        const wiseEurCardPayment =
          currency !== "EUR" &&
          r.currency === "EUR" &&
          ((r.reference ?? "").includes("Wise card payment") ||
            (r.description ?? "").includes("Wise card payment"));

        if (exactAmount) confidence += 0.2;
        if (r.currency === currency) confidence += 0.15;
        const nameMatch = supplier_name.toLowerCase();
        const contactLower = (r.contact_name ?? "").toLowerCase();
        const payeeLower = (r.payee ?? "").toLowerCase();
        const descLower = (r.description ?? "").toLowerCase();
        if (contactLower && nameMatch.includes(contactLower.substring(0, 6))) confidence += 0.1;
        if (payeeLower && nameMatch.includes(payeeLower.substring(0, 6))) confidence += 0.2;
        if (descLower && descLower.includes(nameMatch.substring(0, 6))) confidence += 0.05;
        if (wiseEurCardPayment) confidence += 0.1;
        return { ...r, confidence: Math.min(confidence, 0.99), match_basis: wiseEurCardPayment && !exactAmount ? "wise_eur_card_cross_currency" : "amount_date" };
      });

      // Mark file as processing
      await execute(
        `UPDATE xero_inbox_files
         SET status='processing', extracted_supplier=?, extracted_amount=?, extracted_currency=?, extracted_date=?
         WHERE tenant_id=? AND file_id=?`,
        [supplier_name, amount, currency, date, tenant_id, file_id]
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            file_id,
            extracted: { supplier_name, amount, currency, date },
            candidates: scored,
            next_step: scored.length > 0
              ? "Review candidates, select the correct orphan_id, then call apply_inbox_match."
              : "No candidates found within ±0.50 amount and ±7 day date. Consider widening the search or calling dismiss_spend_orphan if this receipt has no matching transaction.",
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `match_inbox_file_to_spend failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "apply_inbox_match",
	  "Create a DRAFT ACCPAY bill in Xero for an inbox file matched to a bank spend orphan. " +
	  "Always run with dry_run=true first to verify the payload before committing. " +
	  "The created bill amount follows the matched Xero/bank transaction amount; document currency/amount is matching evidence. " +
	  "For Wise card statement rows, a separately recorded FEE-CARD line is subtracted from the provider gross so the bill matches the net Xero transaction. " +
	  "Downloads the inbox file and attaches it to the created bill. " +
  "If account_code is unknown, default '850' (Suspense) is used — the agent should resolve coding via supplier rules before applying. " +
  "Requires XERO_WRITE_ENABLED=true and files.read + accounting.transactions OAuth scopes.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    file_id: z.string().describe("Xero file ID from poll_xero_inbox"),
    orphan_id: z.coerce.number().int().describe("bank_spend_orphans.id to match against"),
    supplier_name: z.string().describe("Supplier / contact name for the Xero bill"),
	    amount: z.coerce.number().describe("Extracted document amount or candidate transaction amount (positive); matched Xero/bank evidence may override this for bill creation"),
	    currency: z.string().length(3).describe("ISO 4217 currency code from the extracted document or candidate transaction"),
    date: z.string().describe("Bill date (YYYY-MM-DD)"),
    description: z.string().optional().describe("Line item description"),
    account_code: z.string().optional().describe("Xero account code for the expense line (default: 850 Suspense)"),
    tax_code: z.string().optional().describe("Xero tax type (e.g. INPUT2, NONE, EXEMPTINPUT)"),
    contact_id: z.string().optional().describe("Xero ContactID override (supply if contact already exists in Xero)"),
    dry_run: z.boolean().describe("true=preview only (no Xero write); false=create DRAFT bill"),
  },
  async ({ tenant_id, file_id, orphan_id, supplier_name, amount, currency, date, description, account_code, tax_code, contact_id, dry_run }) => {
    try {
      const result = await applyInboxMatch(
        tenant_id,
        file_id,
        orphan_id,
        { supplierName: supplier_name, amount, currency, date, description, accountCode: account_code, taxCode: tax_code },
        { dryRun: dry_run, contactOverrides: contact_id ? { [`inbox:${file_id}`]: contact_id } : undefined }
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `apply_inbox_match failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "create_bill_from_inbox_file",
	  "Create a DRAFT ACCPAY bill directly from a Xero inbox file when the matching bank transaction is visible in bank evidence " +
	  "but there is no bank_spend_orphans row. Always run dry_run=true first. " +
	  "For Wise EUR card/FX payments where the provider gross includes a separately recorded Xero fee, pass the gross amount as amount " +
	  "and the separate Xero fee as separate_xero_fee_amount; the bill will be created for the net transaction amount. " +
	  "Downloads and attaches the inbox file on commit.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    file_id: z.string().describe("Xero inbox file ID"),
    supplier_name: z.string().describe("Supplier / contact name for the Xero bill"),
	    amount: z.coerce.number().positive().describe("Bill amount in the transaction/account currency, or Wise gross amount when separate_xero_fee_amount is supplied"),
	    separate_xero_fee_amount: z.coerce.number().positive().optional().describe("Separately recorded Xero Wise/card fee to subtract from amount so the bill matches the net Xero transaction"),
    currency: z.string().length(3).describe("ISO 4217 currency code for the bill"),
    date: z.string().describe("Bill date YYYY-MM-DD"),
    description: z.string().optional().describe("Line item description"),
    account_code: z.string().optional().describe("Xero expense account code. Defaults to 850 Suspense if unresolved."),
    tax_code: z.string().optional().describe("Xero tax type"),
    reference: z.string().optional().describe("Bill Reference from invoice or transaction evidence"),
    invoice_number: z.string().optional().describe("Supplier invoice number if visible"),
    contact_id: z.string().optional().describe("Existing Xero ContactID override"),
    dry_run: z.boolean().default(true).describe("true=preview only; false=create DRAFT bill and attach file"),
  },
	  async ({ tenant_id, file_id, supplier_name, amount, separate_xero_fee_amount, currency, date, description, account_code, tax_code, reference, invoice_number, contact_id, dry_run }) => {
	    try {
	      const billAmount = separate_xero_fee_amount
	        ? Math.round((amount - separate_xero_fee_amount + Number.EPSILON) * 100) / 100
	        : amount;
	      if (billAmount <= 0) {
	        return { content: [{ type: "text", text: `Net bill amount must be positive after subtracting separate_xero_fee_amount. amount=${amount}, separate_xero_fee_amount=${separate_xero_fee_amount}` }], isError: true };
	      }
	      const fileRows = await query<any[]>(
        `SELECT file_id, file_name, status, matched_invoice_id
         FROM xero_inbox_files
         WHERE tenant_id=? AND file_id=?`,
        [tenant_id, file_id]
      );
      const file = fileRows[0];
      if (!file) {
        return { content: [{ type: "text", text: `Inbox file ${file_id} is not known locally. Run poll_xero_inbox first.` }], isError: true };
      }

      const existing = await query<any[]>(
         `SELECT invoice_id, invoice_number, reference, contact_name, status, total, currency_code
         FROM xero_invoice_balances
         WHERE tenant_id=?
           AND invoice_type='ACCPAY'
           AND status NOT IN ('DELETED','VOIDED')
           AND (
             (? IS NOT NULL AND reference = ?)
             OR (? IS NOT NULL AND invoice_number = ?)
             OR (? IS NOT NULL AND invoice_id = ?)
           )
         LIMIT 5`,
        [
          tenant_id,
          reference ?? null, reference ?? null,
          invoice_number ?? null, invoice_number ?? null,
          file.matched_invoice_id ?? null, file.matched_invoice_id ?? null,
        ]
      );
      if (existing.length > 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              skipped: true,
              reason: "A non-deleted ACCPAY bill already exists for this reference/invoice/file link.",
              file,
              existing_bills: existing,
              next_step: "If the inbox file is already attached or no longer needed, use delete_inbox_file with dry_run=true first.",
            }, null, 2),
          }],
        };
      }

	      const line: any = {
	        Description: description ?? supplier_name,
	        Quantity: 1,
	        UnitAmount: billAmount,
	        AccountCode: account_code ?? "850",
	      };
      if (tax_code) line.TaxType = tax_code;

      const payload: any = {
        Type: "ACCPAY",
        Contact: contact_id ? { ContactID: contact_id } : { Name: supplier_name },
        Date: date,
        DueDate: date,
        LineAmountTypes: "Inclusive",
        CurrencyCode: currency,
        LineItems: [line],
      };
      if (reference) payload.Reference = reference;
      if (invoice_number) payload.InvoiceNumber = invoice_number;

	      const idempotencyKey = `inbox-bill:${shortHash(`${tenant_id}:${file_id}:${reference ?? ""}:${invoice_number ?? ""}:${date}:${billAmount}:${currency}`)}`;
      const created = await inboxWriteClient.createBill(
        tenant_id,
        payload,
        idempotencyKey,
        reference ?? invoice_number ?? `INBOX:${file_id}`,
        dry_run
      );

      let attachment: any = null;
      if (!dry_run) {
        const download = await filesClient.downloadFile(tenant_id, file_id);
        attachment = await inboxWriteClient.attachPdf(tenant_id, created.InvoiceID, file.file_name, download.buffer, false);
        await execute(
          `UPDATE xero_inbox_files
           SET status='matched',
               extracted_supplier=?,
	               extracted_amount=?,
               extracted_currency=?,
               extracted_date=?,
               matched_invoice_id=?
           WHERE tenant_id=? AND file_id=?`,
	          [supplier_name, billAmount, currency, date, created.InvoiceID, tenant_id, file_id]
	        );
	      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            dry_run,
            file: { file_id, file_name: file.file_name },
	            payload,
	            amount_adjustment: separate_xero_fee_amount ? {
	              input_gross_amount: amount,
	              separate_xero_fee_amount,
	              net_bill_amount: billAmount,
	              rule: "Wise/provider gross minus separately recorded Xero fee",
	            } : null,
	            created,
            attachment,
            next_step: dry_run ? "Review payload, then call again with dry_run=false if correct." : "Bill created and inbox file attached. Use delete_inbox_file dry_run=true if this file should now be removed from the inbox.",
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `create_bill_from_inbox_file failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "create_bill_from_mailbox_file",
  "Create a DRAFT ACCPAY bill directly from a supplier invoice mailbox attachment (xero@intactix.io). " +
  "Always run dry_run=true first. Downloads the attachment from the mailbox and attaches it to the bill on commit. " +
  "For Wise EUR card/FX payments where the provider gross includes a separately recorded Xero fee, pass the gross amount as amount " +
  "and the separate Xero fee as separate_xero_fee_amount; the bill will be created for the net transaction amount.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    mailbox_file_id: z.coerce.number().int().positive().describe("id from list_mailbox_files / poll_mailbox_inbox"),
    supplier_name: z.string().describe("Supplier / contact name for the Xero bill"),
    amount: z.coerce.number().positive().describe("Bill amount in the transaction/account currency, or Wise gross amount when separate_xero_fee_amount is supplied"),
    separate_xero_fee_amount: z.coerce.number().positive().optional().describe("Separately recorded Xero Wise/card fee to subtract from amount so the bill matches the net Xero transaction"),
    currency: z.string().length(3).describe("ISO 4217 currency code for the bill"),
    date: z.string().describe("Bill date YYYY-MM-DD"),
    description: z.string().optional().describe("Line item description"),
    account_code: z.string().optional().describe("Xero expense account code, resolved from the rule register (knowledge/rule-register.md) or a verified supplier profile. REQUIRED — there is no default. Missing, unresolved, or invalid codes refuse the write and return a needs_review result instead."),
    account_code_reason: z.string().optional().describe("Required only when account_code is 850 (Suspense): cite the specific IAR-009 temporary-holding case (card check, refund, failed/duplicated/pending transaction, short-lived clearing item) that makes Suspense legitimate here. 850 is never accepted without this."),
    tax_code: z.string().optional().describe("Xero tax type"),
    reference: z.string().optional().describe("Bill Reference from invoice or transaction evidence"),
    invoice_number: z.string().optional().describe("Supplier invoice number if visible"),
    contact_id: z.string().optional().describe("Existing Xero ContactID override"),
    dry_run: z.boolean().default(true).describe("true=preview only; false=create DRAFT bill and attach file"),
  },
  async ({ tenant_id, mailbox_file_id, supplier_name, amount, separate_xero_fee_amount, currency, date, description, account_code, account_code_reason, tax_code, reference, invoice_number, contact_id, dry_run }) => {
    try {
      const billAmount = separate_xero_fee_amount
        ? Math.round((amount - separate_xero_fee_amount + Number.EPSILON) * 100) / 100
        : amount;
      if (billAmount <= 0) {
        return { content: [{ type: "text", text: `Net bill amount must be positive after subtracting separate_xero_fee_amount. amount=${amount}, separate_xero_fee_amount=${separate_xero_fee_amount}` }], isError: true };
      }
      const fileRows = await query<any[]>(
        `SELECT id, uid, attachment_filename, status, matched_invoice_id
         FROM mailbox_invoice_files
         WHERE id=?`,
        [mailbox_file_id]
      );
      const file = fileRows[0];
      if (!file) {
        return { content: [{ type: "text", text: `Mailbox file ${mailbox_file_id} is not known locally. Run poll_mailbox_inbox first.` }], isError: true };
      }

      // Standing CURO Payments B.V. document rules (D30 Settlement-never-draft, D36
      // request-for-payment-is-Exceptions), enforced here rather than left as prose in a
      // planning doc — see src/bills/curo-document-guard.ts. Checked first and
      // categorically: no account_code, contact_id, or other override can get a CURO
      // Settlement/Statement/Invoice document past this.
      const curoCheck = checkCuroDocument(supplier_name, file.attachment_filename);
      if (!curoCheck.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              needs_review: true,
              reason: curoCheck.reason,
              file: { mailbox_file_id, filename: file.attachment_filename },
            }, null, 2),
          }],
        };
      }

      // Duplicate detection reuses the single shared algorithm (checkDuplicate, bills/routing.ts)
      // rather than a separate check living only in this tool — exact reference/invoice_number/
      // invoice_id match, OR supplier+date+amount together when reference is missing/doesn't
      // match. Never flags on supplier+amount alone (see routing.ts for why). The facts passed
      // in are this call's own just-read-from-the-document values (supplier_name/billAmount/date),
      // not mailbox_invoice_files.extracted_*, which is usually unpopulated for mailbox-sourced bills.
      const duplicateCheck = await checkDuplicate(
        {
          id: file.id,
          status: file.status,
          matched_orphan_id: null,
          matched_invoice_id: file.matched_invoice_id,
          extracted_supplier: supplier_name,
          extracted_amount: billAmount,
          extracted_currency: currency,
          extracted_date: date,
        },
        { tenantId: tenant_id, reference: reference ?? null, invoiceNumber: invoice_number ?? null },
        (sql, args) => query<any[]>(sql, args)
      );
      if (duplicateCheck.result === "duplicate") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              needs_review: true,
              reason: duplicateCheck.match
                ? `Potential duplicate: an existing ACCPAY bill already matches ${duplicateCheck.match.invoice_number ?? duplicateCheck.match.reference ?? duplicateCheck.reference} (${duplicateCheck.match.contact_name ?? supplier_name}, ${duplicateCheck.match.currency_code ?? currency}${duplicateCheck.match.total ?? ""}, ${duplicateCheck.match.status}). Refusing to create a new bill — review and confirm manually before proceeding.`
                : "Potential duplicate detected — refusing to create a new bill. Review and confirm manually before proceeding.",
              file: { mailbox_file_id, filename: file.attachment_filename },
              matching_bill: duplicateCheck.match,
            }, null, 2),
          }],
        };
      }

      // Account coding is never resolved by this tool and never defaults to 850 Suspense —
      // see src/bills/account-code-guard.ts. A missing, invalid, archived, wrong-type, or
      // unjustified-850 account_code refuses the write entirely (dry_run or not) and comes
      // back as needs_review instead, so a coding gap can never silently land in Xero.
      const chartAccounts = await query<any[]>(
        `SELECT code, name, type, status FROM xero_accounts WHERE tenant_id=? AND code IS NOT NULL`,
        [tenant_id]
      );
      const accountCodeCheck = checkAccountCodeForBill(account_code, account_code_reason, chartAccounts);
      if (!accountCodeCheck.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              needs_review: true,
              reason: accountCodeCheck.reason,
              file: { mailbox_file_id, filename: file.attachment_filename },
              supplied_account_code: account_code ?? null,
            }, null, 2),
          }],
        };
      }

      // Contact resolution previously had zero dedup awareness here: `contact_id ?? {Name}`
      // let Xero's own fuzzy matching silently pick or create a contact — exactly how this
      // project's known near-duplicate contacts (Paulo Tomas/Thomas, Kuura Solutions LLC/
      // Kuurasolutions.com, DigitalOcean LLC/Digitalocean Eu B.v., a 4-way Tradethno split,
      // etc.) came to exist. See src/bills/contact-resolution-guard.ts. An explicit
      // contact_id is still trusted outright; an ambiguous supplier_name (multiple exact
      // matches, or a near-duplicate spelling/legal-suffix variant) refuses the write and
      // comes back as needs_review naming every candidate, rather than guessing.
      const supplierContacts = await query<any[]>(
        `SELECT contact_id, name, status FROM xero_contacts WHERE tenant_id=? AND is_supplier=1`,
        [tenant_id]
      );
      const contactResolution = resolveContactForBill(supplier_name, contact_id, supplierContacts);
      if (!contactResolution.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              needs_review: true,
              reason: contactResolution.reason,
              file: { mailbox_file_id, filename: file.attachment_filename },
              supplied_supplier_name: supplier_name,
            }, null, 2),
          }],
        };
      }

      const line: any = {
        Description: description ?? supplier_name,
        Quantity: 1,
        UnitAmount: billAmount,
        AccountCode: account_code!.trim(),
      };
      if (tax_code) line.TaxType = tax_code;

      const payload: any = {
        Type: "ACCPAY",
        Contact: contactResolution.contactId ? { ContactID: contactResolution.contactId } : { Name: supplier_name },
        Date: date,
        DueDate: date,
        LineAmountTypes: "Inclusive",
        CurrencyCode: currency,
        LineItems: [line],
      };
      if (reference) payload.Reference = reference;
      if (invoice_number) payload.InvoiceNumber = invoice_number;

      const idempotencyKey = `mailbox-bill:${shortHash(`${tenant_id}:${mailbox_file_id}:${reference ?? ""}:${invoice_number ?? ""}:${date}:${billAmount}:${currency}`)}`;
      const created = await inboxWriteClient.createBill(
        tenant_id,
        payload,
        idempotencyKey,
        reference ?? invoice_number ?? `MAILBOX:${mailbox_file_id}`,
        dry_run
      );

      let attachment: any = null;
      if (!dry_run) {
        const buffer = await mailboxClient.downloadAttachment(Number(file.uid), file.attachment_filename);
        attachment = await inboxWriteClient.attachPdf(tenant_id, created.InvoiceID, file.attachment_filename, buffer, false);
        await execute(
          `UPDATE mailbox_invoice_files
           SET status='matched',
               extracted_supplier=?,
               extracted_amount=?,
               extracted_currency=?,
               extracted_date=?,
               matched_invoice_id=?
           WHERE id=?`,
          [supplier_name, billAmount, currency, date, created.InvoiceID, mailbox_file_id]
        );
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            dry_run,
            file: { mailbox_file_id, filename: file.attachment_filename },
            payload,
            amount_adjustment: separate_xero_fee_amount ? {
              input_gross_amount: amount,
              separate_xero_fee_amount,
              net_bill_amount: billAmount,
              rule: "Wise/provider gross minus separately recorded Xero fee",
            } : null,
            created,
            attachment,
            next_step: dry_run ? "Review payload, then call again with dry_run=false if correct." : "Bill created and mailbox attachment attached.",
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `create_bill_from_mailbox_file failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "delete_inbox_file",
  "Delete a file from the live Xero Files inbox after confirming it has a non-deleted linked ACCPAY bill. " +
  "Defaults to dry_run=true and refuses ambiguous deletes unless force=true.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    file_id: z.string().describe("Xero inbox file ID"),
    dry_run: z.boolean().default(true).describe("true=preview only; false=delete from Xero Files"),
    force: z.boolean().default(false).describe("Allow deletion without a matched non-deleted bill link"),
    reason: z.string().optional().describe("Human/accounting reason for forced deletion"),
  },
  async ({ tenant_id, file_id, dry_run, force, reason }) => {
    try {
      const rows = await query<any[]>(
        `SELECT f.file_id, f.file_name, f.status, f.matched_invoice_id,
                i.invoice_number, i.reference, i.contact_name, i.status AS invoice_status,
                i.total, i.currency_code
         FROM xero_inbox_files f
         LEFT JOIN xero_invoice_balances i
           ON i.tenant_id=f.tenant_id AND i.invoice_id=f.matched_invoice_id
         WHERE f.tenant_id=? AND f.file_id=?`,
        [tenant_id, file_id]
      );
      const row = rows[0];
      if (!row) {
        return { content: [{ type: "text", text: `Inbox file ${file_id} is not known locally. Run poll_xero_inbox first.` }], isError: true };
      }

      const hasValidBill =
        row.matched_invoice_id &&
        row.invoice_status &&
        !["DELETED", "VOIDED"].includes(row.invoice_status);

      if (!hasValidBill && !force) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              refused: true,
              reason: "No matched non-deleted bill link found for this inbox file.",
              file: row,
              next_step: "Create/link the bill first, or rerun with force=true only after human confirmation.",
            }, null, 2),
          }],
          isError: true,
        };
      }

      if (force && !reason) {
        return { content: [{ type: "text", text: "Forced deletion requires a reason." }], isError: true };
      }

      if (!dry_run) {
        await filesClient.deleteFile(tenant_id, file_id);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            dry_run,
            deleted: !dry_run,
            force,
            reason: reason ?? null,
            file: row,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `delete_inbox_file failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "dismiss_spend_orphan",
  "Mark a bank spend orphan as not requiring a receipt — e.g. a confirmed bank fee, VAT payment, or transfer " +
  "that was incorrectly flagged. Closes the associated decision queue entry. Cannot be undone (re-run detect_spend_orphans won't re-flag it).",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    orphan_id: z.coerce.number().int().describe("bank_spend_orphans.id to dismiss"),
    reason: z.string().describe("Why no receipt is needed — stored in notes"),
  },
  async ({ tenant_id, orphan_id, reason }) => {
    try {
      const rows = await query<any[]>(
        `SELECT xero_bank_tx_id, status FROM bank_spend_orphans WHERE id=? AND tenant_id=?`,
        [orphan_id, tenant_id]
      );
      if (!rows[0]) return { content: [{ type: "text", text: `Orphan ${orphan_id} not found` }], isError: true };
      if (rows[0].status === "coded") return { content: [{ type: "text", text: `Orphan ${orphan_id} is already coded — cannot dismiss` }], isError: true };

      await execute(
        `UPDATE bank_spend_orphans SET status='dismissed', notes=? WHERE id=? AND tenant_id=?`,
        [reason, orphan_id, tenant_id]
      );
      await execute(
        `UPDATE decision_queue SET status='dismissed', answered_by='agent', answered_at=NOW(), answer=?
         WHERE queue_key=? AND status IN ('open','answered')`,
        [reason, `SPEND_ORPHAN:${rows[0].xero_bank_tx_id}`]
      );
      return { content: [{ type: "text", text: JSON.stringify({ dismissed: orphan_id, xero_bank_tx_id: rows[0].xero_bank_tx_id, reason }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `dismiss_spend_orphan failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// --- Bank statement line/provider-feed tools ---

server.tool(
  "sync_bank_statement_lines",
  "Attempt optional raw bank-feed statement-line sync from the restricted Xero Finance API (BankStatementsPlus). " +
  "This tenant/app currently runs in Accounting API fallback mode, so this tool normally exits cleanly without importing Xero raw feed lines. " +
  "Use sync_incremental, sync_wise_activities, and sync_revolut_transactions for the supported fallback path.",
  {
    lookback_days: z.coerce.number().int().min(1).max(365).default(90)
      .describe("How many days back to sync (default 90, max 365). Max 12 months per Xero API limit."),
  },
  async ({ lookback_days }) => {
    try {
      if (config.BANK_FEED_SOURCE !== "bank_statements_plus") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              synced: 0,
              accountsProcessed: 0,
              accountsSkipped: 0,
              mode: config.BANK_FEED_SOURCE,
              note: "Accounting API fallback mode: raw Xero bank-feed statement lines are unavailable. Continue with synced bank transactions, payments, transfers, reports, and direct Wise/Revolut feeds."
            }, null, 2)
          }]
        };
      }

      const { isoDateDaysAgo, todayIsoDate } = await import("../lib/dates.js");
      const fromDate = isoDateDaysAgo(lookback_days);
      const toDate = todayIsoDate();
      const result = await syncBankStatementLines(fromDate, toDate);
      if (result.scopeError) {
        return {
          content: [{
            type: "text",
            text: [
              "Finance API statement-line sync skipped.",
              "",
              result.scopeErrorMessage ?? "",
              "",
              "Fallback active:",
              "- Xero Accounting API sync still imports coded BankTransactions, invoices, payments, transfers, and reports.",
              "- Raw unreconciled feed lines are imported from direct provider feeds where configured: Wise and Revolut.",
              "- Run sync_incremental, then detect_missing_supplier_receipts."
            ].join("\n")
          }],
          isError: false
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            synced: result.synced,
            accountsProcessed: result.accountsProcessed,
            accountsSkipped: result.accountsSkipped,
            fromDate,
            toDate,
            note: result.synced === 0
              ? "No Xero Finance API statement lines returned. Accounting API fallback remains active."
              : `${result.synced} statement lines upserted. Run detect_missing_supplier_receipts to classify them.`
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `sync_bank_statement_lines failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "sync_wise_activities",
  "Sync Wise card payment activities into the bank statement lines warehouse. " +
  "This is the primary source for unreconciled Wise card spend (CARD_PAYMENT type). " +
  "Each activity is matched against coded Xero SPEND transactions to derive is_reconciled status. " +
  "Unreconciled card payments are then surfaced by detect_missing_supplier_receipts. " +
  "Requires WISE_API_TOKEN in .env.",
  {
    lookback_days: z.coerce.number().int().min(1).max(365).default(90)
      .describe("How many days back to sync (default 90, max 365)."),
  },
  async ({ lookback_days }) => {
    try {
      const { syncWiseActivities } = await import("../wise/sync-activities.js");
      const { isoDateDaysAgo, todayIsoDate } = await import("../lib/dates.js");
      const fromDate = isoDateDaysAgo(lookback_days);
      const toDate = todayIsoDate();
      const result = await syncWiseActivities(fromDate, toDate);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            synced: result.synced,
            reconciledCount: result.reconciledCount,
            unreconciledCount: result.unreconciledCount,
            skipped: result.skipped,
            fromDate,
            toDate,
            note: result.unreconciledCount > 0
              ? `${result.unreconciledCount} unreconciled card payments found. Run detect_missing_supplier_receipts to classify them.`
              : "All synced card payments appear to be reconciled in Xero."
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `sync_wise_activities failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "sync_revolut_transactions",
  "Sync Revolut transaction history into the bank statement lines warehouse. " +
  "Covers EUR Main, GBP Main, and USD Main accounts. " +
  "Each transaction is matched against coded Xero SPEND transactions to derive is_reconciled status. " +
  "Unreconciled transactions are then surfaced by detect_missing_supplier_receipts. " +
  "Requires REVOLUT_BROKER_HMAC in .env; the broker manages Revolut OAuth refresh and token rotation.",
  {
    lookback_days: z.coerce.number().int().min(1).max(365).default(90)
      .describe("How many days back to sync (default 90, max 365)."),
  },
  async ({ lookback_days }) => {
    try {
      const { syncRevolutTransactions } = await import("../revolut/sync-transactions.js");
      const { isoDateDaysAgo, todayIsoDate } = await import("../lib/dates.js");
      const fromDate = isoDateDaysAgo(lookback_days);
      const toDate = todayIsoDate();
      const result = await syncRevolutTransactions(fromDate, toDate);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            synced: result.synced,
            reconciledCount: result.reconciledCount,
            unreconciledCount: result.unreconciledCount,
            skipped: result.skipped,
            fromDate,
            toDate,
            note: result.unreconciledCount > 0
              ? `${result.unreconciledCount} unreconciled Revolut transactions found. Run detect_missing_supplier_receipts to classify them.`
              : "All synced Revolut transactions appear to be reconciled in Xero."
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `sync_revolut_transactions failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "list_bank_statement_lines",
  "List bank-feed statement lines from the local warehouse. Use unreconciled_only=true (default) to see lines " +
  "imported from supported provider feeds such as Wise/Revolut. Each line shows payee, reference, amount, date, and reconciliation status. " +
  "Run sync_incremental, sync_wise_activities, or sync_revolut_transactions first to populate the warehouse.",
  {
    unreconciled_only: z.boolean().default(true).describe("Show only unreconciled lines (default true)"),
    type: z.enum(["Debit", "Credit", "all"]).default("Debit").describe("Line type filter (default: Debit)"),
    bank_account_id: z.string().optional().describe("Filter by bank account UUID (from list_accounts)"),
    from_date: z.string().optional().describe("Start date YYYY-MM-DD"),
    to_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max rows"),
    tenant_id: z.string().optional().describe("Xero tenant ID — defaults to XERO_TENANT_ID in .env"),
  },
  async ({ unreconciled_only, type, bank_account_id, from_date, to_date, limit, tenant_id }) => {
    try {
      const conditions: string[] = ["sl.tenant_id = ?"];
      const params: any[] = [tenant_id ?? config.XERO_TENANT_ID];

      if (unreconciled_only) conditions.push("sl.is_reconciled = 0");
      conditions.push("sl.is_deleted = 0");
      if (type !== "all") { conditions.push("sl.type = ?"); params.push(type); }
      if (bank_account_id) { conditions.push("sl.bank_account_id = ?"); params.push(bank_account_id); }
      if (from_date) { conditions.push("sl.transaction_date >= ?"); params.push(from_date); }
      if (to_date) { conditions.push("sl.transaction_date <= ?"); params.push(to_date); }

      const sql = `
        SELECT
          sl.statement_line_id,
          sl.bank_account_name,
          sl.bank_account_currency AS currency,
          sl.transaction_date,
          sl.posted_date,
          sl.type,
          sl.amount,
          sl.payee,
          sl.reference,
          sl.notes,
          sl.is_reconciled,
          sl.is_duplicate,
          sl.import_source,
          bso.status AS orphan_status,
          bso.id     AS orphan_id
        FROM xero_bank_statement_lines sl
        LEFT JOIN bank_spend_orphans bso
          ON bso.tenant_id = sl.tenant_id
         AND bso.source_type = 'STATEMENT_LINE'
         AND bso.xero_bank_tx_id = sl.statement_line_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY sl.transaction_date DESC, sl.amount DESC
        LIMIT ?`;
      params.push(limit);

      const rows = await query<any[]>(sql, params);

      const formatted = rows.map((r) => ({
        id: r.statement_line_id,
        account: r.bank_account_name,
        currency: r.currency,
        date: r.transaction_date instanceof Date
          ? r.transaction_date.toISOString().substring(0, 10)
          : String(r.transaction_date ?? "").substring(0, 10),
        type: r.type,
        amount: Number(r.amount),
        payee: r.payee,
        reference: r.reference,
        notes: r.notes,
        reconciled: Boolean(r.is_reconciled),
        duplicate: Boolean(r.is_duplicate),
        import_source: r.import_source,
        orphan_status: r.orphan_status ?? null,
        orphan_id: r.orphan_id ?? null,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ count: formatted.length, rows: formatted }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `list_bank_statement_lines failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "detect_missing_supplier_receipts",
  "Detect ALL unreconciled bank/card spend that lacks a supporting document. " +
  "Accounting API fallback covers Xero bank transactions (SPEND_MONEY type, already coded but unreconciled), and " +
  "direct provider feeds cover raw bank/card lines imported from Wise/Revolut when configured. " +
  "For each debit line the tool reports: document_missing | no_doc_required | already_tracked. " +
  "No-doc lines (bank fees, card fees, FX fees) are auto-dismissed. Everything else goes to the chase queue. " +
  "Run sync_incremental before this tool to ensure the warehouse is current.",
  {
    lookback_days: z.coerce.number().int().min(1).max(365).default(90)
      .describe("Days back to look (default 90)"),
    tenant_id: z.string().optional().describe("Xero tenant ID — defaults to XERO_TENANT_ID in .env"),
  },
  async ({ lookback_days, tenant_id }) => {
    try {
      const tenantId = tenant_id ?? config.XERO_TENANT_ID;
      if (!tenantId) throw new Error("tenant_id is required");

      const [txSummary, stmtSummary] = await Promise.all([
        detectSpendOrphans(tenantId, null, { lookbackDays: lookback_days }),
        detectStatementOrphans(tenantId, null, { lookbackDays: lookback_days }),
      ]);

      const result = {
        bank_transactions: {
          detected: txSummary.detected,
          newly_flagged: txSummary.newlyFlagged,
          already_chasing: txSummary.alreadyChasing,
          by_cardholder: txSummary.byCardholder,
          note: "Accounting API fallback: Xero SPEND_MONEY bank transactions (coded but unreconciled)"
        },
        statement_lines: {
          unreconciled_debits: stmtSummary.unreconciled,
          no_doc_required: stmtSummary.noDocRequired,
          document_missing: stmtSummary.documentMissing,
          already_tracked: stmtSummary.alreadyTracked,
          auto_closed: stmtSummary.autoClosed,
          by_cardholder: stmtSummary.byCardholder,
          note: "Raw bank/card lines imported from direct provider feeds such as Wise/Revolut; Xero raw feed lines are unavailable in Accounting API fallback mode"
        },
        totals: {
          needing_action: txSummary.newlyFlagged + stmtSummary.documentMissing,
          no_doc_auto_dismissed: stmtSummary.noDocRequired,
        },
        next_step: "Run list_supporting_document_missing_queue to see the full chase list."
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `detect_missing_supplier_receipts failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "list_supporting_document_missing_queue",
  "Show all bank/card spend lines that are flagged as missing a supporting document (receipt or supplier invoice). " +
  "Covers both Xero bank transactions and raw bank-feed statement lines. " +
  "Each item shows: date, payee/supplier, amount, currency, cardholder (if card spend), and what action is needed. " +
  "Use dismiss_no_document_required to close a line that genuinely doesn't need a document (bank fee, etc.).",
  {
    tenant_id: z.string().optional().describe("Xero tenant ID — defaults to XERO_TENANT_ID in .env"),
    source_type: z.enum(["BANKTRANSACTION", "STATEMENT_LINE", "all"]).default("all")
      .describe("Filter by source type"),
    limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max rows"),
  },
  async ({ tenant_id, source_type, limit }) => {
    try {
      const tenantId = tenant_id ?? config.XERO_TENANT_ID;
      if (!tenantId) throw new Error("tenant_id is required");

      const conditions = [
        "bso.tenant_id = ?",
        "bso.status IN ('flagged', 'chasing')"
      ];
      const params: any[] = [tenantId];
      if (source_type !== "all") { conditions.push("bso.source_type = ?"); params.push(source_type); }

      const rows = await query<any[]>(
        `SELECT
           bso.id,
           bso.source_type,
           bso.xero_bank_tx_id     AS source_id,
           bso.transaction_date,
           bso.amount,
           bso.currency,
           bso.payee,
           bso.contact_name,
           bso.description,
           bso.reference,
           bso.cardholder,
           bso.card_last4,
           bso.bank_account_code,
           bso.status,
           bso.notes,
           dq.question
         FROM bank_spend_orphans bso
         LEFT JOIN decision_queue dq
           ON dq.queue_key = CONCAT(
                IF(bso.source_type='STATEMENT_LINE','STMT_ORPHAN:','SPEND_ORPHAN:'),
                bso.xero_bank_tx_id
              )
           AND dq.status IN ('open','answered')
         WHERE ${conditions.join(" AND ")}
         ORDER BY bso.transaction_date DESC
         LIMIT ?`,
        [...params, limit]
      );

      const formatted = rows.map((r) => ({
        orphan_id: r.id,
        source_type: r.source_type,
        source_id: r.source_id,
        date: r.transaction_date instanceof Date
          ? r.transaction_date.toISOString().substring(0, 10)
          : String(r.transaction_date ?? "").substring(0, 10),
        amount: Number(r.amount),
        currency: r.currency,
        payee_or_supplier: r.payee ?? r.contact_name ?? r.description ?? "(unknown)",
        reference: r.reference,
        cardholder: r.cardholder,
        card_last4: r.card_last4,
        bank_account: r.bank_account_code,
        status: r.status,
        action_needed: "Email receipt/invoice to Xero bills inbox, then run poll_xero_inbox",
        chase_question: r.question,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: formatted.length,
            queue: formatted,
            tip: "To dismiss a line that genuinely needs no document (bank fee, FX fee), call dismiss_no_document_required with the orphan_id."
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `list_supporting_document_missing_queue failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "dismiss_no_document_required",
  "Mark a spend orphan (bank transaction or statement line) as not requiring a supporting document. " +
  "Use for bank fees, card fees, FX conversion fees, inter-account transfers, or any line confirmed to need no receipt. " +
  "The orphan_id comes from list_supporting_document_missing_queue. " +
  "Cannot be undone — re-running detect_missing_supplier_receipts will not re-flag it.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    orphan_id: z.coerce.number().int().positive().describe("bank_spend_orphans.id from list_supporting_document_missing_queue"),
    reason: z.string().min(1).describe("Why no document is needed — stored for audit purposes"),
  },
  async ({ tenant_id, orphan_id, reason }) => {
    try {
      const rows = await query<any[]>(
        `SELECT xero_bank_tx_id, source_type, status FROM bank_spend_orphans
         WHERE id = ? AND tenant_id = ?`,
        [orphan_id, tenant_id]
      );
      if (!rows[0]) {
        return { content: [{ type: "text", text: `Orphan ${orphan_id} not found for tenant ${tenant_id}` }], isError: true };
      }
      if (rows[0].status === "coded") {
        return { content: [{ type: "text", text: `Orphan ${orphan_id} is already coded — cannot dismiss` }], isError: true };
      }

      await execute(
        `UPDATE bank_spend_orphans SET status = 'dismissed', notes = ? WHERE id = ? AND tenant_id = ?`,
        [reason, orphan_id, tenant_id]
      );

      const sourceType = rows[0].source_type;
      const queueKeyPrefix = sourceType === "STATEMENT_LINE" ? "STMT_ORPHAN:" : "SPEND_ORPHAN:";
      await execute(
        `UPDATE decision_queue
         SET status = 'dismissed', answered_by = 'agent', answered_at = NOW(), answer = ?
         WHERE queue_key = ? AND status IN ('open', 'answered')`,
        [reason, `${queueKeyPrefix}${rows[0].xero_bank_tx_id}`]
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            dismissed: orphan_id,
            source_type: sourceType,
            source_id: rows[0].xero_bank_tx_id,
            reason
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `dismiss_no_document_required failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "match_statement_line_to_inbox_file",
  "Link a raw bank-feed statement line to a receipt or invoice file in the Xero inbox. " +
  "This records the match and advances the orphan status to 'received', ready for bill creation. " +
  "Use list_bank_statement_lines to find the statement_line_id and poll_xero_inbox / list_inbox_files to find the file_id. " +
  "After matching, use apply_inbox_match to create a DRAFT bill from the matched file.",
  {
    tenant_id: z.string().describe("Xero tenant ID"),
    statement_line_id: z.string().describe("statement_line_id from list_bank_statement_lines"),
    inbox_file_id: z.string().describe("file_id from poll_xero_inbox or list_inbox_files"),
    dry_run: z.boolean().default(true).describe("true = preview only, no DB changes (default true)"),
  },
  async ({ tenant_id, statement_line_id, inbox_file_id, dry_run }) => {
    try {
      // Verify statement line exists
      const stmtRows = await query<any[]>(
        `SELECT statement_line_id, transaction_date, amount, bank_account_currency, payee, reference, type, is_reconciled
         FROM xero_bank_statement_lines
         WHERE tenant_id = ? AND statement_line_id = ?`,
        [tenant_id, statement_line_id]
      );
      if (!stmtRows[0]) {
        return { content: [{ type: "text", text: `Statement line ${statement_line_id} not found. Run sync_incremental or the relevant provider sync first.` }], isError: true };
      }
      const stmt = stmtRows[0];

      // Verify inbox file exists
      const fileRows = await query<any[]>(
        `SELECT file_id, file_name, mime_type, size_bytes, created_date_utc
         FROM xero_inbox_files WHERE tenant_id = ? AND file_id = ?`,
        [tenant_id, inbox_file_id]
      );
      if (!fileRows[0]) {
        return { content: [{ type: "text", text: `Inbox file ${inbox_file_id} not found. Run poll_xero_inbox first.` }], isError: true };
      }
      const file = fileRows[0];

      const preview = {
        dry_run,
        statement_line: {
          id: stmt.statement_line_id,
          date: stmt.transaction_date instanceof Date
            ? stmt.transaction_date.toISOString().substring(0, 10)
            : String(stmt.transaction_date ?? "").substring(0, 10),
          amount: Number(stmt.amount),
          currency: stmt.bank_account_currency,
          payee: stmt.payee,
          reference: stmt.reference,
          already_reconciled: Boolean(stmt.is_reconciled),
        },
        inbox_file: {
          id: file.file_id,
          name: file.file_name,
          type: file.mime_type,
          size_bytes: file.size_bytes,
          uploaded: file.created_date_utc,
        },
      };

      if (dry_run) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...preview,
              would_do: [
                `Set bank_spend_orphans.status = 'received' for STATEMENT_LINE:${statement_line_id}`,
                `Set bank_spend_orphans.matched_file_id = '${inbox_file_id}'`,
                "Call apply_inbox_match next to create DRAFT ACCPAY bill from the inbox file"
              ]
            }, null, 2)
          }]
        };
      }

      // Find or create the orphan record
      const orphanRows = await query<any[]>(
        `SELECT id, status FROM bank_spend_orphans
         WHERE tenant_id = ? AND source_type = 'STATEMENT_LINE' AND xero_bank_tx_id = ?`,
        [tenant_id, statement_line_id]
      );

      if (!orphanRows[0]) {
        // Create orphan record if detection hasn't run yet
        await execute(
          `INSERT INTO bank_spend_orphans
             (tenant_id, source_type, xero_bank_tx_id, transaction_date, amount, currency,
              payee, status, matched_file_id)
           VALUES (?, 'STATEMENT_LINE', ?, ?, ?, ?, ?, 'received', ?)
           ON DUPLICATE KEY UPDATE
             status = 'received', matched_file_id = VALUES(matched_file_id)`,
          [
            tenant_id, statement_line_id,
            stmt.transaction_date, stmt.amount, stmt.bank_account_currency ?? "EUR",
            stmt.payee, inbox_file_id
          ]
        );
      } else if (orphanRows[0].status === "coded") {
        return { content: [{ type: "text", text: `Statement line ${statement_line_id} is already coded` }], isError: false };
      } else {
        await execute(
          `UPDATE bank_spend_orphans
           SET status = 'received', matched_file_id = ?
           WHERE tenant_id = ? AND source_type = 'STATEMENT_LINE' AND xero_bank_tx_id = ?`,
          [inbox_file_id, tenant_id, statement_line_id]
        );
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...preview,
            matched: true,
            next_step: "Run apply_inbox_match with this inbox file to create a DRAFT ACCPAY bill, then reconcile in Xero UI."
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `match_statement_line_to_inbox_file failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

// --- Startup ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await server.close();
    await closePool();
    await closePsPool();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await server.close();
    await closePool();
    await closePsPool();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("MCP server startup failed:", err);
  process.exit(1);
});
