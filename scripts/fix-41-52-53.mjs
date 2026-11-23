#!/usr/bin/env node
// Bills Management: pulled 3 documents out of "upload the rest of the batch"
// (2026-09-24) after real-PDF review + live Xero cross-check surfaced problems that
// would have created real duplicate/double-billed Xero bills:
// - #41: same invoice as #75 (DigitalOcean/Cloudways #2278000, $66.50, Sep 1 2026) --
//   #75 was already drafted in Xero this session (InvoiceID 0ac7781d-...). #41 is the
//   direct-forward copy of the same invoice #75 got from the Cloudways portal.
// - #53: "INV-KNS-2026-006" $56 Aug 31 2026 is already a live AUTHORISED Xero bill
//   (bill_id e6bd95ec-7fc6-448b-8c51-8f0d3163be66) for Keith Nicole V. Sarsaba -- exact
//   amount/date/invoice-number match.
// - #52: same billing period (Aug 31-Sep 6) and same issue date (Sep 7) as #66, which
//   was already drafted this session (InvoiceID 4f61ca82-...), but a different invoice
//   number (883668 vs 850884) and a different amount ($76.18 vs $70.00). Looks like a
//   corrected resend of the same week's work, not two real invoices -- held for Kayne
//   to say which figure is right, not guessed.
import "dotenv/config";
import { execute, closePool } from "../src/db/mysql.js";
import { applyBillsStatus } from "../src/bills/apply-status.js";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";

const nextcloud = new NextcloudWebDavClient();
const READY_FOR_XERO = "✅ 03 - Ready for Xero";
const NEEDS_REVIEW = "⚠️ 02 - Needs Review";
const EXCEPTIONS = "🚨 05 - Exceptions";

const moves = [
  {
    id: 52, filename: "KAYNE JOELLE PECHA– INVOICE 883668 - Invoice Template.pdf", to: NEEDS_REVIEW,
    result: {
      bills_status: "needs_review",
      bills_status_reason: "Possible corrected resend of #66 (already drafted this session, InvoiceID 4f61ca82-b7ed-4904-9559-df1cc18d028c): same issue date (Sep 7 2026) and same billing period (Aug 31-Sep 6) as #66, but different invoice number (883668 vs 850884) and different amount ($76.18 vs $70.00, more precise hours: 21h46m vs a flat 20h). Not uploaded -- held for Kayne to confirm which figure is correct before either is touched further.",
      duplicate_check_result: "not_checked",
      duplicate_check_reference: "4f61ca82-b7ed-4904-9559-df1cc18d028c",
      account_code: null, tax_code: null,
    },
  },
];

console.log("=== Correcting #41, #52, #53 before uploading the rest of the batch ===\n");
for (const m of moves) {
  await applyBillsStatus(m.id, m.result, { execute }, true);
  await nextcloud.moveFile(`${READY_FOR_XERO}/${m.id}_${m.filename}`, `${m.to}/${m.id}_${m.filename}`);
  console.log(`#${m.id}: Ready for Xero -> ${m.to}`);
}

await closePool();
