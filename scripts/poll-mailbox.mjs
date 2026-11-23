#!/usr/bin/env node
// Same as the poll_mailbox_inbox MCP tool: read-only IMAP, records new PDF attachments in mailbox_invoice_files.
import "dotenv/config";
import { recordNewMailboxFiles, MailboxClient } from "../src/email/imap-client.js";
import { closePool } from "../src/db/mysql.js";

const files = await recordNewMailboxFiles(new MailboxClient());
console.log(`new attachments: ${files.length}`);
for (const f of files) console.log(JSON.stringify(f));
await closePool();
process.exit(0);
