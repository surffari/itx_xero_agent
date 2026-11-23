#!/usr/bin/env node
// Read-only: download PDF bytes for the mailbox_invoice_files ids passed on argv
// to /tmp/mailbox-attachments so they can be inspected before any Xero write.
// Does NOT touch status, does NOT call Xero. IMAP opened read-only.
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MailboxClient } from "../src/email/imap-client.ts";
import { query, closePool } from "../src/db/mysql.ts";

const ids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
if (!ids.length) { console.error("usage: node download-new-attachments-tmp.mjs <id...>"); process.exit(1); }

const OUT_DIR = "/tmp/mailbox-attachments";
const rows = await query(
  `SELECT id, uid, attachment_filename FROM mailbox_invoice_files WHERE id IN (${ids.map(() => "?").join(",")})`,
  ids
);
await mkdir(OUT_DIR, { recursive: true });
const client = new MailboxClient();
const results = [];
for (const row of rows) {
  try {
    const buffer = await client.downloadAttachment(Number(row.uid), row.attachment_filename);
    const safeName = `${row.id}__${row.attachment_filename}`.replace(/[/\\]/g, "_");
    const outPath = path.join(OUT_DIR, safeName);
    await writeFile(outPath, buffer);
    results.push({ id: row.id, filename: row.attachment_filename, saved_to: outPath, bytes: buffer.length });
  } catch (err) {
    results.push({ id: row.id, filename: row.attachment_filename, error: String(err) });
  }
}
console.log(JSON.stringify({ requested: ids.length, found: rows.length, results }, null, 2));
await closePool();
process.exit(0);
