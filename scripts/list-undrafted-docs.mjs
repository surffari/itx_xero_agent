#!/usr/bin/env node
// Read-only: mailbox documents not yet linked to a Xero bill, grouped by bills_status.
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";

const ymd = (x) => (x ? new Date(x).toISOString().slice(0, 10) : "-");
const rows = await query(
  `SELECT id, attachment_filename f, from_address, received_at, status, bills_status, matched_invoice_id, LEFT(bills_status_reason, 150) reason
   FROM mailbox_invoice_files
   WHERE matched_invoice_id IS NULL AND bills_status IN ('incoming','ready_for_xero','needs_review')
   ORDER BY bills_status, id`, []
);
let cur = "";
for (const r of rows) {
  if (r.bills_status !== cur) { cur = r.bills_status; console.log(`\n## ${cur}`); }
  console.log(`  #${r.id} ${ymd(r.received_at)} ${String(r.f).slice(0, 52).padEnd(52)} ${String(r.from_address ?? "").slice(0, 28)}${r.bills_status === "needs_review" ? "\n       " + (r.reason ?? "") : ""}`);
}
console.log("\ntotal:", rows.length);
await closePool();
process.exit(0);
