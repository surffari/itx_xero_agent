#!/usr/bin/env node
import { Command } from "commander";
import { closePool } from "./db/mysql.js";
import { runMigrations } from "./db/migrate.js";
import { runXeroAuthFlow } from "./xero/auth.js";
import { isoDateDaysAgo, todayIsoDate } from "./lib/dates.js";
import { config } from "./config.js";
import {
  syncBankTransfers,
  syncIncremental,
  syncReferenceData,
  syncReports,
  syncTransactions
} from "./xero/sync.js";

const program = new Command();

program
  .name("intactix-agent")
  .description("Intactix B.V. accounting agent CLI")
  .version("0.1.0");

program
  .command("auth")
  .description("Run local Xero OAuth flow and save XERO_REFRESH_TOKEN to .env")
  .option("--print-url-only", "only print the authorization URL")
  .option("--manual", "paste the redirect URL manually instead of running a local callback server")
  .option("--redirect-uri <uri>", "override XERO_REDIRECT_URI for this auth flow")
  .option("--timeout <seconds>", "seconds to wait for the OAuth callback", "300")
  .action(wrap(async (opts) => {
    await runXeroAuthFlow({
      printUrlOnly: Boolean(opts.printUrlOnly),
      manual: Boolean(opts.manual),
      redirectUri: opts.redirectUri,
      timeoutSeconds: Number(opts.timeout)
    });
  }));

program
  .command("migrate")
  .description("Apply SQL migrations to intactix_agent_db")
  .action(wrap(async () => {
    await runMigrations();
  }));

const sync = program.command("sync").description("Sync read-only Xero data into intactix_agent_db");

sync
  .command("reference")
  .description("Sync organisation, accounts, tax rates, contacts, and tracking categories")
  .action(wrap(async () => {
    await syncReferenceData();
  }));

sync
  .command("transactions")
  .description("Sync invoices/bills, bank transactions, payments, credit notes, and manual journals")
  .requiredOption("--start <YYYY-MM-DD>", "start date")
  .requiredOption("--end <YYYY-MM-DD>", "end date")
  .action(wrap(async (opts) => {
    await syncTransactions(opts.start, opts.end);
  }));

sync
  .command("bank-transfers")
  .description("Sync bank transfers for a date range")
  .requiredOption("--start <YYYY-MM-DD>", "start date")
  .requiredOption("--end <YYYY-MM-DD>", "end date")
  .action(wrap(async (opts) => {
    await syncBankTransfers(opts.start, opts.end);
  }));

sync
  .command("reports")
  .description("Sync P&L, Balance Sheet, and Trial Balance reports")
  .requiredOption("--start <YYYY-MM-DD>", "start date")
  .requiredOption("--end <YYYY-MM-DD>", "end date")
  .action(wrap(async (opts) => {
    await syncReports(opts.start, opts.end);
  }));

sync
  .command("incremental")
  .description(`Sync reference data + last ${config.DEFAULT_SYNC_LOOKBACK_DAYS} days of transactions`)
  .action(wrap(async () => {
    await syncIncremental();
  }));

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function wrap(fn: (opts: any) => Promise<void>) {
  return async (opts: any) => {
    try {
      await fn(opts);
    } finally {
      await closePool();
    }
  };
}
