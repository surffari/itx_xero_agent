#!/usr/bin/env node
// Read-only listing of mailbox_invoice_files for manual review before any Xero bill is created.
// No writes, no status changes, no Xero calls.
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";

const rows = await query(
  `SELECT id, attachment_filename, from_address, subject, received_at, attachment_size, status
   FROM mailbox_invoice_files
   ORDER BY received_at ASC, id ASC`
);

console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
await closePool();
process.exit(0);
