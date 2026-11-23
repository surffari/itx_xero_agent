#!/usr/bin/env node
// One-shot runner for the poll_mailbox_inbox MCP tool logic, for use outside a live MCP session.
// Calls the same recordNewMailboxFiles() function the MCP tool uses — read-only against IMAP,
// only inserts metadata rows into mailbox_invoice_files (status='new'). Creates no Xero bills.
import "dotenv/config";
import { recordNewMailboxFiles } from "../src/email/imap-client.js";
import { closePool } from "../src/db/mysql.js";

const newFiles = await recordNewMailboxFiles();
console.log(JSON.stringify({ count: newFiles.length, newFiles }, null, 2));
await closePool();
process.exit(0);
