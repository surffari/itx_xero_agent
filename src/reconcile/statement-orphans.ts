import { execute, query } from "../db/mysql.js";
import { enqueueDecision } from "../learn/rules.js";

// Payee/reference/notes patterns that don't require a supporting document.
// Covers bank fees, card fees, FX conversion fees, and intra-own-account transfers.
const NO_DOC_PATTERNS: RegExp[] = [
  /\bbank fee\b/i,
  /\bservice fee\b/i,
  /\bservice charge\b/i,
  /\bannual fee\b/i,
  /\bmonthly fee\b/i,
  /\bcard fee\b/i,
  /\btransaction fee\b/i,
  /\bfx fee\b/i,
  /\bcurrency conversion\b/i,
  /\bconversion fee\b/i,
  /\batm.*fee\b/i,
  /\binterest charge\b/i,
  /\boverdraft fee\b/i,
  /\bwise.*fee\b/i,
  /\brevolut.*fee\b/i,
  /\bfinsei.*fee\b/i,
  /\binternal\b.*\bto intactix b\.?v\.?\b/i,
  /\brev to wis\b/i,
];

// Debit card holders (same as spend-orphans.ts — keep in sync)
const CARD_MAP: Record<string, { name: string; key: "jani" | "mari" }> = {
  "7237": { name: "Jani Goran Saarinen", key: "jani" },
  "3826": { name: "Mari-Annina Oksala", key: "mari" },
  "3699": { name: "Mari-Annina Oksala", key: "mari" },
};

export interface StatementOrphan {
  statementLineId: string;
  transactionDate: string;
  amount: number;
  currency: string;
  payee: string | null;
  reference: string | null;
  notes: string | null;
  bankAccountId: string;
  bankAccountName: string | null;
  bankAccountCurrency: string | null;
  cardholder: "jani" | "mari" | null;
  cardLast4: string | null;
  classification: "no_doc_required" | "document_missing";
}

export interface StatementOrphanSummary {
  unreconciled: number;
  noDocRequired: number;
  documentMissing: number;
  alreadyTracked: number;
  autoClosed: number;
  byCardholder: { jani: number; mari: number; unknown: number };
}

function isNoDocRequired(payee: string | null, reference: string | null, notes: string | null): boolean {
  const text = [payee, reference, notes].filter(Boolean).join(" ");
  if (!text) return false;
  return NO_DOC_PATTERNS.some((p) => p.test(text));
}

function detectCardholder(
  reference: string | null,
  notes: string | null
): { cardholder: "jani" | "mari" | null; cardLast4: string | null } {
  const combined = [reference, notes].filter(Boolean).join(" ");
  if (!combined) return { cardholder: null, cardLast4: null };

  const last4Match = combined.match(/Card last 4 digits:\s*([0-9*]+)/i);
  if (last4Match) {
    const rawDigits = last4Match[1].replace(/\D/g, "");
    const maskedTail = last4Match[1].match(/(\d{4})$/);
    const last4 = maskedTail?.[1] ?? (rawDigits.length >= 4 ? rawDigits.slice(-4) : last4Match[1]);
    const profile = CARD_MAP[last4] ?? (combined.toLowerCase().includes("revolut card payment")
      ? { name: "Mari-Annina Oksala", key: "mari" as const }
      : undefined);
    return { cardholder: profile?.key ?? null, cardLast4: last4 };
  }

  for (const [digits, profile] of Object.entries(CARD_MAP)) {
    if (combined.toLowerCase().includes(profile.name.toLowerCase())) {
      return { cardholder: profile.key, cardLast4: digits };
    }
  }

  return { cardholder: null, cardLast4: null };
}

function buildChaseQuestion(orphan: StatementOrphan): string {
  const dateStr = orphan.transactionDate;
  const amtStr = `${orphan.currency} ${Number(orphan.amount).toFixed(2)}`;
  const supplier = orphan.payee ?? orphan.reference ?? "unknown supplier";

  if (orphan.cardholder && orphan.cardLast4) {
    const cardholderName = CARD_MAP[orphan.cardLast4]?.name ?? orphan.cardholder;
    return (
      `Unreconciled card spend ${amtStr} at '${supplier}' on ${dateStr}. ` +
      `Cardholder: ${cardholderName} (card ...${orphan.cardLast4}). ` +
      `No matching bill or receipt found in Xero. ` +
      `Please email the receipt to the Xero bills inbox. ` +
      `Once received, run poll_xero_inbox then match_statement_line_to_inbox_file.`
    );
  }

  return (
    `Unreconciled bank debit ${amtStr} at '${supplier}' on ${dateStr}. ` +
    `No matching ACCPAY bill found. Statement line ID: ${orphan.statementLineId}. ` +
    `Please email the supplier invoice to the Xero bills inbox. ` +
    `Once received, run poll_xero_inbox then match_statement_line_to_inbox_file.`
  );
}

