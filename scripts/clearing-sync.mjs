#!/usr/bin/env node
// CURO (CardGate) + TagadaPay clearing workflow.
//
//   node --import tsx scripts/clearing-sync.mjs --from 2026-07-01 --to 2026-09-30
//       REPORT ONLY (default). Writes a CSV of every order with a verdict. Nothing is posted.
//   ... --create-invoices --yes     create DRAFT sales invoices for verdict CREATE_DRAFT_INVOICE
//   ... --post-payments  --yes      post payments to 209 / 210 for verdict POST_PAYMENT
//
//   ... --post-payments --dry-run --yes   exercise the payment path, log dry_run rows, POST nothing
// Options: --processor CURO|TAGADA   --tagada-export <payments csv>   --limit N   --out <csv>
// Rules: invoices are always DRAFT; payments only on AUTHORISED invoices; every candidate is
// re-read live from Xero immediately before posting; REVIEW rows are never posted.
import "dotenv/config";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { query, closePool } from "../src/db/mysql.js";
import { XeroWriteClient } from "../src/xero/write-client.js";
import { COUNTRY_VAT_RULES } from "../src/vat/rates.js";
import { loadPsOrderForInvoice, buildInvoiceFromPsOrder } from "../src/xero/invoice-builder.js";
import { fetchInvoicePdf } from "../src/presta/rest-pdf.js";
import { classifyClearing, CLEARING_ACCOUNT } from "../src/accounting/clearing.js";
import mysql from "mysql2/promise";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes("--" + n);
const FROM = opt("from", "2026-07-01"), TO = opt("to", "2026-09-30");
const ONLY = opt("processor", null);
const LIMIT = Number(opt("limit", "0")) || Infinity;
const OUT = opt("out", `/opt/projects/gopure/bills_management/clearing-review-${FROM}_${TO}.csv`);
const DRY = has("dry-run");
const WRITE_INVOICES = has("create-invoices"), WRITE_PAYMENTS = has("post-payments");
if ((WRITE_INVOICES || WRITE_PAYMENTS) && !has("yes")) { console.error("Refusing to write without --yes"); process.exit(2); }

const bi = await mysql.createConnection({ host: process.env.PS_BI_HOST, user: process.env.PS_BI_USER, password: process.env.PS_BI_PASSWORD, database: process.env.PS_BI_NAME || "gopure_bi", dateStrings: true });
const [{ tenant_id: tenantId }] = await query("select distinct tenant_id from xero_invoice_balances limit 1");
const wc = new XeroWriteClient();
const rates = Object.fromEntries((await query("select tax_type,effective_rate from xero_tax_rates")).map((r) => [r.tax_type, Number(r.effective_rate)]));

// Tagada payments export (optional): refund status + unconfirmed candidates for orders the shop DB lacks.
const exportRows = [];
if (opt("tagada-export")) {
  const [h, ...ls] = fs.readFileSync(opt("tagada-export"), "utf8").trim().split(/\r?\n/);
  const cols = h.split(",");
  for (const l of ls) { const p = l.split(","); const o = Object.fromEntries(cols.map((c, i) => [c, p[i]])); if (o.id?.startsWith("pay_")) exportRows.push(o); }
}
const exportById = Object.fromEntries(exportRows.map((r) => [r.id, r]));
const usedExportIds = new Set();

const orders = await bi.query(
  `SELECT o.id_order,o.reference,o.module,o.valid,o.date_add,o.total_paid_tax_incl gross,o.total_paid_tax_excl net,
          cu.iso_code cur, co.iso_code ship, oi.number inv_no
     FROM pscw_orders o
     JOIN pscw_currency cu ON cu.id_currency=o.id_currency
     JOIN pscw_address a ON a.id_address=o.id_address_delivery
     JOIN pscw_country co ON co.id_country=a.id_country
     LEFT JOIN pscw_order_invoice oi ON oi.id_order=o.id_order
    WHERE o.module IN ('gp_cardgate','gp_tagada') AND o.date_add>=? AND o.date_add<DATE_ADD(?,INTERVAL 1 DAY)
    ORDER BY o.date_add`, [FROM, TO]).then(([r]) => r);

