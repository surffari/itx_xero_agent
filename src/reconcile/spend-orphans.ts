import { execute, query } from "../db/mysql.js";
import { enqueueDecision } from "../learn/rules.js";

// Account codes that are never "spend needing a receipt":
// own bank accounts, bank fees, inter-account mechanics
const EXEMPT_ACCOUNT_CODES = new Set([
  "100", "101", "102",   // Wise EUR / USD / GBP
  "110", "111", "112",   // Revolut EUR / USD / GBP
  "120",                  // Finsei
  "404",                  // Bank Fees
]);

// Debit card holders keyed by card last-4 digits
const CARD_MAP: Record<string, { name: string; key: "jani" | "mari" }> = {
  "7237": { name: "Jani Goran Saarinen", key: "jani" },
  "3826": { name: "Mari-Annina Oksala", key: "mari" },
  "3699": { name: "Mari-Annina Oksala", key: "mari" },
};

export interface SpendOrphan {
  xeroBankTxId: string;
  transactionDate: string;
  amount: number;
  currency: string;
  description: string | null;
  reference: string | null;
  contactName: string | null;
  bankAccountCode: string | null;
  cardholder: "jani" | "mari" | null;
  cardLast4: string | null;
}

export interface SpendOrphanSummary {
  detected: number;
  newlyFlagged: number;
  alreadyChasing: number;
  byCardholder: { jani: number; mari: number; unknown: number };
}

function detectCardholder(reference: string | null): { cardholder: "jani" | "mari" | null; cardLast4: string | null } {
  if (!reference) return { cardholder: null, cardLast4: null };

  const last4Match = reference.match(/Card last 4 digits:\s*([0-9*]+)/i);
  if (last4Match) {
    const rawDigits = last4Match[1].replace(/\D/g, "");
    const maskedTail = last4Match[1].match(/(\d{4})$/);
    const last4 = maskedTail?.[1] ?? (rawDigits.length >= 4 ? rawDigits.slice(-4) : last4Match[1]);
    const profile = CARD_MAP[last4] ?? (reference.toLowerCase().includes("revolut card payment")
      ? { name: "Mari-Annina Oksala", key: "mari" as const }
      : undefined);
    return {
      cardholder: profile?.key ?? null,
      cardLast4: last4,
    };
  }

  // Fallback: match on embedded cardholder name
  for (const [digits, profile] of Object.entries(CARD_MAP)) {
    if (reference.toLowerCase().includes(profile.name.toLowerCase())) {
      return { cardholder: profile.key, cardLast4: digits };
    }
  }

  return { cardholder: null, cardLast4: null };
}

function buildChaseQuestion(orphan: SpendOrphan): string {
  const dateStr = orphan.transactionDate;
  const amtStr = `${orphan.currency} ${Number(orphan.amount).toFixed(2)}`;
  const supplier = orphan.contactName ?? orphan.description ?? "unknown supplier";

  if (orphan.cardholder && orphan.cardLast4) {
    const cardholderName = CARD_MAP[orphan.cardLast4]?.name ?? orphan.cardholder;
    return (
      `Unmatched Wise card spend ${amtStr} at '${supplier}' on ${dateStr}. ` +
      `Cardholder: ${cardholderName} (card ...${orphan.cardLast4}). ` +
      `Please email the receipt to the Xero bills inbox so it can be matched and coded. ` +
      `Once received, run poll_xero_inbox then match_inbox_file_to_spend.`
    );
  }

  return (
    `Unmatched bank spend ${amtStr} to '${supplier}' on ${dateStr}. ` +
    `No ACCPAY bill found for this transaction (bank tx ID: ${orphan.xeroBankTxId}). ` +
    `Please email the supplier invoice to the Xero bills inbox so it can be matched and coded. ` +
    `Once received, run poll_xero_inbox then match_inbox_file_to_spend.`
  );
}

