import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { requireMailboxConfig } from "../config.js";
import { execute, query } from "../db/mysql.js";

const MAILBOX = "INBOX";

export interface DiscoveredAttachment {
  uidValidity: number;
  uid: number;
  messageId: string | null;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: Date | null;
  filename: string;
  sizeBytes: number;
}

/**
 * Read-only IMAP client for the supplier invoice mailbox (xero@intactix.io).
 * Never sets \Seen, never moves or deletes mail — the mailbox is opened in
 * EXAMINE (read-only) mode. Dedup/progress state lives in MySQL
 * (mailbox_poll_state / mailbox_invoice_files), not in IMAP flags.
 */
export class MailboxClient {
  private async connect(): Promise<ImapFlow> {
    const creds = requireMailboxConfig();
    const client = new ImapFlow({
      host: creds.host,
      port: creds.port,
      secure: creds.secure,
      auth: { user: creds.user, pass: creds.password },
      logger: false,
    });
    await client.connect();
    return client;
  }

  /**
   * Fetch messages with a UID greater than the last processed UID for this
   * mailbox, extract PDF attachments, and advance mailbox_poll_state.
   * Returns metadata only — attachment bytes are fetched on demand via
   * downloadAttachment() so nothing large sits in the DB or in memory here.
   */
  async pollNewInvoiceEmails(): Promise<DiscoveredAttachment[]> {
    const client = await this.connect();
    const discovered: DiscoveredAttachment[] = [];
    try {
      const lock = await client.getMailboxLock(MAILBOX, { readOnly: true });
      try {
        const mailboxInfo = client.mailbox;
        if (!mailboxInfo || typeof mailboxInfo === "boolean") {
          throw new Error("Could not open mailbox INBOX");
        }
        const uidValidity = Number(mailboxInfo.uidValidity);
        const uidNext = Number(mailboxInfo.uidNext);

        const stateRows = await query<any[]>(
          `SELECT uid_validity, last_uid FROM mailbox_poll_state WHERE mailbox = ?`,
          [MAILBOX]
        );
        let lastUid = 0;
        if (stateRows[0] && Number(stateRows[0].uid_validity) === uidValidity) {
          lastUid = Number(stateRows[0].last_uid);
        }
        // If UIDVALIDITY changed, the server renumbered UIDs — start over from 0
        // for this validity window rather than risk skipping mail.

        let maxUidSeen = lastUid;

        if (uidNext > lastUid + 1) {
          for await (const message of client.fetch(
            `${lastUid + 1}:*`,
            { uid: true, source: true, envelope: true },
            { uid: true }
          )) {
            if (message.uid <= lastUid) continue;
            maxUidSeen = Math.max(maxUidSeen, message.uid);
            if (!message.source) continue;

            const parsed = await simpleParser(message.source, { skipHtmlToText: true });
            for (const attachment of parsed.attachments) {
              if (!isPdfAttachment(attachment)) continue;
              discovered.push({
                uidValidity,
                uid: message.uid,
                messageId: parsed.messageId ?? null,
                fromAddress: parsed.from?.text ?? null,
                subject: parsed.subject ?? null,
                receivedAt: parsed.date ?? null,
                filename: attachment.filename || `attachment-${message.uid}.pdf`,
                sizeBytes: attachment.size ?? attachment.content.length,
              });
            }
          }
        }

        await execute(
          `INSERT INTO mailbox_poll_state (mailbox, uid_validity, last_uid, last_polled_at)
           VALUES (?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE uid_validity = VALUES(uid_validity), last_uid = VALUES(last_uid), last_polled_at = NOW()`,
          [MAILBOX, uidValidity, maxUidSeen]
        );
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
    return discovered;
  }

  /**
   * Re-fetch a specific message by UID and return the bytes of one named
   * attachment. Called on demand rather than caching bytes from the poll step.
   */
  async downloadAttachment(uid: number, filename: string): Promise<Buffer> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock(MAILBOX, { readOnly: true });
      try {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message || !message.source) {
          throw new Error(`Mailbox message UID ${uid} not found`);
        }
        const parsed = await simpleParser(message.source);
        const attachment = parsed.attachments.find((a) => (a.filename || "") === filename);
        if (!attachment) {
          throw new Error(`Attachment "${filename}" not found on mailbox message UID ${uid}`);
        }
        return attachment.content as Buffer;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }
}

function isPdfAttachment(attachment: { contentType?: string; filename?: string | false }): boolean {
  const type = (attachment.contentType || "").toLowerCase();
  const name = (attachment.filename || "").toLowerCase();
  return type.includes("pdf") || name.endsWith(".pdf");
}

export interface RecordedMailboxFile {
  uid: number;
  filename: string;
  from: string | null;
  subject: string | null;
  receivedAt: string | null;
}

/**
 * Poll the mailbox and insert any newly discovered PDF attachments into
 * mailbox_invoice_files (status='new'). Shared by the poll_mailbox_inbox MCP
 * tool and one-off scripts so both stay in sync with the same dedup logic.
 */
export async function recordNewMailboxFiles(client: MailboxClient = new MailboxClient()): Promise<RecordedMailboxFile[]> {
  const discovered = await client.pollNewInvoiceEmails();
  const newFiles: RecordedMailboxFile[] = [];
  for (const att of discovered) {
    const receivedAt = att.receivedAt
      ? att.receivedAt.toISOString().replace("T", " ").substring(0, 19)
      : null;
    const result = await execute(
      `INSERT IGNORE INTO mailbox_invoice_files
         (mailbox, uid_validity, uid, message_id, from_address, subject, received_at, attachment_filename, attachment_size, status)
       VALUES ('INBOX', ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
      [att.uidValidity, att.uid, att.messageId, att.fromAddress, att.subject, receivedAt, att.filename, att.sizeBytes]
    );
    if (result.affectedRows > 0) {
      newFiles.push({ uid: att.uid, filename: att.filename, from: att.fromAddress, subject: att.subject, receivedAt });
    }
  }
  return newFiles;
}
