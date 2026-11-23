#!/usr/bin/env node
// Bills Management P1-04: generates the live per-document dashboard (R12/R13) —
// overview counts + item detail for every mailbox_invoice_files row. Read-only: only
// SELECT statements are run, nothing is written to the database, Xero, or Nextcloud.
//
// Requires DB credentials (intactix_accounting_agent/.env) — run as whoever owns that
// file (surffari), same as the migration in P1-01 and the P1-03 spot-check.
//
// Updated 2026-09-15 (D20): the overview counts now tally the PERSISTED bills_status
// (the real, current classification — including the 2026-09-14 real-PDF-content batch
// review and today's corrections, all now written to the DB) rather than a fresh
// routeMailboxFile() recompute. The mechanical recompute has no visibility into manual
// classifications that aren't derivable from matched_invoice_id/extracted_* alone (the
// same gap that caused the 2026-09-15 Nextcloud duplication incident) — it's kept below
// as a secondary "Computed (mechanical, dry-run)" column for diagnostic reference only,
// not as the page's headline counts.
//
// Updated 2026-09-16 (P2-06, R20/R21): added at-a-glance flags — staleness (Needs Review /
// Ready for Xero sitting past a threshold since their last real status change), missing
// extraction data, a flagged duplicate, and a failed processing attempt (status='error').
// Staleness is honest about a real data gap: most one-off correction scripts this week
// wrote bills_status without bills_status_changed_at, so many documents currently show
// "staleness unknown" rather than a guessed age — never invented.
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { query, closePool } from "../src/db/mysql.js";
import { config } from "../src/config.js";
import { routeMailboxFile } from "../src/bills/routing.js";

const OUTPUT_PATH = "/var/www/gp_projects/bills_management/documents.html";
// P2-06 (R20/R21) thresholds, reviewed and confirmed by Kayne 2026-09-17 (D24 update):
// Ready for Xero stale after 3 days (it's coded and ready — should move into Xero
// promptly), Needs Review stale after 5 days (a real decision takes longer). Staleness
// only applies to these two "waiting on a human" statuses; Uploaded to Xero and
// Exceptions are terminal for this dashboard's purposes (Xero-side review is a separate
// workflow), and Incoming is pre-triage, not yet anyone's turn to act.
const STALE_DAYS = { needs_review: 5, ready_for_xero: 3 };
const tenantId = config.XERO_TENANT_ID ?? "";