async function closeProviderLinesCoveredByXeroSpend(tenantId: string, lookbackDays: number): Promise<number> {
  // Wise card activity is gross, while Xero can hold net supplier spend plus a
  // separate FEE-CARD:<activityId> line. When both Xero lines are reconciled,
  // the provider gross row should not remain in the missing-support queue.
  await execute(
    `UPDATE xero_bank_statement_lines sl
     SET sl.is_reconciled = 1,
         sl.synced_at = NOW()
     WHERE sl.tenant_id = ?
       AND sl.import_source = 'wise'
       AND sl.type = 'Debit'
       AND sl.is_reconciled = 0
       AND sl.is_deleted = 0
       AND sl.is_duplicate = 0
       AND sl.statement_line_id LIKE 'CARD:%'
       AND (sl.transaction_date IS NULL OR sl.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY))
       AND EXISTS (
         SELECT 1
         FROM xero_raw_objects net
         JOIN xero_raw_objects fee
           ON fee.tenant_id = net.tenant_id
          AND fee.object_type = 'BANKTRANSACTION'
          AND JSON_UNQUOTE(JSON_EXTRACT(fee.payload, '$.Type')) = 'SPEND'
          AND JSON_UNQUOTE(JSON_EXTRACT(fee.payload, '$.Status')) = 'AUTHORISED'
          AND JSON_UNQUOTE(JSON_EXTRACT(fee.payload, '$.IsReconciled')) = 'true'
          AND JSON_UNQUOTE(JSON_EXTRACT(fee.payload, '$.BankAccount.AccountID')) = sl.bank_account_id
          AND DATE(JSON_UNQUOTE(JSON_EXTRACT(fee.payload, '$.DateString'))) = sl.transaction_date
          AND JSON_UNQUOTE(JSON_EXTRACT(fee.payload, '$.Reference')) =
              CONCAT('FEE-', REPLACE(sl.statement_line_id, ':', '-'))
         WHERE net.tenant_id = sl.tenant_id
           AND net.object_type = 'BANKTRANSACTION'
           AND JSON_UNQUOTE(JSON_EXTRACT(net.payload, '$.Type')) = 'SPEND'
           AND JSON_UNQUOTE(JSON_EXTRACT(net.payload, '$.Status')) = 'AUTHORISED'
           AND JSON_UNQUOTE(JSON_EXTRACT(net.payload, '$.IsReconciled')) = 'true'
           AND JSON_UNQUOTE(JSON_EXTRACT(net.payload, '$.BankAccount.AccountID')) = sl.bank_account_id
           AND DATE(JSON_UNQUOTE(JSON_EXTRACT(net.payload, '$.DateString'))) = sl.transaction_date
           AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(net.payload, '$.Reference')), '') <>
               CONCAT('FEE-', REPLACE(sl.statement_line_id, ':', '-'))
           AND ABS(
             CAST(JSON_EXTRACT(net.payload, '$.Total') AS DECIMAL(18,4)) +
             CAST(JSON_EXTRACT(fee.payload, '$.Total') AS DECIMAL(18,4)) -
             sl.amount
           ) < 0.02
       )`,
    [tenantId, lookbackDays]
  );

  const result = await execute(
    `UPDATE bank_spend_orphans bso
     JOIN xero_bank_statement_lines sl
       ON sl.tenant_id = bso.tenant_id
      AND sl.statement_line_id = bso.xero_bank_tx_id
     SET bso.status = 'coded',
         bso.notes = 'Auto-closed: provider card line is covered by reconciled Xero supplier spend plus separate card fee'
     WHERE bso.tenant_id = ?
       AND bso.source_type = 'STATEMENT_LINE'
       AND bso.status IN ('flagged', 'chasing')
       AND sl.is_reconciled = 1
       AND (sl.transaction_date IS NULL OR sl.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY))`,
    [tenantId, lookbackDays]
  );

  await execute(
    `UPDATE decision_queue dq
     JOIN bank_spend_orphans bso
       ON dq.queue_key = CONCAT('STMT_ORPHAN:', bso.xero_bank_tx_id)
     SET dq.status = 'dismissed',
         dq.answer = 'Auto-closed: provider card line is covered by reconciled Xero supplier spend plus separate card fee',
         dq.answered_by = 'agent',
         dq.answered_at = NOW()
     WHERE bso.tenant_id = ?
       AND bso.source_type = 'STATEMENT_LINE'
       AND bso.status = 'coded'
       AND dq.status = 'open'`,
    [tenantId]
  );

  return Number((result as any).affectedRows ?? 0);
}

