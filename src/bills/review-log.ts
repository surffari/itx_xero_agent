// Bills Management: keeps the shared "Documents Review Log.xlsx" (Nextcloud /Xero-Bills
// root) in sync with reality after any routing run moves documents between folders.
// Re-derives each document's Status from its actual live Nextcloud folder (authoritative)
// and Reason from mailbox_invoice_files.bills_status_reason, updates only rows whose
// status actually changed, and re-uploads.
//
// Hard rule (Kayne, 2026-09-15): this must NEVER write to the Reviewed By, Review Date, or
// Outcome columns (H/I/J) — those are the human review trail, edited only by hand. It only
// touches No./Doc #/Invoice/Supplier/Status/Reason/Flagged Date (A-G), and only on rows
// whose computed Status differs from what's already in the sheet.
import ExcelJS from "exceljs";
import { writeFile, mkdir } from "node:fs/promises";
import type { NextcloudWebDavClient } from "../nextcloud/webdav-client.js";

const WORKBOOK_PATH = "Documents Review Log.xlsx";
const SHEET_NAME = "Review Log";
const HEADER_ROW = 4;
const HUMAN_COLUMNS = [8, 9, 10]; // Reviewed By, Review Date, Outcome — never written here

const FOLDER: Record<string, string> = {
  incoming: "📥 01 - Incoming",
  needs_review: "⚠️ 02 - Needs Review",
  ready_for_xero: "✅ 03 - Ready for Xero",
  uploaded_to_xero: "📤 04 - Uploaded to Xero",
  exceptions: "🚨 05 - Exceptions",
};
const STATUS_LABEL: Record<string, string> = {
  ready_for_xero: "Ready for Xero",
  needs_review: "Needs Review",
  exceptions: "Exception",
  uploaded_to_xero: "Uploaded to Xero",
  incoming: "Incoming",
};

export interface SyncReviewLogResult {
  changed: number;
  unchanged: number;
  added: number;
  updatedIds: number[];
  addedIds: number[];
  backupPath: string;
}

/**
 * Syncs the shared review-log workbook to the current live state. Safe to call after any
 * routing run that moved files between Nextcloud status folders — a no-op (no re-upload)
 * if nothing actually changed.
 *
 * `newRowInfo` supplies Invoice/Supplier text for documents being appended as brand-new
 * rows (never previously in the sheet) — pass real extracted values when the caller has
 * them (from reading the actual PDF), since the sheet itself has no source for those
 * fields. Appended rows leave Reviewed By/Review Date/Outcome blank, same as every other
 * row this function ever writes.
 */
export async function syncReviewLog(
  nc: NextcloudWebDavClient,
  queryFn: (sql: string, args?: unknown[]) => Promise<Array<{ id: number; bills_status_reason: string | null }>>,
  newRowInfo: Record<number, { invoice: string; supplier: string }> = {}
): Promise<SyncReviewLogResult> {
  const locationByFileId: Record<number, string> = {};
  for (const [status, folder] of Object.entries(FOLDER)) {
    const files = await nc.listFolder(folder);
    for (const f of files) {
      const id = parseInt(f.split("_")[0], 10);
      if (!Number.isNaN(id)) locationByFileId[id] = status;
    }
  }

  const rows = await queryFn(`SELECT id, bills_status_reason FROM mailbox_invoice_files ORDER BY id`);
  const reasonById = Object.fromEntries(rows.map((r) => [r.id, r.bills_status_reason]));

  const currentBytes = await nc.downloadFile(WORKBOOK_PATH);
  await mkdir("/opt/projects/gopure/bills_management/backups", { recursive: true });
  const backupPath = `/opt/projects/gopure/bills_management/backups/review_log_before_sync_${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.xlsx`;
  await writeFile(backupPath, currentBytes);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(currentBytes) as unknown as ArrayBuffer);
  const sheet = wb.getWorksheet(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" not found in ${WORKBOOK_PATH}`);

  const todayIso = new Date().toISOString().slice(0, 10);
  let changed = 0;
  let unchanged = 0;
  const updatedIds: number[] = [];
  const seenIds = new Set<number>();
  let lastRowNumber = HEADER_ROW;
  let lastNo = 0;

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > lastRowNumber) lastRowNumber = rowNumber;
    if (rowNumber <= HEADER_ROW) return;
    const noCell = row.getCell(1).value;
    if (typeof noCell === "number" && noCell > lastNo) lastNo = noCell;

    const docCell = row.getCell(2).value;
    if (typeof docCell !== "string" || !docCell.startsWith("#")) return;
    const id = parseInt(docCell.slice(1), 10);
    if (Number.isNaN(id)) return;
    seenIds.add(id);

    const liveStatus = locationByFileId[id];
    if (!liveStatus) return;

    const newLabel = STATUS_LABEL[liveStatus];
    const currentLabel = row.getCell(5).value;
    if (currentLabel === newLabel) {
      unchanged++;
      return;
    }

    row.getCell(5).value = newLabel; // Status
    const newReason = reasonById[id];
    if (newReason) row.getCell(6).value = newReason; // Reason
    row.getCell(7).value = todayIso; // Flagged Date

    // explicit guard: never touch the human review columns
    for (const c of HUMAN_COLUMNS) void row.getCell(c);

    changed++;
    updatedIds.push(id);
  });

  // Append a brand-new row for any document that's live in Nextcloud but was never in the
  // sheet at all (e.g. a document that arrived after the workbook was last rebuilt). Only
  // the same seven columns this function ever writes are populated — Reviewed By/Review
  // Date/Outcome stay blank, exactly like every row a human hasn't reviewed yet.
  const added: number[] = [];
  const liveIds = Object.keys(locationByFileId).map(Number).sort((a, b) => a - b);
  for (const id of liveIds) {
    if (seenIds.has(id)) continue;
    lastNo += 1;
    const info = newRowInfo[id];
    const row = sheet.getRow(lastRowNumber + 1 + added.length);
    row.getCell(1).value = lastNo;
    row.getCell(2).value = `#${id}`;
    row.getCell(3).value = info?.invoice ?? "";
    row.getCell(4).value = info?.supplier ?? "";
    row.getCell(5).value = STATUS_LABEL[locationByFileId[id]];
    row.getCell(6).value = reasonById[id] ?? "";
    row.getCell(7).value = todayIso;
    row.commit();
    added.push(id);
  }

  if (changed > 0 || added.length > 0) {
    const buffer = await wb.xlsx.writeBuffer();
    await nc.uploadFile(
      WORKBOOK_PATH,
      Buffer.from(buffer as ArrayBuffer),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  }

  return { changed, unchanged, added: added.length, updatedIds, addedIds: added, backupPath };
}