async function queryFn(sql, args) {
  return query(sql, args);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function daysAgo(dateVal) {
  if (!dateVal) return null;
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// R20 (staleness) + R21 (at-a-glance: missing data / duplicates / failed processing).
// `untracked` covers a document whose status is one that staleness applies to, but which
// has no real bills_status_changed_at on record — most one-off correction scripts this
// week wrote bills_status without it; never treated as 0-days-fresh or infinitely stale,
// just flagged as unknown so it isn't silently mistaken for either.
function flagsFor(r, effectiveStatus) {
  const age = daysAgo(r.bills_status_changed_at);
  const staleThreshold = STALE_DAYS[effectiveStatus];
  const applicable = staleThreshold != null;
  const stale = applicable && age != null && age >= staleThreshold;
  const untracked = applicable && age == null;
  // Scoped to ready_for_xero/uploaded_to_xero only: for the rest of the backlog, incomplete
  // extracted_* is the norm today, not a problem — extraction only persists to the DB as a
  // side effect of a successful create_bill_from_mailbox_file call (Q5/D12's known upstream
  // gap), so most needs_review/incoming/exceptions rows are "missing data" in the DB even
  // when the real invoice content is complete and already reviewed. Flagging every one of
  // those would just be re-surfacing a known gap as noise, not a real per-document problem.
  const extractionIncomplete = !r.extracted_supplier || r.extracted_amount == null || !r.extracted_currency || !r.extracted_date;
  const missingData = extractionIncomplete && (effectiveStatus === "ready_for_xero" || effectiveStatus === "uploaded_to_xero");
  const duplicate = r.duplicate_check_result === "duplicate";
  const failed = r.status === "error";
  return { age, staleThreshold, stale, untracked, missingData, duplicate, failed };
}

const STATUS_LABEL = {
  incoming: "Incoming",
  ready_for_xero: "Ready for Xero",
  uploaded_to_xero: "Uploaded to Xero",
  needs_review: "Needs Review",
  exceptions: "Exceptions",
};
const STATUS_BADGE = {
  incoming: "b-todo",
  ready_for_xero: "b-doing",
  uploaded_to_xero: "b-done",
  needs_review: "b-doing",
  exceptions: "b-blocked",
};

const rows = await query(
  `SELECT id, attachment_filename, subject, received_at, status, matched_invoice_id,
          extracted_supplier, extracted_amount, extracted_currency, extracted_date,
          bills_status, bills_status_reason, bills_status_changed_at,
          duplicate_check_result, duplicate_check_reference
   FROM mailbox_invoice_files
   ORDER BY received_at DESC, id DESC`
);

const computed = [];
for (const r of rows) {
  const result = await routeMailboxFile(
    {
      id: r.id, status: r.status, matched_orphan_id: null, matched_invoice_id: r.matched_invoice_id,
      extracted_supplier: r.extracted_supplier, extracted_amount: r.extracted_amount,
      extracted_currency: r.extracted_currency, extracted_date: r.extracted_date,
    },
    { tenantId, reference: null, invoiceNumber: null, queryFn }
  );
  // Same resolution rule as route-to-nextcloud.mjs: a persisted, non-'incoming'
  // bills_status (a manual classification, written back to the DB) always wins; only
  // when nothing has been persisted does the mechanical recompute stand in — which is
  // exactly correct for the deterministic matched_invoice_id case (the 11 pre-existing
  // "uploaded_to_xero" rows never needed explicit persistence because the recompute
  // gets them right every time from that one field alone).
  const trusted = Boolean(r.bills_status && r.bills_status !== "incoming");
  const effectiveStatus = trusted ? r.bills_status : result.bills_status;
  const flags = flagsFor(r, effectiveStatus);
  computed.push({ row: r, computed: result, effectiveStatus, trusted, flags });
}

const counts = { incoming: 0, ready_for_xero: 0, uploaded_to_xero: 0, needs_review: 0, exceptions: 0 };
for (const c of computed) counts[c.effectiveStatus] = (counts[c.effectiveStatus] ?? 0) + 1;

const mismatches = computed.filter((c) => c.effectiveStatus !== c.computed.bills_status);

const flagCounts = { stale: 0, untracked: 0, missingData: 0, duplicate: 0, failed: 0 };
for (const c of computed) {
  if (c.flags.stale) flagCounts.stale++;
  if (c.flags.untracked) flagCounts.untracked++;
  if (c.flags.missingData) flagCounts.missingData++;
  if (c.flags.duplicate) flagCounts.duplicate++;
  if (c.flags.failed) flagCounts.failed++;
}

const statCards = Object.entries(counts)
  .map(([key, n]) => `<div class="stat"><span class="stat-l">${esc(STATUS_LABEL[key])}</span><span class="stat-n">${n}</span></div>`)
  .join("");

const FLAG_LABEL = {
  stale: "⏳ Stale (past threshold)",
  untracked: "◌ Staleness unknown",
  missingData: "🏷️ Missing data",
  duplicate: "🔁 Duplicate flagged",
  failed: "⚠️ Failed processing",
};
const flagStatCards = Object.entries(flagCounts)
  .map(([key, n]) => `<div class="stat"><span class="stat-l">${esc(FLAG_LABEL[key])}</span><span class="stat-n">${n}</span></div>`)
  .join("");

// Phase 3 / R18 (D37): minimal run log. Derived from records that already exist — no new
// table, no writes. A "run" here is one calendar day (UTC) of activity on the bills
// pipeline: documents received, bills drafted / dry-run / recoded / voided in Xero
// (bill operations only — xero_write_log is shared with the sales-invoice pipeline),
// failed or unfinished writes, and documents whose status changed.
const RUN_LOG_FROM = "2026-08-28";
const BILL_OPS = ["CREATE_BILL", "RECODE_BILL", "DELETE_BILL"];
const runDays = {};
const runDay = (d) => (runDays[d] ??= { received: 0, drafted: 0, dry: 0, recoded: 0, voided: 0, errors: 0, classified: {} });

for (const r of await query(
  `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') d, COUNT(*) n FROM mailbox_invoice_files
   WHERE created_at >= ? GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')`, [RUN_LOG_FROM])) {
  runDay(r.d).received += Number(r.n);
}
for (const r of await query(
  `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') d, operation, status, dry_run, COUNT(*) n FROM xero_write_log
   WHERE tenant_id = ? AND operation IN (?, ?, ?) AND created_at >= ?
   GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d'), operation, status, dry_run`,
  [tenantId, ...BILL_OPS, RUN_LOG_FROM])) {
  const n = Number(r.n);
  const dry = Number(r.dry_run) === 1;
  const row = runDay(r.d);
  if (r.status === "error" || (r.status === "pending" && !dry)) row.errors += n;
  else if (r.operation === "CREATE_BILL" && dry) row.dry += n;
  else if (r.operation === "CREATE_BILL" && r.status === "success") row.drafted += n;
  else if (r.operation === "RECODE_BILL" && r.status === "success") row.recoded += n;
  else if (r.operation === "DELETE_BILL" && r.status === "success") row.voided += n;
}
for (const r of await query(
  `SELECT DATE_FORMAT(bills_status_changed_at, '%Y-%m-%d') d, bills_status, COUNT(*) n FROM mailbox_invoice_files
   WHERE bills_status_changed_at IS NOT NULL AND bills_status_changed_at >= ?
   GROUP BY DATE_FORMAT(bills_status_changed_at, '%Y-%m-%d'), bills_status`, [RUN_LOG_FROM])) {
  runDay(r.d).classified[r.bills_status] = Number(r.n);
}
const fmtTs = (v) => (v ? new Date(v).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const [lastReceived] = await query(`SELECT MAX(created_at) m FROM mailbox_invoice_files`);
const [lastDrafted] = await query(
  `SELECT MAX(created_at) m FROM xero_write_log WHERE tenant_id = ? AND operation = 'CREATE_BILL' AND status = 'success' AND dry_run = 0`, [tenantId]);
const runDayKeys = Object.keys(runDays).sort().reverse();
const runTotals = runDayKeys.reduce((a, k) => ({
  received: a.received + runDays[k].received, drafted: a.drafted + runDays[k].drafted, errors: a.errors + runDays[k].errors,
}), { received: 0, drafted: 0, errors: 0 });
const runCards = [
  ["Last document received", fmtTs(lastReceived?.m)],
  ["Last bill drafted in Xero", fmtTs(lastDrafted?.m)],
  [`Documents received since ${RUN_LOG_FROM}`, runTotals.received],
  [`Bills drafted since ${RUN_LOG_FROM}`, runTotals.drafted],
  ["Failed / unfinished writes", runTotals.errors],
].map(([l, v]) => `<div class="stat"><span class="stat-l">${esc(l)}</span><span class="stat-n" style="font-size:${typeof v === "number" ? "28" : "15"}px">${esc(v)}</span></div>`).join("");
const runRows = runDayKeys.map((k) => {
  const d = runDays[k];
  const classified = Object.entries(d.classified).map(([s, n]) => `${esc(STATUS_LABEL[s] ?? s)} ${n}`).join(" · ") || "—";
  const dash = (n) => (n ? n : "—");
  return `<tr><td>${esc(k)}</td><td>${dash(d.received)}</td><td>${dash(d.drafted)}</td><td>${dash(d.dry)}</td><td>${dash(d.recoded + d.voided)}</td><td>${d.errors ? `<span class="badge b-blocked">${d.errors}</span>` : "—"}</td><td>${classified}</td></tr>`;
}).join("\n");

const tableRows = computed
  .map(({ row: r, computed: c, effectiveStatus, trusted, flags }) => {
    const amount = r.extracted_amount != null ? `${Number(r.extracted_amount).toFixed(2)} ${r.extracted_currency ?? ""}` : "—";
    const statusBadge = STATUS_BADGE[effectiveStatus] ?? "b-todo";
    const computedBadge = STATUS_BADGE[c.bills_status] ?? "b-todo";
    const diffFlag = effectiveStatus !== c.bills_status ? ` <span class="muted" title="${trusted ? "Manually classified and persisted to the DB" : "Deterministic from matched_invoice_id"} — mechanical recompute has no visibility into that, see D20">(differs)</span>` : "";
    const reason = r.bills_status_reason ?? c.bills_status_reason;
    const flagBadges = [];
    if (flags.stale) flagBadges.push(`<span class="badge b-blocked" title="${flags.age}d since last status change — past the ${flags.staleThreshold}d threshold for ${esc(STATUS_LABEL[effectiveStatus])}">⏳ ${flags.age}d</span>`);
    if (flags.untracked) flagBadges.push(`<span class="badge b-todo" title="No bills_status_changed_at on record — pre-dates the timestamp being tracked for this document">◌ untracked</span>`);
    if (flags.missingData) flagBadges.push(`<span class="badge b-doing" title="Missing one or more of supplier/amount/currency/date">🏷️ missing data</span>`);
    if (flags.duplicate) flagBadges.push(`<span class="badge b-blocked" title="duplicate_check_result = duplicate">🔁 duplicate</span>`);
    if (flags.failed) flagBadges.push(`<span class="badge b-blocked" title="status = error — a failed processing attempt">⚠️ failed</span>`);
    return `<tr>
      <td>${r.id}</td>
      <td>${esc(r.attachment_filename)}</td>
      <td>${esc(r.extracted_supplier ?? "—")}</td>
      <td>${esc(amount)}</td>
      <td>${esc(r.extracted_date ?? "—")}</td>
      <td><span class="badge ${statusBadge}">${esc(STATUS_LABEL[effectiveStatus] ?? effectiveStatus)}</span></td>
      <td><span class="badge ${computedBadge}">${esc(STATUS_LABEL[c.bills_status])}</span>${diffFlag}</td>
      <td>${esc(reason ?? "—")}</td>
      <td>${esc(c.duplicate_check_result)}${c.duplicate_check_reference ? ` (${esc(c.duplicate_check_reference)})` : ""}</td>
      <td>${r.matched_invoice_id ? `<code>${esc(r.matched_invoice_id)}</code>` : "—"}</td>
      <td>${flagBadges.join(" ") || "—"}</td>
    </tr>`;
  })
  .join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Bills Management — Documents</title>
<link rel="stylesheet" href="style.css">
<style>
.doctable{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
.doctable th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;
  letter-spacing:.04em;padding:6px 8px;border-bottom:1px solid var(--line)}
.doctable td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.doctable tr:hover td{background:rgba(255,255,255,.02)}
.banner{background:rgba(184,134,11,.12);border:1px solid var(--doing);border-radius:8px;
  padding:10px 14px;font-size:13px;color:#e6b84c;margin-bottom:18px}
.tablewrap{overflow-x:auto}
</style>
</head>
<body>
<div class="wrap">
<nav class="sitenav">
  <a href="index.html">Status overview</a>
  <a href="plan.html">Plan board</a>
  <a href="documents.html" class="active">Documents</a>
  <a class="ext first-ext" href="https://projects.gopure.shop/roadmap/">Roadmap ↗</a>
</nav>

<h1>Bills Management — Documents</h1>
<p class="sub">Live per-document status (R12/R13), read directly from <code>mailbox_invoice_files</code>. Read-only — this page never writes anything.</p>

<div class="banner">
  The overview counts and the <strong>Status</strong> column reflect the real, current
  classification (<code>bills_status</code>) for every document — including the
  2026-09-14 real-PDF-content review and this week's corrections, all persisted to the
  database. The <strong>Mechanical recompute</strong> column is what
  <code>routeMailboxFile()</code> would compute fresh from extraction data alone — it's
  shown for diagnostic reference only; it has no visibility into manual classification
  decisions and is expected to disagree with Status on most rows.
  ${mismatches.length > 0 ? `<br><strong>${mismatches.length} of ${computed.length}</strong> rows differ between Status and the mechanical recompute — expected, not an error (see D20).` : ""}
</div>

<div class="statgrid">${statCards}</div>

<div class="banner">
  <strong>At a glance (P2-06 / R20, R21)</strong> — defaults below, review before relying on
  them: <strong>Stale</strong> = Needs Review untouched ${STALE_DAYS.needs_review}+ days, or
  Ready for Xero untouched ${STALE_DAYS.ready_for_xero}+ days (Uploaded to Xero/Exceptions are
  terminal for this page; Incoming is pre-triage — neither gets a staleness clock).
  <strong>Staleness unknown</strong> = no real change-timestamp on record for that document yet
  (most one-off corrections this week wrote status without it — a real backfill from this
  week's own backup manifests is ready but not yet applied; nothing here is guessed).
  <strong>Missing data</strong> = supplier/amount/currency/date incomplete on a document
  already marked Ready for Xero or Uploaded to Xero (scoped there deliberately — incomplete
  extraction elsewhere in the backlog is the known Q5/D12 dry-run gap, not a per-document
  problem, and flagging it everywhere would just be noise). <strong>Duplicate
  flagged</strong> = <code>duplicate_check_result='duplicate'</code>. <strong>Failed
  processing</strong> = <code>status='error'</code> (a stuck/failed extraction attempt, distinct
  from a legitimate Exceptions classification).
</div>

<div class="statgrid">${flagStatCards}</div>

<h2 id="run-log">Run log</h2>
<div class="banner">
  <strong>Run log (Phase 3 / R18, D37)</strong> — one row per active day (UTC), newest first,
  derived from records that already exist, not a separate log table: <strong>Received</strong> =
  documents that arrived in the mailbox; <strong>Drafted</strong> = bills created as DRAFT in Xero;
  <strong>Dry-runs</strong> = previews logged before a write (each unique preview counts once);
  <strong>Recoded / voided</strong> = changes to existing bills; <strong>Failed</strong> = errored or
  unfinished Xero writes; <strong>Classified</strong> = documents whose status changed that day.
  Classifications only appear for documents with a real change timestamp — earlier one-off
  corrections didn't record one, so older days can under-count them.
</div>
<div class="statgrid">${runCards}</div>
<div class="tablewrap">
<table class="doctable">
<thead><tr>
  <th>Day (UTC)</th><th>Received</th><th>Drafted</th><th>Dry-runs</th><th>Recoded / voided</th><th>Failed</th><th>Classified</th>
</tr></thead>
<tbody>
${runRows || '<tr><td colspan="7" class="muted">No activity recorded.</td></tr>'}
</tbody>
</table>
</div>

<h2>Documents</h2>
<div class="tablewrap">
<table class="doctable">
<thead><tr>
  <th>ID</th><th>File</th><th>Supplier</th><th>Amount</th><th>Date</th>
  <th>Status</th><th>Mechanical recompute</th><th>Reason</th><th>Duplicate check</th><th>Xero bill</th><th>Flags</th>
</tr></thead>
<tbody>
${tableRows || '<tr><td colspan="11" class="muted">No rows in mailbox_invoice_files.</td></tr>'}
</tbody>
</table>
</div>

<footer>
  Generated ${new Date().toISOString()} by <code>scripts/build-bills-status-dashboard.mjs</code>
  in <code>intactix_accounting_agent</code> · read-only · ${computed.length} document(s)
</footer>
</div>
</body>
</html>
`;

await writeFile(OUTPUT_PATH, html, "utf8");
console.log(`Wrote ${OUTPUT_PATH}`);
console.log(`Documents: ${computed.length}`);
console.log(`Counts: ${JSON.stringify(counts)}`);
console.log(`Status vs mechanical-recompute mismatches: ${mismatches.length} (expected — the recompute can't see manual classifications, see D20)`);
console.log(`Flags (P2-06): ${JSON.stringify(flagCounts)}`);
console.log(`Run log (P3 / D37): ${runDayKeys.length} active day(s) since ${RUN_LOG_FROM}; totals ${JSON.stringify(runTotals)}`);

await closePool();
