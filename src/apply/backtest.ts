import { query } from "../db/mysql.js";
import { buildInvoiceFromPsOrder, loadPsOrderForInvoice } from "../xero/invoice-builder.js";

export interface BacktestSummary {
  total: number;
  exactMatch: number;
  amountMatch: number;     // amounts match but other fields differ
  taxTypeMismatch: number;
  accountCodeMismatch: number;
  flagged: number;
  errors: number;
  samples: BacktestSample[];
}

export interface BacktestSample {
  reference: string;
  status: "exact" | "amount_ok" | "mismatch" | "flagged" | "error";
  detail?: string;
}

export async function backtestInvoiceBuilder(
  periodStart: string,
  periodEnd: string,
  sampleLimit = 10,
  runId?: number
): Promise<BacktestSummary> {
  // If no run_id provided, find the most recent completed run for this period
  let resolvedRunId = runId;
  if (!resolvedRunId) {
    const runs = await query<any[]>(
      `SELECT id FROM reconciliation_runs
       WHERE period_start = ? AND period_end = ? AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`,
      [periodStart, periodEnd]
    );
    if (runs.length === 0) {
      throw new Error(`No completed reconciliation run found for ${periodStart}→${periodEnd}. Run the reconciliation engine first.`);
    }
    resolvedRunId = runs[0].id;
  }

  const matched = await query<any[]>(
    `SELECT xero_reference, xero_invoice_number, xero_date, xero_total, xero_tax_amount,
            xero_tax_type, ps_order_id, ps_currency_id, ps_total_incl,
            ps_vat_inputs, xero_invoice_id
     FROM reconciliation_results
     WHERE run_id = ?
       AND match_status IN ('MATCHED', 'REF_MATCH_INV_DIFF')
       AND ps_order_id IS NOT NULL
     LIMIT 500`,
    [resolvedRunId]
  );

  const summary: BacktestSummary = {
    total: matched.length,
    exactMatch: 0,
    amountMatch: 0,
    taxTypeMismatch: 0,
    accountCodeMismatch: 0,
    flagged: 0,
    errors: 0,
    samples: [],
  };

  for (const row of matched) {
    try {
      const ps = await loadPsOrderForInvoice(row.xero_reference);
      if (!ps) {
        summary.errors++;
        continue;
      }

      const result = await buildInvoiceFromPsOrder(ps);
      if (result.status === "flagged") {
        summary.flagged++;
        if (summary.samples.length < sampleLimit) {
          summary.samples.push({ reference: row.xero_reference, status: "flagged", detail: result.flag });
        }
        continue;
      }

      const built = result.payload as any;
      const lines: any[] = built.LineItems ?? [];
      const productsLine = lines.find((l: any) => l.Description === "Products");
      const shippingLine = lines.find((l: any) => l.Description === "Shipping");

      const builtTotal =
        (productsLine?.UnitAmount ?? 0) + (shippingLine?.UnitAmount ?? 0);
      const actualTotal = Number(row.xero_total);

      const amountOk = Math.abs(builtTotal - actualTotal) < 0.02;
      const taxTypeOk = (productsLine?.TaxType ?? "") === (row.xero_tax_type?.split(",")[0] ?? "");
      const accountCodeOk = productsLine?.AccountCode != null;

      if (amountOk && taxTypeOk && accountCodeOk) {
        summary.exactMatch++;
        continue;
      }

      if (!amountOk) {
        if (summary.samples.length < sampleLimit) {
          summary.samples.push({
            reference: row.xero_reference,
            status: "mismatch",
            detail: `amount: built=${builtTotal} actual=${actualTotal} currency=${row.ps_currency_id === 3 ? "GBP" : "EUR"}`,
          });
        }
        summary.amountMatch++;
      }

      if (!taxTypeOk) {
        summary.taxTypeMismatch++;
        if (summary.samples.length < sampleLimit) {
          summary.samples.push({
            reference: row.xero_reference,
            status: "mismatch",
            detail: `tax_type: built=${productsLine?.TaxType} actual=${row.xero_tax_type}`,
          });
        }
      }

      if (!accountCodeOk) {
        summary.accountCodeMismatch++;
      }
    } catch (e) {
      summary.errors++;
    }
  }

  return summary;
}
