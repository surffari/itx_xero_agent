import { execute, query } from "../db/mysql.js";
import { psQuery } from "../presta/pool.js";
import { config } from "../config.js";
import { applyRules, enqueueDecision } from "../learn/rules.js";
import { getSupplierProfile } from "../learn/profiles.js";
import { COUNTRY_VAT_RULES } from "../vat/rates.js";

const PS = config.PS_TABLE_PREFIX;

// Confidence threshold below which items are sent to the decision queue.
const QUEUE_THRESHOLD = 0.75;

export interface ReconcileResult {
  runId: number;
  periodStart: string;
  periodEnd: string;
  summary: ReconcileSummary;
}

export interface ReconcileSummary {
  // ACCREC (online sales)
  xeroTotal: number;
  psTotal: number;
  matched: number;
  refMatchInvDiff: number;
  xeroOnly: number;
  psOrphans: number;
  // ACCPAY (purchase bills)
  billsTotal: number;
  billsProposed: number;
  billsQueued: number;
}

export async function reconcilePeriod(periodStart: string, periodEnd: string): Promise<ReconcileResult> {
  const runRow = await execute(
    "INSERT INTO reconciliation_runs (period_start, period_end, status) VALUES (?, ?, 'running')",
    [periodStart, periodEnd]
  );
  const runId: number = runRow.insertId;

  try {
    const summary = await runReconciliation(runId, periodStart, periodEnd);

    await execute(
      "UPDATE reconciliation_runs SET status='completed', completed_at=NOW(), summary=? WHERE id=?",
      [JSON.stringify(summary), runId]
    );

    return { runId, periodStart, periodEnd, summary };
  } catch (err) {
    await execute(
      "UPDATE reconciliation_runs SET status='failed', completed_at=NOW(), error_message=? WHERE id=?",
      [err instanceof Error ? err.message : String(err), runId]
    );
    throw err;
  }
}

async function runReconciliation(runId: number, periodStart: string, periodEnd: string): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    xeroTotal: 0, psTotal: 0, matched: 0, refMatchInvDiff: 0, xeroOnly: 0, psOrphans: 0,
    billsTotal: 0, billsProposed: 0, billsQueued: 0,
  };

  await processOnlineSales(runId, periodStart, periodEnd, summary);
  await processPurchaseBills(runId, periodStart, periodEnd, summary);

  return summary;
}

// ---------------------------------------------------------------------------
// ACCREC: online sales — PS order ↔ Xero invoice ↔ payment receipt matching
// ---------------------------------------------------------------------------

