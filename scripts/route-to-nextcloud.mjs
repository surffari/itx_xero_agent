#!/usr/bin/env node
// Bills Management P2-02/P2-03 groundwork, run early at Kayne's explicit request for a
// Nextcloud-based review: places every real mailbox_invoice_files document's actual PDF
// into the matching /Xero-Bills status subfolder (D10), based on the CURRENT routing
// result (routeMailboxFile, same logic already reviewed in P1-02/P1-03/Q9). Read-only
// against IMAP (MailboxClient, EXAMINE mode) and against Xero (nothing here calls
// XeroWriteClient at all — no bill is created, recoded, voided, or approved). The only
// writes are: (1) new files uploaded to Nextcloud via the dedicated xero-agent WebDAV
// account, (2) one single-row DB correction for #23 (see below), logged before it runs.
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { config, requireMailboxConfig } from "../src/config.js";
import { MailboxClient } from "../src/email/imap-client.js";
import { routeMailboxFile } from "../src/bills/routing.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
import { syncReviewLog } from "../src/bills/review-log.js";
import { writeFile, mkdir } from "node:fs/promises";

const tenantId = config.XERO_TENANT_ID ?? "";
const mailboxClient = new MailboxClient(requireMailboxConfig());
const nextcloud = new NextcloudWebDavClient();

const FOLDER = {
  incoming: "📥 01 - Incoming",
  needs_review: "⚠️ 02 - Needs Review",
  ready_for_xero: "✅ 03 - Ready for Xero",
  uploaded_to_xero: "📤 04 - Uploaded to Xero",
  exceptions: "🚨 05 - Exceptions",
};

async function queryFn(sql, args) {
  return query(sql, args);
}

// Only #6's real, human-reviewed invoice facts are supplied (its VAT treatment is
// genuinely undetermined — this gives it a specific reason instead of the generic
// "no facts supplied" one). Every other document's routing is computed purely from
// what's actually in the DB right now — no facts are invented for anything else.
const KNOWN_FACTS = {
  6: { supplierName: "OnlineJobs.ph", supplierCountryIso: "US", description: "Monthly recruiting platform fee", explicitVatRatePct: 21, reverseChargeStated: false },
};

console.log("=== Bills Management: routing all real documents to /Xero-Bills for review ===\n");

// Live folder location per document id, BEFORE anything is touched — the authoritative
// record of where each document actually sits right now, including manual/real-PDF-review
// classifications that were only ever reflected in Nextcloud and never persisted to
// bills_status (a known upstream gap, Q5/D12). Read this before recomputing anything: a
// 2026-09-15 incident showed that trusting a fresh routeMailboxFile() recompute over this
// creates duplicate copies — the mechanical logic has no way to see a manual classification
// that was never written back to the DB.
const liveLocationById = {};
for (const [status, folder] of Object.entries(FOLDER)) {
  const files = await nextcloud.listFolder(folder);
  for (const f of files) {
    const id = parseInt(f.split("_")[0], 10);
    if (!Number.isNaN(id)) liveLocationById[id] = status;
  }
}

const rows = await query(
  `SELECT id, uid, attachment_filename, status, matched_invoice_id,
          extracted_supplier, extracted_amount, extracted_currency, extracted_date,
          bills_status, bills_status_reason
   FROM mailbox_invoice_files
   ORDER BY id`
);

const manifest = [];
const skipped = [];
for (const r of rows) {
  let bills_status;
  let reason;

  // A manually-corrected row (bills_status already persisted as something other than the
  // 'incoming' default — e.g. #23/D16, #48/#57/#58/#59 corrected 2026-09-15) always wins
  // over a fresh mechanical recompute. routeMailboxFile has no way to know about a human
  // decision that isn't derivable from matched_invoice_id/extracted_* alone (a voided
  // duplicate, a supplier-specific coding call, a confirmed invoice-date convention) — so
  // trust the persisted correction instead of silently overwriting it on every re-run.
  const trusted = Boolean(r.bills_status && r.bills_status !== "incoming");
  if (trusted) {
    bills_status = r.bills_status;
    reason = r.bills_status_reason;
  } else {
    const result = await routeMailboxFile(
      {
        id: r.id, status: r.status, matched_orphan_id: null, matched_invoice_id: r.matched_invoice_id,
        extracted_supplier: r.extracted_supplier, extracted_amount: r.extracted_amount,
        extracted_currency: r.extracted_currency, extracted_date: r.extracted_date,
      },
      { tenantId, reference: null, invoiceNumber: null, queryFn, invoiceFacts: KNOWN_FACTS[r.id] }
    );
    bills_status = result.bills_status;
    reason = result.bills_status_reason;
  }

  // Safety net for the 2026-09-15 incident: a document that already lives somewhere in
  // Nextcloud, whose *untrusted* mechanical recompute disagrees with that live location,
  // is never touched — it's skipped with a loud warning instead of silently duplicated.
  // Only an already-correct placement (no-op) or a genuinely new/untracked document
  // proceeds automatically; only a *trusted* (DB-persisted) correction is allowed to move
  // an existing document to a new folder.
  const currentLocation = liveLocationById[r.id];
  if (currentLocation !== undefined && currentLocation !== bills_status && !trusted) {
    skipped.push({ id: r.id, currentLocation, computed: bills_status });
    continue;
  }

  manifest.push({
    id: r.id,
    uid: r.uid,
    attachment_filename: r.attachment_filename,
    bills_status,
    reason,
    folder: FOLDER[bills_status],
    currentLocation,
  });
}

