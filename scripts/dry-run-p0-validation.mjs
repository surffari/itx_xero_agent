#!/usr/bin/env node
// Read-only validation dry run of the P0-1..P0-4 guards as wired into
// create_bill_from_mailbox_file, against 11 real historical Bills Management mailbox
// documents. Calls the guard functions and determineAccountAndTax directly -- never
// inboxWriteClient, never xero_write_log, never Xero. Zero writes anywhere.
import "dotenv/config";
import { query, closePool } from "../src/db/mysql.js";
import { config } from "../src/config.js";
import { checkCuroDocument } from "../src/bills/curo-document-guard.js";
import { checkDuplicate } from "../src/bills/routing.js";
import { checkAccountCodeForBill } from "../src/bills/account-code-guard.js";
import { resolveContactForBill } from "../src/bills/contact-resolution-guard.js";
import { determineAccountAndTax } from "../src/bills/account-coding.js";

const TENANT = config.XERO_TENANT_ID;

// Real documents, real facts -- as read from the actual PDFs / mailbox_invoice_files rows
// this session. Where a fact wasn't independently re-verified for this exercise, it's
// marked unverified rather than guessed.
const CASES = [
  {
    mailboxId: 83, filename: "Statement S269.19578.210521970.pdf", supplier: "CURO Payments B.V.",
    amount: 82.50, currency: "EUR", date: "2026-09-18", reference: "S269.19578.210521970", invoiceNumber: null,
    facts: null,
  },
  {
    mailboxId: 84, filename: "Invoice C269.19578.210521970.pdf", supplier: "CURO Payments B.V.",
    amount: 2.30, currency: "EUR", date: "2026-09-18", reference: "C269.19578.210521970", invoiceNumber: null,
    facts: null,
  },
  {
    mailboxId: 85, filename: "Settlement R269.19578.210521970.pdf", supplier: "CURO Payments B.V.",
    amount: 80.20, currency: "EUR", date: "2026-09-18", reference: "R269.19578.210521970", invoiceNumber: null,
    facts: null,
  },
  {
    mailboxId: 11, filename: "Invoice-Q2IYL8NI-0009.pdf", supplier: "Anthropic, PBC",
    amount: 18.00, currency: "EUR", date: "2026-08-05", reference: null, invoiceNumber: "Q2IYL8NI-0009",
    facts: { supplierName: "Anthropic, PBC", supplierCountryIso: "US", description: "Claude Pro subscription",
      explicitVatRatePct: null, reverseChargeStated: false, entityType: "company" },
  },
  {
    mailboxId: 8, filename: "Inv707545 Kayne.pdf", supplier: "Kayne Joelle Pecha",
    amount: 70.00, currency: "USD", date: "2026-08-10", reference: null, invoiceNumber: "INV-707545",
    facts: { supplierName: "Kayne Joelle Pecha", supplierCountryIso: "PH", description: "Bookkeeping & Accounting Support and Stock & Operations Management",
      explicitVatRatePct: null, reverseChargeStated: false, entityType: "individual" },
  },
  {
    mailboxId: 22, filename: "ESA 7695.pdf", supplier: "Easystart Office Amsterdam B.V.",
    amount: 95.59, currency: "EUR", date: "2026-07-22", reference: "ESA 7695", invoiceNumber: null,
    facts: { supplierName: "Easystart Office Amsterdam B.V.", supplierCountryIso: "NL", description: "Registratieadres KvK",
      explicitVatRatePct: 21, reverseChargeStated: false, entityType: "company" },
  },
  {
    mailboxId: 41, filename: "DigitalOcean Invoice 2026 Aug (80395-2278000).pdf", supplier: "DigitalOcean LLC",
    amount: 66.50, currency: "USD", date: "2026-09-01", reference: "2278000", invoiceNumber: null,
    facts: { supplierName: "DigitalOcean LLC", supplierCountryIso: null, description: "Cloud hosting",
      explicitVatRatePct: null, reverseChargeStated: false, entityType: "company" },
    factsNote: "supplierCountryIso/VAT not independently re-verified this session -- original PDF not re-read for this exercise",
  },
  {
    mailboxId: 53, filename: "Nicole - Invoice 6.pdf", supplier: "Keith Nicole V. Sarsaba",
    amount: 56.00, currency: "USD", date: "2026-08-31", reference: null, invoiceNumber: "INV-KNS-2026-006",
    facts: { supplierName: "Keith Nicole V. Sarsaba", supplierCountryIso: "PH", description: "Customer Service",
      explicitVatRatePct: null, reverseChargeStated: false, entityType: "individual" },
  },
  {
    mailboxId: 43, filename: "INVOICE 487 - Green Gooddess Consulting - 3,000.00 EUR.pdf", supplier: "Green Gooddess Consulting",
    amount: 3000.00, currency: "EUR", date: "2026-09-10", reference: "487", invoiceNumber: null,
    facts: null,
    skipCoding: "SUPPLIER LEGITIMACY CONCERN already on file (garbled VAT number, address matches Intactix's own) -- not a coding question, coding is irrelevant until the supplier itself is verified.",
  },
  {
    mailboxId: 86, filename: "P2026098.pdf", supplier: "Tax and Law Spain (Erica Eced)",
    amount: 75.00, currency: "EUR", date: "2026-09-21", reference: "P2026098", invoiceNumber: null,
    facts: { supplierName: "Tax and Law Spain", supplierCountryIso: "ES", description: "Tax report 3rd Quarter 2026 representation, keeping account active, notifications from tax office in Germany",
      explicitVatRatePct: null, reverseChargeStated: true, entityType: "company" },
  },
  {
    mailboxId: 72, filename: "d475303e-b5c3-5a39-ac31-0fd91b179121.pdf", supplier: "Cloudflare, Inc.",
    amount: 25.00, currency: "USD", date: "2026-07-04", reference: "IN-70385484", invoiceNumber: null,
    facts: { supplierName: "Cloudflare, Inc.", supplierCountryIso: null, description: "Cloudflare Pro Plan subscription",
      explicitVatRatePct: null, reverseChargeStated: false, entityType: "company" },
    factsNote: "supplierCountryIso/VAT not independently re-verified this session",
  },
];