const rows = [];
for (const o of orders) {
  const processor = o.module === "gp_cardgate" ? "CURO" : "TAGADA";
  if (ONLY && ONLY !== processor) continue;
  const gross = Number(o.gross), net = Number(o.net);
  const shopRate = net > 0 ? Math.round(((gross - net) / net) * 10000) / 100 : null;

  let txn = null, amt = null, cur = null, dt = null, count = 0, refunded = false, extra = [];
  if (processor === "CURO") {
    const [t] = await bi.query("select transaction_id,code,amount,currency,date_upd from pscw_cardgate_transaction where id_order=? order by id_cardgate_transaction desc", [o.id_order]);
    count = t.length;
    if (t[0] && t[0].code === 200) { txn = t[0].transaction_id; amt = t[0].amount / 100; cur = t[0].currency; dt = t[0].date_upd; }
  } else {
    const [t] = await bi.query("select tagada_payment_id id,status,amount_minor,currency,webhook_received_at,created_at from pscw_gp_tagada_attempt where id_order=? and status='succeeded'", [o.id_order]);
    count = t.length;
    if (t.length === 1) { txn = t[0].id; amt = t[0].amount_minor / 100; cur = t[0].currency; dt = t[0].webhook_received_at || t[0].created_at; }
    else if (t.length > 1) { txn = null; extra.push("multiple succeeded Tagada payments in shop DB"); }
    if (txn && exportById[txn]) { usedExportIds.add(txn); if (exportById[txn].status === "refunded") refunded = true; }
    if (!txn && t.length === 0 && exportRows.length) {
      const cand = exportRows.filter((r) => r.status === "succeeded" && r.currency === o.cur && Math.abs(Number(r.amount) / 100 - gross) < 0.005 && Math.abs((new Date(r.createdAt) - new Date(o.date_add)) / 864e5) <= 7);
      if (cand.length) extra.push(`UNCONFIRMED Tagada match from export: ${cand.map((c) => c.id).join("/")} (${cand.length} candidate${cand.length > 1 ? "s" : ""}); confirm manually`);
    }
  }

  const xs = await query(
    `SELECT invoice_id,invoice_number,status,total,amount_due,amount_paid,currency_code,invoice_date FROM xero_invoice_balances
      WHERE tenant_id=? AND invoice_type='ACCREC' AND status NOT IN ('DELETED','VOIDED') AND (reference=? OR invoice_number=?)`,
    [tenantId, o.reference, String(o.inv_no ?? "")]);
  let posted = false;
  if (txn) {
    const p = await query("select 1 from xero_payments where reference=? limit 1", [txn]);
    const w = await query("select 1 from xero_write_log where operation='CREATE_PAYMENT' and dry_run=0 and status in ('success','pending') and request_payload like ? limit 1", [`%${txn}%`]);
    posted = p.length > 0 || w.length > 0;
  }
  const rule = COUNTRY_VAT_RULES[o.ship];
  const facts = {
    processor, reference: o.reference, orderValid: !!o.valid, orderGross: gross, orderCurrency: o.cur, shopVatRatePct: shopRate, shipCountry: o.ship,
    processorTxnId: txn, processorAmount: amt, processorCurrency: cur, processorTxnCount: count, processorRefunded: refunded,
    xeroInvoices: xs.map((x) => ({ status: x.status, total: Number(x.total), amountDue: Number(x.amount_due), amountPaid: Number(x.amount_paid), currency: x.currency_code })),
    builderTaxRatePct: rule?.taxType ? rates[rule.taxType] ?? null : null, txnAlreadyPosted: posted,
  };
  const v = classifyClearing(facts);
  if (extra.length) { v.reasons.push(...extra); if (v.action === "POST_PAYMENT" || v.action === "CREATE_DRAFT_INVOICE") v.action = "REVIEW"; }
  rows.push({ processor, ref: o.reference, inv_no: o.inv_no, order_date: String(o.date_add).slice(0, 10), ship: o.ship, cur: o.cur, gross, shop_vat_pct: shopRate,
    txn, txn_date: dt ? String(dt).slice(0, 10) : "", xero_status: xs[0]?.status ?? "", xero_due: xs[0]?.amount_due ?? "", action: v.action, reasons: v.reasons.join("; "), _xs: xs[0], _facts: facts });
}