async function processOnlineSales(
  runId: number,
  periodStart: string,
  periodEnd: string,
  summary: ReconcileSummary
): Promise<void> {
  const xeroInvoices = await query<any[]>(
    `SELECT invoice_id, reference, invoice_number, invoice_date, status, currency_code,
            total, total_tax, payload
     FROM xero_invoice_balances
     WHERE invoice_type = 'ACCREC'
       AND status NOT IN ('DELETED', 'VOIDED')
       AND invoice_date >= ? AND invoice_date <= ?`,
    [periodStart, periodEnd]
  );
  summary.xeroTotal = xeroInvoices.length;

  const psOrders = await psQuery<any[]>(
    `SELECT o.id_order, o.reference, oi.number as invoice_number,
            o.current_state, osl.name as state_name,
            o.date_add, o.id_currency, o.total_paid_tax_incl, o.total_paid_tax_excl,
            o.total_shipping_tax_incl, co.iso_code as ship_country
     FROM ${PS}orders o
     JOIN ${PS}order_state os ON o.current_state = os.id_order_state
     JOIN ${PS}order_state_lang osl ON os.id_order_state = osl.id_order_state AND osl.id_lang = 1
     LEFT JOIN ${PS}order_invoice oi ON oi.id_order = o.id_order
     JOIN ${PS}address a ON o.id_address_delivery = a.id_address
     JOIN ${PS}country co ON a.id_country = co.id_country
     WHERE os.invoice = 1
       AND o.date_add >= ? AND o.date_add < DATE_ADD(?, INTERVAL 1 DAY)`,
    [periodStart, periodEnd]
  );
  summary.psTotal = psOrders.length;

  const psIdx = new Map<string, (typeof psOrders)[0]>();
  for (const ps of psOrders) {
    if (ps.reference) psIdx.set(ps.reference, ps);
  }

  const xeroRefSet = new Set<string>();
  for (const xi of xeroInvoices) {
    if (xi.reference) xeroRefSet.add(xi.reference);
  }

  for (const xi of xeroInvoices) {
    const ps = xi.reference ? psIdx.get(xi.reference) : undefined;

    // --- Match status and confidence ---
    let matchStatus: string;
    let matchConfidence: number;

    if (ps) {
      const invMatch = String(ps.invoice_number) === String(xi.invoice_number);
      const amountDiff = ps.total_paid_tax_incl != null && xi.total != null
        ? Math.abs(Number(ps.total_paid_tax_incl) - Number(xi.total)) / (Number(xi.total) || 1)
        : 1;

      if (invMatch) {
        matchStatus = "MATCHED";
        summary.matched++;
        matchConfidence = amountDiff < 0.01 ? 0.97 : amountDiff < 0.05 ? 0.88 : 0.72;
      } else {
        matchStatus = "REF_MATCH_INV_DIFF";
        summary.refMatchInvDiff++;
        matchConfidence = amountDiff < 0.01 ? 0.80 : 0.65;
      }
    } else {
      matchStatus = "XERO_ONLY";
      summary.xeroOnly++;
      matchConfidence = 0.00;
    }

    // --- Proposed sales coding from COUNTRY_RULES (read-only validation) ---
    let proposedAccountCode: string | null = null;
    let proposedTaxCode: string | null = null;
    let taxConfidence: number;

    if (ps?.ship_country) {
      const rule = COUNTRY_VAT_RULES[ps.ship_country];
      if (rule?.taxType) {
        proposedAccountCode = rule.accountCode;
        proposedTaxCode = rule.taxType;
        taxConfidence = 0.90;
      } else {
        // Unknown country or known country without a Xero tax rate yet
        taxConfidence = 0.10;
      }
    } else {
      // No PS data — can't determine tax from country; use existing Xero tax type
      taxConfidence = matchStatus === "XERO_ONLY" ? 0.00 : 0.50;
    }

    // --- Existing tax type from payload ---
    let xeroTaxType: string | null = null;
    try {
      const payload = JSON.parse(xi.payload || "{}");
      const lineItems: any[] = payload.LineItems || [];
      const taxTypes = [...new Set(lineItems.map((l: any) => l.TaxType).filter(Boolean))];
      xeroTaxType = taxTypes.join(",") || null;
    } catch { /* ignore */ }

    // --- Bank receipt lookup ---
    let xeroPaymentId: string | null = null;
    let xeroPaymentDate: string | null = null;
    let xeroPaymentAmount: number | null = null;

    const payments = await query<any[]>(
      `SELECT payment_id, payment_date, amount
       FROM xero_payments
       WHERE source_id = ? AND status NOT IN ('DELETED', 'VOIDED')
       ORDER BY payment_date DESC
       LIMIT 1`,
      [xi.invoice_id]
    );
    if (payments.length > 0) {
      xeroPaymentId = payments[0].payment_id;
      xeroPaymentDate = payments[0].payment_date instanceof Date
        ? payments[0].payment_date.toISOString().substring(0, 10)
        : String(payments[0].payment_date ?? "").substring(0, 10) || null;
      xeroPaymentAmount = payments[0].amount != null ? Number(payments[0].amount) : null;
    }

    // --- PS VAT inputs (side-by-side, no judgment) ---
    let psVatInputs: object | null = null;
    if (ps) {
      psVatInputs = await assemblePsVatInputs(ps.id_order, xi, ps);
    }

    await execute(
      `INSERT INTO reconciliation_results
         (run_id, xero_invoice_id, xero_reference, xero_invoice_number, xero_date, xero_status,
          xero_currency, xero_total, xero_tax_amount, xero_tax_type, match_status,
          ps_order_id, ps_invoice_number, ps_date, ps_currency_id,
          ps_total_incl, ps_total_excl, ps_shipping_incl, ps_ship_country, ps_order_state, ps_vat_inputs,
          proposed_account_code, proposed_tax_code,
          match_confidence, tax_confidence,
          xero_payment_id, xero_payment_date, xero_payment_amount)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         match_status=VALUES(match_status),
         proposed_account_code=VALUES(proposed_account_code),
         proposed_tax_code=VALUES(proposed_tax_code),
         match_confidence=VALUES(match_confidence),
         tax_confidence=VALUES(tax_confidence),
         xero_payment_id=VALUES(xero_payment_id),
         xero_payment_date=VALUES(xero_payment_date),
         xero_payment_amount=VALUES(xero_payment_amount)`,
      [
        runId, xi.invoice_id, xi.reference, xi.invoice_number, xi.invoice_date, xi.status,
        xi.currency_code, xi.total, xi.total_tax, xeroTaxType, matchStatus,
        ps?.id_order ?? null, ps ? String(ps.invoice_number) : null, ps?.date_add ?? null,
        ps?.id_currency ?? null, ps?.total_paid_tax_incl ?? null, ps?.total_paid_tax_excl ?? null,
        ps?.total_shipping_tax_incl ?? null, ps?.ship_country ?? null, ps?.state_name ?? null,
        psVatInputs ? JSON.stringify(psVatInputs) : null,
        proposedAccountCode, proposedTaxCode,
        matchConfidence, taxConfidence,
        xeroPaymentId, xeroPaymentDate, xeroPaymentAmount,
      ]
    );

    // --- Enqueue decisions for low-confidence or unresolvable items ---
    if (matchStatus === "XERO_ONLY") {
      await enqueueDecision({
        queueKey: `ACCREC_NO_PS:${xi.invoice_id}`,
        domain: "MATCH",
        transactionType: "ACCREC",
        contactName: undefined,
        xeroInvoiceId: xi.invoice_id,
        runId,
        evidence: {
          xeroInvoiceId: xi.invoice_id,
          reference: xi.reference,
          invoiceNumber: xi.invoice_number,
          date: xi.invoice_date,
          total: xi.total,
          currency: xi.currency_code,
          taxType: xeroTaxType,
        },
        question: `Xero invoice ${xi.invoice_number ?? xi.reference} (${xi.currency_code} ${xi.total}, date ${xi.invoice_date}) has no matching PrestaShop order by reference. Is this a non-PS sale, a manually created invoice, or a reference mismatch that should be linked to a specific PS order?`,
      });
    } else if (ps && taxConfidence < QUEUE_THRESHOLD) {
      await enqueueDecision({
        queueKey: `ACCREC_TAX:${xi.invoice_id}`,
        domain: "TAX_CODE",
        transactionType: "ACCREC",
        xeroInvoiceId: xi.invoice_id,
        psOrderId: ps.id_order,
        runId,
        evidence: {
          shipCountry: ps.ship_country,
          xeroTaxType,
          proposedAccountCode,
          proposedTaxCode,
          total: xi.total,
        },
        question: `Sales invoice ${xi.invoice_number ?? xi.reference} ships to country '${ps.ship_country}' which has no Xero tax rate configured in COUNTRY_VAT_RULES. What account code and tax code should apply? (Current Xero tax: ${xeroTaxType ?? "none"})`,
      });
    }
  }

  // PS orphans (invoiced PS orders with no Xero invoice)
  for (const ps of psOrders) {
    if (ps.reference && xeroRefSet.has(ps.reference)) continue;

    await execute(
      `INSERT INTO reconciliation_ps_orphans
         (run_id, ps_order_id, ps_reference, ps_invoice_number, ps_state, ps_date,
          ps_currency_id, ps_total_incl, ps_ship_country)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE ps_state=VALUES(ps_state)`,
      [
        runId, ps.id_order, ps.reference, ps.invoice_number ? String(ps.invoice_number) : null,
        ps.state_name, ps.date_add, ps.id_currency, ps.total_paid_tax_incl, ps.ship_country,
      ]
    );
    summary.psOrphans++;
  }
}

