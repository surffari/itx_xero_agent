#!/usr/bin/env node
// Read-only: download specific mailbox attachments (IMAP EXAMINE) to the session scratchpad. Usage: node ... fetch-mailbox-docs.mjs 12 50 31 33
import "dotenv/config";
import fs from "node:fs";
import { query, closePool } from "../src/db/mysql.js";
import { MailboxClient } from "../src/email/imap-client.js";

const ids = process.argv.slice(2).map(Number).filter(Boolean);
const dir = "/tmp/claude-1007/-opt-projects-gopure-bills-management/b096a96b-90b0-4df1-bdef-4255b9d9c440/scratchpad";
const mc = new MailboxClient();
for (const id of ids) {
  const [f] = await query(`SELECT id, uid, attachment_filename FROM mailbox_invoice_files WHERE id=?`, [id]);
  if (!f) { console.log("no such id", id); continue; }
  const buf = await mc.downloadAttachment(Number(f.uid), f.attachment_filename);
  const p = `${dir}/doc-${id}.pdf`;
  fs.writeFileSync(p, buf);
  console.log("saved", p, f.attachment_filename, buf.length);
}
await closePool();
process.exit(0);