const chartAccounts = await query(`SELECT code, name, type, status FROM xero_accounts WHERE tenant_id=? AND code IS NOT NULL`, [TENANT]);
const supplierContacts = await query(`SELECT contact_id, name, status FROM xero_contacts WHERE tenant_id=? AND is_supplier=1`, [TENANT]);

const results = [];

for (const c of CASES) {
  const row = {
    mailboxId: c.mailboxId, filename: c.filename, supplier: c.supplier,
    curo: null, duplicate: null, coding: null, accountCodeGuard: null, contact: null, outcome: null,
  };

  // 1. CURO guard (checked first, categorically, in the real tool)
  const curo = checkCuroDocument(c.supplier, c.filename);
  result_curo: {
    results.push(null); results.pop(); // no-op, keep structure simple
  }
  row.curo = curo.ok ? "n/a (not CURO or allowed)" : curo.reason;
  if (!curo.ok) {
    row.outcome = "Needs Review (CURO standing rule)";
    results.push(row);
    continue;
  }

  // 2. Duplicate check (real DB, read-only)
  const dup = await checkDuplicate(
    { id: c.mailboxId, status: "processing", matched_orphan_id: null, matched_invoice_id: null,
      extracted_supplier: c.supplier, extracted_amount: c.amount, extracted_currency: c.currency, extracted_date: c.date },
    { tenantId: TENANT, reference: c.reference, invoiceNumber: c.invoiceNumber },
    (sql, args) => query(sql, args)
  );
  row.duplicate = dup.result === "duplicate"
    ? `DUPLICATE of ${dup.match?.invoice_number ?? dup.match?.reference ?? dup.reference} (${dup.match?.contact_name}, ${dup.match?.currency_code}${dup.match?.total}, ${dup.match?.status})`
    : dup.result;
  if (dup.result === "duplicate") {
    row.outcome = "Blocked: duplicate (existing bill found)";
    results.push(row);
    continue;
  }

  // 3. Account/VAT coding proposal -- this step is NEVER performed by the real tool itself
  //    (it requires account_code as caller input); shown here to demonstrate what IS and
  //    ISN'T automatically resolvable today.
  if (c.skipCoding) {
    row.coding = c.skipCoding;
    row.outcome = "Needs Review (supplier legitimacy, not a coding question)";
    results.push(row);
    continue;
  }
  const coding = determineAccountAndTax(c.facts, null);
  row.coding = coding.confident
    ? `CONFIDENT: account ${coding.accountCode} (${coding.accountReason}); tax ${coding.taxCode} (${coding.taxReason})`
    : `NOT CONFIDENT: ${coding.reason}` + (c.factsNote ? ` [NOTE: ${c.factsNote}]` : "");

  // 4. Account-code guard -- only meaningful if coding was confident enough to produce a code
  if (coding.accountCode) {
    const acctCheck = checkAccountCodeForBill(coding.accountCode, null, chartAccounts);
    row.accountCodeGuard = acctCheck.ok ? "OK" : acctCheck.reason;
  } else {
    row.accountCodeGuard = "n/a -- no account_code proposed to check";
  }

  // 5. Contact resolution guard (real DB, read-only)
  const contactRes = resolveContactForBill(c.supplier, null, supplierContacts);
  row.contact = contactRes.ok
    ? (contactRes.contactId ? `resolved: ${contactRes.contactId}` : "no match -- would create new contact")
    : contactRes.reason;

  // Final outcome
  if (!coding.confident) {
    row.outcome = "Needs Review (account/VAT coding not confidently resolved)";
  } else if (coding.accountCode && !checkAccountCodeForBill(coding.accountCode, null, chartAccounts).ok) {
    row.outcome = "Needs Review (account-code guard refused)";
  } else if (!contactRes.ok) {
    row.outcome = "Needs Review (contact ambiguous)";
  } else {
    row.outcome = "WOULD DRAFT";
  }
  results.push(row);
}

console.log(JSON.stringify(results, null, 2));
await closePool();