// Export payments the shop DB never saw and no order claimed (informational).
const unclaimed = exportRows.filter((r) => r.status === "succeeded" && r.gateway === "TagadaPay" && !usedExportIds.has(r.id)).length;

const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const cols = ["processor", "ref", "inv_no", "order_date", "ship", "cur", "gross", "shop_vat_pct", "txn", "txn_date", "xero_status", "xero_due", "action", "reasons"];
fs.writeFileSync(OUT, [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n");
const tally = {};
for (const r of rows) tally[`${r.processor} ${r.action}`] = (tally[`${r.processor} ${r.action}`] || 0) + 1;
console.log("Report:", OUT); console.log(tally);
if (exportRows.length) console.log("Tagada export payments not tied to a shop order (not used):", unclaimed);

// ---- optional writes -------------------------------------------------------
const key = (kind, ref, extra = "") => createHash("sha256").update(`${kind}:${ref}:${extra}:${tenantId}`).digest("hex");
let done = 0;
if (WRITE_INVOICES) {
  for (const r of rows.filter((x) => x.action === "CREATE_DRAFT_INVOICE")) {
    if (done >= LIMIT) break;
    const live = await wc.findInvoiceByReference(tenantId, r.ref);          // live duplicate guard
    if (live) { console.log("SKIP exists live", r.ref); continue; }
    const ps = await loadPsOrderForInvoice(r.ref);
    const b = ps && await buildInvoiceFromPsOrder(ps);
    if (!b || b.status !== "ok") { console.log("FLAGGED", r.ref, b?.flag ?? "PS order not found"); continue; }
    const created = await wc.createInvoice(tenantId, b.payload, key("CREATE_ACCREC", r.ref), r.ref, false);
    const pdf = await fetchInvoicePdf(ps.id_order, key("CREATE_ACCREC", r.ref), tenantId);
    if (pdf) await wc.attachPdf(tenantId, created.InvoiceID, pdf.filename, pdf.buffer, false);
    console.log("DRAFT created", r.ref, created.InvoiceNumber, created.Total); done++;
  }
}
done = 0;
if (WRITE_PAYMENTS) {
  for (const r of rows.filter((x) => x.action === "POST_PAYMENT")) {
    if (done >= LIMIT) break;
    const live = await wc.getInvoice(tenantId, r._xs.invoice_id);            // re-read live, never trust the warehouse
    const due = Number(live?.AmountDue), paid = Number(live?.AmountPaid);
    if (!live || live.Status !== "AUTHORISED" || Math.abs(due - r.gross) > 0.005 || paid > 0) { console.log("SKIP live state changed", r.ref, live?.Status, due, paid); continue; }
    const invDate = String(live.DateString).slice(0, 10);
    const date = r.txn_date && r.txn_date > invDate ? r.txn_date : invDate;
    const payload = { Invoice: { InvoiceID: live.InvoiceID }, Account: { Code: CLEARING_ACCOUNT[r.processor] }, Date: date, Amount: r.gross, Reference: r.txn };
    const p = await wc.createPayment(tenantId, payload, key("CREATE_PAYMENT", r.ref, r.txn), r.ref, DRY);
    console.log(DRY ? "DRY-RUN would pay" : "PAID", r.ref, r.processor, r.gross, "->", CLEARING_ACCOUNT[r.processor], p.PaymentID); done++;
  }
}
await bi.end(); await closePool(); process.exit(0);
