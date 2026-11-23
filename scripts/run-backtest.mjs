#!/usr/bin/env node
// One-shot backtest runner — not part of the main build
import "dotenv/config";
import { backtestInvoiceBuilder } from "../dist/apply/backtest.js";

const [, , start, end, limit] = process.argv;
const result = await backtestInvoiceBuilder(
  start ?? "2026-03-01",
  end   ?? "2026-03-31",
  limit ? Number(limit) : 20
);

console.log("\n=== Backtest result ===");
console.log(`Run period:          ${start ?? "2026-03-01"} → ${end ?? "2026-03-31"}`);
console.log(`Total matched:       ${result.total}`);
console.log(`Exact match:         ${result.exactMatch}  (${((result.exactMatch/result.total)*100).toFixed(1)}%)`);
console.log(`Amount match only:   ${result.amountMatch}`);
console.log(`Tax type mismatch:   ${result.taxTypeMismatch}`);
console.log(`Account code miss:   ${result.accountCodeMismatch}`);
console.log(`Flagged (GBP/unk):   ${result.flagged}`);
console.log(`Errors:              ${result.errors}`);
console.log("\n=== Mismatch samples ===");
for (const s of result.samples) {
  console.log(`  [${s.status}] ${s.reference}: ${s.detail ?? ""}`);
}
process.exit(0);
