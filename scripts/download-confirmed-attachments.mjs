#!/usr/bin/env node
// Read-only: downloads the PDF bytes for a fixed list of confirmed-candidate
// mailbox_invoice_files ids to local disk so their contents can be inspected
// before any Xero bill is created. Does NOT touch mailbox_invoice_files.status,
// does NOT call Xero, does NOT write to xero_write_log. IMAP mailbox stays
// opened read-only (see MailboxClient).
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MailboxClient } from "../src/email/imap-client.js";
import { query, closePool } from "../src/db/mysql.js";

// Confirmed invoice candidates only — excludes statements/settlements, the
// FURS notice, and uncertain ids 6 and 31. One id per duplicate group
// (representative copy) plus each distinct invoice.
const CONFIRMED_IDS = [22, 23, 4, 15, 19, 28, 7, 13, 17, 26, 8, 21, 25, 11, 9, 24];

const OUT_DIR = "/tmp/mailbox-attachments";

const rows = await query(
  `SELECT id, uid, attachment_filename FROM mailbox_invoice_files WHERE id IN (${CONFIRMED_IDS.map(() => "?").join(",")})`,
  CONFIRMED_IDS
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

console.log(JSON.stringify({ requested: CONFIRMED_IDS.length, found: rows.length, results }, null, 2));
await closePool();
process.exit(0);
