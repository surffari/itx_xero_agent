#!/usr/bin/env node
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";

const counts = await query(`SELECT bills_status, COUNT(*) as n FROM mailbox_invoice_files GROUP BY bills_status ORDER BY n DESC`);
console.log("=== Status breakdown ===");
for (const r of counts) console.log(`${r.bills_status}: ${r.n}`);

const total = await query(`SELECT COUNT(*) as n FROM mailbox_invoice_files`);
console.log(`\nTotal: ${total[0].n}`);

const latest = await query(`SELECT id, attachment_filename, extracted_date, bills_status, created_at FROM mailbox_invoice_files ORDER BY id DESC LIMIT 8`);
console.log("\n=== Most recent 8 by id ===");
for (const r of latest) console.log(`#${r.id} [${r.bills_status}] ${r.attachment_filename} created:${r.created_at}`);

await closePool();
