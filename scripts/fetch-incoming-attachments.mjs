#!/usr/bin/env node
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { MailboxClient } from "../src/email/imap-client.js";
import { writeFile, mkdir } from "node:fs/promises";

const OUT_DIR = "/opt/projects/openclaw/gopure/intactix/scratch-incoming-review";
await mkdir(OUT_DIR, { recursive: true });

const rows = await query(`
  SELECT id, uid, attachment_filename, from_address, subject, received_at, extracted_supplier, extracted_amount, extracted_currency, extracted_date
  FROM mailbox_invoice_files WHERE bills_status = 'incoming' ORDER BY id
`);

const client = new MailboxClient();
const meta = [];
for (const r of rows) {
  console.log(`Fetching #${r.id} uid=${r.uid} "${r.attachment_filename}"...`);
  try {
    const buf = await client.downloadAttachment(r.uid, r.attachment_filename);
    const safeName = `${r.id}_${r.attachment_filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await writeFile(`${OUT_DIR}/${safeName}`, buf);
    meta.push({ ...r, savedAs: safeName, ok: true });
    console.log(`  -> saved ${safeName} (${buf.length} bytes)`);
  } catch (err) {
    meta.push({ ...r, ok: false, error: err instanceof Error ? err.message : String(err) });
    console.log(`  -> FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}
await writeFile(`${OUT_DIR}/_meta.json`, JSON.stringify(meta, null, 2));
console.log(`\nDone. ${meta.filter(m => m.ok).length}/${meta.length} downloaded to ${OUT_DIR}`);
await closePool();
