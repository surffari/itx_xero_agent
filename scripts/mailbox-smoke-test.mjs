#!/usr/bin/env node
// Read-only IMAP connectivity smoke test for the supplier invoice mailbox (xero@intactix.io).
// Verifies MAILBOX_IMAP_* env vars are present (never prints the password value) and opens
// INBOX in read-only (EXAMINE) mode to confirm the connection + auth work. Does not touch
// MySQL, does not fetch/parse any messages, does not mark/move/delete anything.
import "dotenv/config";
import { ImapFlow } from "imapflow";

const host = process.env.MAILBOX_IMAP_HOST;
const port = Number(process.env.MAILBOX_IMAP_PORT ?? 993);
const secure = (process.env.MAILBOX_IMAP_SECURE ?? "true") === "true";
const user = process.env.MAILBOX_IMAP_USER;
const password = process.env.MAILBOX_IMAP_PASSWORD;

console.log("=== Mailbox config presence check (password value never printed) ===");
console.log(`MAILBOX_IMAP_HOST:     ${host ? `set (${host})` : "MISSING"}`);
console.log(`MAILBOX_IMAP_PORT:     ${port}`);
console.log(`MAILBOX_IMAP_SECURE:   ${secure}`);
console.log(`MAILBOX_IMAP_USER:     ${user ? `set (${user})` : "MISSING"}`);
console.log(`MAILBOX_IMAP_PASSWORD: ${password ? `set (${password.length} chars)` : "MISSING"}`);

if (!host || !user || !password) {
  console.error("\nMissing required mailbox env vars in .env — aborting before attempting a connection.");
  process.exit(1);
}

console.log(`\n=== Connecting to ${host}:${port} (secure=${secure}) ===`);
const client = new ImapFlow({ host, port, secure, auth: { user, pass: password }, logger: false });

try {
  await client.connect();
  console.log("Connected and authenticated OK.");

  const lock = await client.getMailboxLock("INBOX", { readOnly: true });
  try {
    const mailbox = client.mailbox;
    console.log("\n=== INBOX opened read-only (EXAMINE mode) ===");
    console.log(`Message count: ${mailbox.exists}`);
    console.log(`UIDVALIDITY:   ${mailbox.uidValidity}`);
    console.log(`UIDNEXT:       ${mailbox.uidNext}`);
  } finally {
    lock.release();
  }

  await client.logout();
  console.log("\nLogged out cleanly. Smoke test PASSED.");
  process.exit(0);
} catch (err) {
  console.error("\nSmoke test FAILED:", err?.message ?? err);
  process.exit(1);
}