if (skipped.length > 0) {
  console.log(`\n⚠️  SKIPPED ${skipped.length} document(s) — already live in a different folder than an\nunpersisted mechanical recompute suggests. Not touched (see D-2026-09-15 incident):`);
  for (const s of skipped) {
    console.log(`   #${s.id}: currently in "${s.currentLocation}", recomputes to "${s.computed}" — needs bills_status persisted before this can move it`);
  }
  console.log("");
}

const counts = {};
for (const m of manifest) counts[m.bills_status] = (counts[m.bills_status] ?? 0) + 1;
console.log("Computed routing counts:", JSON.stringify(counts));

// Back up the manifest BEFORE touching Nextcloud, per the standing "back up before
// risky changes" rule (explicitly names Nextcloud batch-move).
const backupDir = "/opt/projects/gopure/bills_management/backups";
await mkdir(backupDir, { recursive: true });
const backupPath = `${backupDir}/nextcloud_route_manifest_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(backupPath, JSON.stringify(manifest, null, 2), "utf8");
console.log(`Backed up manifest (${manifest.length} rows) -> ${backupPath}\n`);

let uploaded = 0;
let moved = 0;
let skippedNoop = 0;
let failed = 0;
for (const m of manifest) {
  const targetName = `${m.id}_${m.attachment_filename}`;
  try {
    if (m.currentLocation === m.bills_status) {
      // Already correctly placed — no-op, don't waste an IMAP round trip re-fetching it.
      skippedNoop++;
      continue;
    }
    if (m.currentLocation !== undefined) {
      // A trusted correction that needs to relocate an existing file — WebDAV MOVE, not a
      // fresh IMAP download + PUT (faster, and never creates a stray duplicate).
      await nextcloud.moveFile(`${FOLDER[m.currentLocation]}/${targetName}`, `${m.folder}/${targetName}`);
      console.log(`MOVED #${m.id}: ${FOLDER[m.currentLocation]} -> ${m.folder}/${targetName}`);
      moved++;
      continue;
    }
    // Genuinely new/untracked document — first placement.
    const buffer = await mailboxClient.downloadAttachment(Number(m.uid), m.attachment_filename);
    await nextcloud.uploadFile(`${m.folder}/${targetName}`, buffer);
    console.log(`OK   #${m.id} -> ${m.folder}/${targetName}`);
    uploaded++;
  } catch (err) {
    console.log(`FAIL #${m.id} -> ${m.folder}/${targetName}: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\nUploaded ${uploaded} new, moved ${moved}, already correct ${skippedNoop}, failed ${failed} (of ${manifest.length}; ${skipped.length} skipped above as unsafe)`);

console.log("\n=== Live folder verification (PROPFIND, not trusting upload return values) ===");
for (const [status, folder] of Object.entries(FOLDER)) {
  const children = await nextcloud.listFolder(folder);
  console.log(`${folder}: ${children.length} file(s)`);
}

// Keep the shared "Documents Review Log.xlsx" in sync with wherever files actually ended
// up. Never touches the Reviewed By/Review Date/Outcome columns — those are Kayne's/Jani's
// human review trail, edited only by hand (see src/bills/review-log.ts).
console.log("\n=== Syncing Documents Review Log.xlsx ===");
const syncResult = await syncReviewLog(nextcloud, query);
console.log(`Backed up previous workbook -> ${syncResult.backupPath}`);
if (syncResult.updatedIds.length > 0) {
  console.log(`Updated rows: ${syncResult.updatedIds.map((id) => `#${id}`).join(", ")}`);
}
if (syncResult.addedIds.length > 0) {
  console.log(`Added rows (Invoice/Supplier blank — no PDF-read data available here): ${syncResult.addedIds.map((id) => `#${id}`).join(", ")}`);
}
console.log(`${syncResult.changed} row(s) updated, ${syncResult.added} row(s) added, ${syncResult.unchanged} unchanged.`);

await mailboxClient.close?.();
await closePool();
