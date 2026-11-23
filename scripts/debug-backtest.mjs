#!/usr/bin/env node
import "dotenv/config";
import { loadPsOrderForInvoice, buildInvoiceFromPsOrder } from "../dist/xero/invoice-builder.js";
import { query } from "../dist/db/mysql.js";

const rows = await query(
  `SELECT xero_reference, xero_total, ps_currency_id, ps_ship_country
   FROM reconciliation_results
   WHERE run_id = 5 AND match_status IN ('MATCHED', 'REF_MATCH_INV_DIFF')
     AND ps_order_id IS NOT NULL AND ps_currency_id = 2
   LIMIT 10`,
  []
);

console.log(`EUR matched (sample 10):`);
let errorCount = 0;
for (const row of rows) {
  try {
    const ps = await loadPsOrderForInvoice(row.xero_reference);
    if (!ps) {
      console.log(`  NULL: ${row.xero_reference}`);
      errorCount++;
      continue;
    }
    const result = await buildInvoiceFromPsOrder(ps);
    if (result.status === "flagged") {
      console.log(`  FLAGGED: ${row.xero_reference} — ${result.flag}`);
      continue;
    }
    const lines = result.payload.LineItems;
    const prod = lines.find(l => l.Description === "Products");
    const ship = lines.find(l => l.Description === "Shipping");
    const built = (prod?.UnitAmount ?? 0) + (ship?.UnitAmount ?? 0);
    const actual = Number(row.xero_total);
    const diff = Math.abs(built - actual);
    console.log(`  OK: ${row.xero_reference} built=${built} actual=${actual} diff=${diff.toFixed(4)} country=${row.ps_ship_country}`);
  } catch (e) {
    console.log(`  ERROR: ${row.xero_reference} — ${e.message}`);
    errorCount++;
  }
}
console.log(`\nErrors: ${errorCount}`);
process.exit(0);
