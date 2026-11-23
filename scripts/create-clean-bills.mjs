import "dotenv/config";
import { createHash } from "node:crypto";
import { query, execute, closePool } from "../src/db/mysql.js";
import { config, requireMailboxConfig } from "../src/config.js";
import { MailboxClient } from "../src/email/imap-client.js";
import { XeroWriteClient } from "../src/xero/write-client.js";
import { markUploadedAfterDraftCreated } from "../src/bills/apply-status.js";
import { determineAccountAndTax } from "../src/bills/account-coding.js";

const tenantId = config.XERO_TENANT_ID;
const writeClient = new XeroWriteClient();
const mailboxClient = new MailboxClient(requireMailboxConfig());

function shortHash(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

// Only the documents Kayne explicitly approved as "clean" on 2026-09-10.
// #12 (duplicate), #31 (needs review), #33/#48/#50 (flagged) are deliberately excluded.
// #6 (OnlineJobs.ph) was REMOVED from this list on 2026-09-10 after the account-coding
// fix: its VAT treatment cannot be confidently determined (non-EU platform, explicit 21%
// shown, no rule-register match) — it now correctly requires Needs Review, not a guess.
const idsToProcess = process.argv.slice(2).map(Number);
if (idsToProcess.length === 0) {
  console.error("usage: node --import tsx scripts/create-clean-bills.mjs <id> [id...]");
  process.exit(1);
}

const APPROVED = {
  9:  { supplier: "FrontApp, Inc.", amount: 58.00, currency: "USD", date: "2026-08-07", ref: "CD25D786-0048",
        facts: { supplierName: "FrontApp, Inc.", supplierCountryIso: "US", description: "Front Starter Plan subscription", explicitVatRatePct: null, reverseChargeStated: false } },
  23: { supplier: "Easystart Office Amsterdam B.V.", amount: 95.59, currency: "EUR", date: "2026-06-22", ref: "ESA 7500",
        facts: { supplierName: "Easystart Office Amsterdam B.V.", supplierCountryIso: "NL", description: "Registratieadres KvK", explicitVatRatePct: 21, reverseChargeStated: false } },
  24: { supplier: "FrontApp, Inc.", amount: 58.00, currency: "USD", date: "2026-07-07", ref: "CD25D786-0047",
        facts: { supplierName: "FrontApp, Inc.", supplierCountryIso: "US", description: "Front Starter Plan subscription", explicitVatRatePct: null, reverseChargeStated: false } },
  32: { supplier: "Easystart Office Amsterdam B.V.", amount: 95.59, currency: "EUR", date: "2026-08-22", ref: "ESA 7908",
        facts: { supplierName: "Easystart Office Amsterdam B.V.", supplierCountryIso: "NL", description: "Registratieadres KvK", explicitVatRatePct: 21, reverseChargeStated: false } },
  34: { supplier: "Kayne Joelle Pecha", amount: 70.00, currency: "USD", date: "2026-08-24", ref: "INV-717897",
        facts: { supplierName: "Kayne Joelle Pecha", supplierCountryIso: "PH", description: "Bookkeeping & accounting support", explicitVatRatePct: null, reverseChargeStated: false, entityType: "individual" } },
  35: { supplier: "Keith Nicole V. Sarsaba", amount: 58.00, currency: "USD", date: "2026-08-24", ref: "INV-KNS-2026-004",
        facts: { supplierName: "Keith Nicole V. Sarsaba", supplierCountryIso: "PH", description: "Customer service", explicitVatRatePct: null, reverseChargeStated: false, entityType: "individual" } },
  38: { supplier: "Kayne Joelle Pecha", amount: 70.00, currency: "USD", date: "2026-08-31", ref: "INV - 338800",
        facts: { supplierName: "Kayne Joelle Pecha", supplierCountryIso: "PH", description: "Bookkeeping & accounting support", explicitVatRatePct: null, reverseChargeStated: false, entityType: "individual" } },
  39: { supplier: "DirectLing Trade UG", amount: 440.00, currency: "EUR", date: "2026-08-28", ref: "RE-1009",
        facts: { supplierName: "DirectLing Trade UG", supplierCountryIso: "DE", description: "Shipping costs", explicitVatRatePct: null, reverseChargeStated: true } },
  40: { supplier: "Keith Nicole V. Sarsaba", amount: 56.00, currency: "USD", date: "2026-08-31", ref: "INV-KNS-2026-006",
        facts: { supplierName: "Keith Nicole V. Sarsaba", supplierCountryIso: "PH", description: "Customer service", explicitVatRatePct: null, reverseChargeStated: false, entityType: "individual" } },
};

for (const id of idsToProcess) {
  const d = APPROVED[id];
  if (!d) { console.log(`SKIP #${id}: not on the approved "clean" list — refusing.`); continue; }

  const coding = determineAccountAndTax(d.facts, null);
  if (!coding.confident) {
    console.log(`SKIP #${id}: account/VAT treatment not confidently determined — ${coding.reason}. Refusing to default to 850/Tax Exempt.`);
    continue;
  }

  const rows = await query(`SELECT id, uid, attachment_filename FROM mailbox_invoice_files WHERE id=?`, [id]);
  const file = rows[0];
  if (!file) { console.log(`SKIP #${id}: not found in mailbox_invoice_files`); continue; }

  const payload = {
    Type: "ACCPAY",
    Contact: { Name: d.supplier },
    Date: d.date,
    DueDate: d.date,
    LineAmountTypes: "Inclusive",
    CurrencyCode: d.currency,
    LineItems: [{ Description: d.supplier, Quantity: 1, UnitAmount: d.amount, AccountCode: coding.accountCode, TaxType: coding.taxCode }],
    Reference: d.ref,
  };
  const idempotencyKey = `mailbox-bill:${shortHash(`${tenantId}:${id}:${d.ref ?? ""}:${d.date}:${d.amount}:${d.currency}`)}`;
  console.log(`#${id}: coding ${coding.accountCode}/${coding.taxCode} — ${coding.reason}`);

  try {
    const created = await writeClient.createBill(tenantId, payload, idempotencyKey, d.ref ?? `MAILBOX:${id}`, false);
    console.log(`OK #${id}: Xero DRAFT bill created, InvoiceID=${created.InvoiceID}`);

    try {
      const buffer = await mailboxClient.downloadAttachment(Number(file.uid), file.attachment_filename);
      await writeClient.attachPdf(tenantId, created.InvoiceID, file.attachment_filename, buffer, false);
      console.log(`   attachment attached`);
    } catch (attachErr) {
      console.log(`   WARNING: bill created but attachment failed: ${attachErr.message}`);
    }

    await execute(
      `UPDATE mailbox_invoice_files
       SET status='matched', extracted_supplier=?, extracted_amount=?, extracted_currency=?, extracted_date=?, matched_invoice_id=?
       WHERE id=?`,
      [d.supplier, d.amount, d.currency, d.date, created.InvoiceID, id]
    );
    await markUploadedAfterDraftCreated(
      id,
      created.InvoiceID,
      { execute },
      true,
      { accountCode: coding.accountCode, taxCode: coding.taxCode }
    );
    console.log(`   mailbox_invoice_files updated (status=matched, bills_status=uploaded_to_xero)`);
  } catch (err) {
    console.log(`FAIL #${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await mailboxClient.close?.();
await closePool();