export async function detectStatementOrphans(
  tenantId: string,
  runId: number | null,
  opts: { lookbackDays: number }
): Promise<StatementOrphanSummary> {
  const autoClosed = await closeProviderLinesCoveredByXeroSpend(tenantId, opts.lookbackDays);

  const rows = await query<any[]>(
    `SELECT
       sl.statement_line_id,
       sl.transaction_date,
       sl.amount,
       sl.bank_account_currency AS currency,
       sl.payee,
       sl.reference,
       sl.notes,
       sl.bank_account_id,
       sl.bank_account_name,
       sl.bank_account_currency
     FROM xero_bank_statement_lines sl
     WHERE sl.tenant_id = ?
       AND sl.type = 'Debit'
       AND sl.is_reconciled = 0
       AND sl.is_deleted = 0
       AND sl.is_duplicate = 0
       AND (sl.transaction_date IS NULL OR sl.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY))
       AND sl.statement_line_id NOT IN (
         SELECT xero_bank_tx_id FROM bank_spend_orphans
         WHERE tenant_id = ? AND source_type = 'STATEMENT_LINE'
           AND status IN ('coded', 'dismissed')
       )
     ORDER BY sl.transaction_date DESC`,
    [tenantId, opts.lookbackDays, tenantId]
  );

  const summary: StatementOrphanSummary = {
    unreconciled: rows.length,
    noDocRequired: 0,
    documentMissing: 0,
    alreadyTracked: 0,
    autoClosed,
    byCardholder: { jani: 0, mari: 0, unknown: 0 },
  };

  for (const row of rows) {
    const txDate = String(
      row.transaction_date instanceof Date
        ? row.transaction_date.toISOString().substring(0, 10)
        : row.transaction_date ?? ""
    ).substring(0, 10);

    const { cardholder, cardLast4 } = detectCardholder(row.reference ?? null, row.notes ?? null);
    const noDoc = isNoDocRequired(row.payee ?? null, row.reference ?? null, row.notes ?? null);

    const orphan: StatementOrphan = {
      statementLineId: row.statement_line_id,
      transactionDate: txDate,
      amount: Number(row.amount ?? 0),
      currency: row.currency ?? row.bank_account_currency ?? "EUR",
      payee: row.payee ?? null,
      reference: row.reference ?? null,
      notes: row.notes ?? null,
      bankAccountId: row.bank_account_id,
      bankAccountName: row.bank_account_name ?? null,
      bankAccountCurrency: row.bank_account_currency ?? null,
      cardholder,
      cardLast4,
      classification: noDoc ? "no_doc_required" : "document_missing",
    };

    // Auto-dismiss no-doc lines; flag others as chasing
    const insertStatus = noDoc ? "dismissed" : "flagged";
    const insertNotes = noDoc
      ? "Auto-classified: bank/card/FX fee — no supporting document required"
      : null;

    await execute(
      `INSERT INTO bank_spend_orphans
         (tenant_id, source_type, run_id, xero_bank_tx_id, transaction_date, amount, currency,
          description, reference, payee, contact_name, bank_account_code,
          cardholder, card_last4, status, notes)
       VALUES (?, 'STATEMENT_LINE', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         run_id     = IF(status = 'flagged', VALUES(run_id), run_id),
         payee      = VALUES(payee),
         cardholder = IF(cardholder IS NULL, VALUES(cardholder), cardholder),
         card_last4 = IF(card_last4 IS NULL, VALUES(card_last4), card_last4)`,
      [
        tenantId,
        runId,
        orphan.statementLineId,
        orphan.transactionDate,
        orphan.amount,
        orphan.currency,
        orphan.notes ?? orphan.reference ?? null,
        orphan.reference ?? null,
        orphan.payee ?? null,
        orphan.cardholder,
        orphan.cardLast4,
        insertStatus,
        insertNotes,
      ]
    );

    // Check actual status post-upsert (ON DUPLICATE KEY UPDATE doesn't downgrade)
    const existing = await query<any[]>(
      `SELECT status FROM bank_spend_orphans
       WHERE tenant_id = ? AND source_type = 'STATEMENT_LINE' AND xero_bank_tx_id = ?`,
      [tenantId, orphan.statementLineId]
    );
    const currentStatus = existing[0]?.status ?? insertStatus;

    if (noDoc) {
      summary.noDocRequired++;
    } else if (currentStatus === "flagged") {
      await enqueueDecision({
        queueKey: `STMT_ORPHAN:${orphan.statementLineId}`,
        domain: "OTHER",
        transactionType: "BANK_SPEND",
        contactName: orphan.payee ?? undefined,
        runId: runId ?? undefined,
        evidence: {
          statementLineId: orphan.statementLineId,
          transactionDate: orphan.transactionDate,
          amount: orphan.amount,
          currency: orphan.currency,
          payee: orphan.payee,
          reference: orphan.reference,
          notes: orphan.notes,
          bankAccountId: orphan.bankAccountId,
          bankAccountName: orphan.bankAccountName,
          cardholder: orphan.cardholder,
          cardLast4: orphan.cardLast4,
        },
        question: buildChaseQuestion(orphan),
      });

      await execute(
        `UPDATE bank_spend_orphans SET status = 'chasing'
         WHERE tenant_id = ? AND source_type = 'STATEMENT_LINE'
           AND xero_bank_tx_id = ? AND status = 'flagged'`,
        [tenantId, orphan.statementLineId]
      );
      summary.documentMissing++;
    } else {
      summary.alreadyTracked++;
    }

    if (orphan.cardholder === "jani") summary.byCardholder.jani++;
    else if (orphan.cardholder === "mari") summary.byCardholder.mari++;
    else summary.byCardholder.unknown++;
  }

  return summary;
}