export async function detectSpendOrphans(
  tenantId: string,
  runId: number | null,
  opts: { lookbackDays: number }
): Promise<SpendOrphanSummary> {
  const rows = await query<any[]>(
    `SELECT
       ftl.source_id        AS xero_bank_tx_id,
       ftl.transaction_date,
       ABS(ftl.gross_amount) AS amount,
       ftl.currency_code    AS currency,
       ftl.description,
       ftl.reference,
       ftl.contact_name,
       ftl.bank_account_code
     FROM finance_transaction_lines ftl
     WHERE ftl.tenant_id = ?
       AND ftl.source_type = 'BANKTRANSACTION'
       AND ftl.transaction_subtype = 'SPEND_MONEY'
       AND ftl.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       AND (ftl.is_reconciled IS NULL OR ftl.is_reconciled = 0)
       AND (ftl.status IS NULL OR ftl.status NOT IN ('DELETED','VOIDED'))
       AND (ftl.account_code IS NULL OR ftl.account_code NOT IN (${[...EXEMPT_ACCOUNT_CODES].map(() => "?").join(",")}))
       AND ftl.source_id NOT IN (
         SELECT xero_bank_tx_id FROM bank_spend_orphans
         WHERE tenant_id = ? AND status IN ('coded','dismissed')
       )`,
    [tenantId, opts.lookbackDays, ...[...EXEMPT_ACCOUNT_CODES], tenantId]
  );

  const summary: SpendOrphanSummary = {
    detected: rows.length,
    newlyFlagged: 0,
    alreadyChasing: 0,
    byCardholder: { jani: 0, mari: 0, unknown: 0 },
  };

  for (const row of rows) {
    const { cardholder, cardLast4 } = detectCardholder(row.reference ?? row.description);
    const orphan: SpendOrphan = {
      xeroBankTxId: row.xero_bank_tx_id,
      transactionDate: String(row.transaction_date instanceof Date
        ? row.transaction_date.toISOString().substring(0, 10)
        : row.transaction_date).substring(0, 10),
      amount: Number(row.amount ?? 0),
      currency: row.currency ?? "EUR",
      description: row.description ?? null,
      reference: row.reference ?? null,
      contactName: row.contact_name ?? null,
      bankAccountCode: row.bank_account_code ?? null,
      cardholder,
      cardLast4,
    };

    // Upsert — don't downgrade status on re-run
    await execute(
      `INSERT INTO bank_spend_orphans
         (tenant_id, run_id, xero_bank_tx_id, transaction_date, amount, currency,
          description, reference, contact_name, bank_account_code, cardholder, card_last4, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'flagged')
       ON DUPLICATE KEY UPDATE
         run_id       = IF(status = 'flagged', VALUES(run_id), run_id),
         contact_name = VALUES(contact_name),
         cardholder   = IF(cardholder IS NULL, VALUES(cardholder), cardholder),
         card_last4   = IF(card_last4 IS NULL, VALUES(card_last4), card_last4)`,
      [
        tenantId, runId, orphan.xeroBankTxId, orphan.transactionDate,
        orphan.amount, orphan.currency, orphan.description, orphan.reference,
        orphan.contactName, orphan.bankAccountCode, orphan.cardholder, orphan.cardLast4,
      ]
    );

    // Check current status after upsert
    const existing = await query<any[]>(
      `SELECT status FROM bank_spend_orphans WHERE tenant_id = ? AND xero_bank_tx_id = ?`,
      [tenantId, orphan.xeroBankTxId]
    );
    const currentStatus = existing[0]?.status ?? "flagged";

    if (currentStatus === "flagged") {
      // Enqueue chase question and advance to 'chasing'
      await enqueueDecision({
        queueKey: `SPEND_ORPHAN:${orphan.xeroBankTxId}`,
        domain: "OTHER",
        transactionType: "BANK_SPEND",
        contactName: orphan.contactName ?? undefined,
        runId: runId ?? undefined,
        evidence: {
          xeroBankTxId: orphan.xeroBankTxId,
          transactionDate: orphan.transactionDate,
          amount: orphan.amount,
          currency: orphan.currency,
          description: orphan.description,
          reference: orphan.reference,
          contactName: orphan.contactName,
          bankAccountCode: orphan.bankAccountCode,
          cardholder: orphan.cardholder,
          cardLast4: orphan.cardLast4,
        },
        question: buildChaseQuestion(orphan),
      });

      await execute(
        `UPDATE bank_spend_orphans SET status = 'chasing' WHERE tenant_id = ? AND xero_bank_tx_id = ? AND status = 'flagged'`,
        [tenantId, orphan.xeroBankTxId]
      );
      summary.newlyFlagged++;
    } else {
      summary.alreadyChasing++;
    }

    if (orphan.cardholder === "jani") summary.byCardholder.jani++;
    else if (orphan.cardholder === "mari") summary.byCardholder.mari++;
    else summary.byCardholder.unknown++;
  }

  return summary;
}
