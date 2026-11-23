#!/usr/bin/env node
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";

const incoming = await query(`SELECT id, attachment_filename, extracted_date, created_at, updated_at FROM mailbox_invoice_files WHERE bills_status = 'incoming' ORDER BY id`);
console.log(`=== ${incoming.length} incoming docs ===`);
for (const r of incoming) console.log(`#${r.id} ${r.attachment_filename} | created:${r.created_at} updated:${r.updated_at}`);
await closePool();