// ---------------------------------------------------------------------------
// ACCPAY: purchase bills — rule-based account/tax coding proposals
// ---------------------------------------------------------------------------

async function processPurchaseBills(
  runId: number,
  periodStart: string,
  periodEnd: string,
  summary: ReconcileSummary
): Promise<void> {
  const bills = await query<any[]>(
    `SELECT invoice_id, invoice_number, contact_name, invoice_date, currency_code, total, payload
     FROM xero_invoice_balances
     WHERE invoice_type = 'ACCPAY'
       AND status NOT IN ('DELETED', 'VOIDED')
       AND invoice_date >= ? AND invoice_date <= ?
     ORDER BY invoice_date ASC`,
    [periodStart, periodEnd]
  );
  summary.billsTotal = bills.length;

  for (const bill of bills) {
    // Extract primary account/tax from the first line item in payload
    let currentAccountCode: string | null = null;
    let currentAccountName: string | null = null;
    let currentTaxCode: string | null = null;
    let description: string | null = null;

    try {
      const payload = JSON.parse(bill.payload || "{}");
      const lines: any[] = payload.LineItems || [];
      if (lines.length > 0) {
        currentAccountCode = lines[0].AccountCode ?? null;
        currentAccountName = lines[0].AccountName ?? null;
        currentTaxCode = lines[0].TaxType ?? null;
        description = lines[0].Description ?? null;
      }
    } catch { /* ignore */ }

    // Supplier profile takes precedence over rules: profiles hold verified supplier facts;
    // rules are pattern-matched heuristics. Fall through to rules only when no profile exists.
    const profile = bill.contact_name
      ? await getSupplierProfile(bill.contact_name)
      : null;

    let hit = null;
    let codingConfidence: number;
    let profileUsed = false;

    if (profile && (profile.defaultTaxCode || profile.defaultAccountCode) && profile.confidence >= QUEUE_THRESHOLD) {
      // Confirmed supplier profile — use it directly
      hit = {
        ruleId: -1,
        ruleName: `supplier_profile:${profile.contactName}`,
        assignedAccountCode: profile.defaultAccountCode,
        assignedAccountName: null,
        assignedTaxCode: profile.defaultTaxCode,
        assignedContactName: null,
        confidence: profile.confidence,
      };
      codingConfidence = profile.confidence;
      profileUsed = true;
    } else {
      hit = await applyRules({
        transactionType: "ACCPAY",
        contactName: bill.contact_name ?? undefined,
        accountCode: currentAccountCode ?? undefined,
        description: description ?? undefined,
        currency: bill.currency_code ?? undefined,
      });
      codingConfidence = hit ? hit.confidence : 0.10;
    }

    const proposalStatus = codingConfidence < QUEUE_THRESHOLD ? "queued" : "proposed";
    const matchedRuleId = profileUsed ? null : (hit?.ruleId ?? null);

    // Write proposal
    const sourceRef = `ACCPAY:${bill.invoice_id}`;
    await execute(
      `INSERT INTO coding_proposals
         (run_id, source_ref, source_type, xero_invoice_id, contact_name, transaction_date,
          currency_code, total, current_account_code, current_account_name, current_tax_code,
          proposed_account_code, proposed_account_name, proposed_tax_code,
          matched_rule_id, matched_rule_name, coding_confidence, proposal_status)
       VALUES (?, ?, 'ACCPAY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         proposed_account_code=VALUES(proposed_account_code),
         proposed_account_name=VALUES(proposed_account_name),
         proposed_tax_code=VALUES(proposed_tax_code),
         matched_rule_id=VALUES(matched_rule_id),
         matched_rule_name=VALUES(matched_rule_name),
         coding_confidence=VALUES(coding_confidence),
         proposal_status=VALUES(proposal_status)`,
      [
        runId, sourceRef, bill.invoice_id, bill.contact_name,
        bill.invoice_date instanceof Date
          ? bill.invoice_date.toISOString().substring(0, 10)
          : String(bill.invoice_date ?? "").substring(0, 10) || null,
        bill.currency_code, bill.total,
        currentAccountCode, currentAccountName, currentTaxCode,
        hit?.assignedAccountCode ?? null,
        hit?.assignedAccountName ?? null,
        hit?.assignedTaxCode ?? null,
        matchedRuleId,
        hit ? hit.ruleName : null,
        codingConfidence, proposalStatus,
      ]
    );

    if (proposalStatus === "queued") {
      summary.billsQueued++;
      const decisionId = await enqueueDecision({
        queueKey: `ACCPAY_CODE:${bill.invoice_id}`,
        domain: hit ? "TAX_CODE" : "ACCOUNT_CODE",
        transactionType: "ACCPAY",
        contactName: bill.contact_name ?? undefined,
        xeroInvoiceId: bill.invoice_id,
        runId,
        evidence: {
          invoiceId: bill.invoice_id,
          invoiceNumber: bill.invoice_number,
          contactName: bill.contact_name,
          date: bill.invoice_date,
          total: bill.total,
          currency: bill.currency_code,
          currentAccountCode,
          currentTaxCode,
          matchedRule: hit ? hit.ruleName : null,
          ruleConfidence: hit?.confidence ?? null,
        },
        question: profileUsed
          ? `Bill ${bill.invoice_number ?? bill.invoice_id} from '${bill.contact_name}' (${bill.currency_code} ${bill.total}): supplier profile exists but confidence ${hit!.confidence} is below threshold ${QUEUE_THRESHOLD}. Profile: account ${hit!.assignedAccountCode ?? "?"} / tax ${hit!.assignedTaxCode ?? "unset"}. Is this correct, or has the supplier's situation changed? Use upsert_supplier_profile to update and raise confidence when confirmed.`
          : hit
            ? `Bill ${bill.invoice_number ?? bill.invoice_id} from '${bill.contact_name}' (${bill.currency_code} ${bill.total}): rule '${hit.ruleName}' proposes account ${hit.assignedAccountCode ?? "?"} / tax ${hit.assignedTaxCode ?? "unset"} with confidence ${hit.confidence} (below ${QUEUE_THRESHOLD} threshold). ${hit.assignedTaxCode ? `Is tax code '${hit.assignedTaxCode}' still correct, or has this supplier's EU VAT/reverse-charge status changed?` : "What is the correct Xero tax code for this supplier?"} Once confirmed, call upsert_supplier_profile to store this supplier's tax treatment.`
            : `Bill ${bill.invoice_number ?? bill.invoice_id} from '${bill.contact_name}' (${bill.currency_code} ${bill.total}): no supplier profile or coding rule matched. Current coding: account ${currentAccountCode ?? "none"} / tax ${currentTaxCode ?? "none"}. What is this supplier's country, VAT registration status (EU / non-EU), and supply type (goods / services)? What account code and tax code should apply? Call upsert_supplier_profile to record the answer so future bills auto-classify.`,
      });
      // Link decision back to proposal
      await execute(
        `UPDATE coding_proposals SET decision_id = ? WHERE run_id = ? AND source_ref = ?`,
        [decisionId, runId, sourceRef]
      );
    } else {
      summary.billsProposed++;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function assemblePsVatInputs(psOrderId: number, xi: any, ps: any): Promise<object> {
  const lines = await psQuery<any[]>(
    `SELECT product_name, product_quantity, tax_rate,
            total_price_tax_excl, total_price_tax_incl
     FROM ${PS}order_detail WHERE id_order = ?`,
    [psOrderId]
  );

  return {
    ship_country: ps.ship_country,
    ps_currency_id: ps.id_currency,
    ps_total_incl: ps.total_paid_tax_incl,
    ps_total_excl: ps.total_paid_tax_excl,
    ps_shipping_incl: ps.total_shipping_tax_incl,
    xero_currency: xi.currency_code,
    xero_total: xi.total,
    xero_tax_amount: xi.total_tax,
    lines: lines.map((l) => ({
      product: l.product_name,
      qty: l.product_quantity,
      tax_rate: l.tax_rate,
      total_excl: l.total_price_tax_excl,
      total_incl: l.total_price_tax_incl,
    })),
  };
}
