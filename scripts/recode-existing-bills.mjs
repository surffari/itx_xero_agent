import "dotenv/config";
import { createHash } from "node:crypto";
import { closePool } from "../src/db/mysql.js";
import { config } from "../src/config.js";
import { XeroWriteClient } from "../src/xero/write-client.js";

// Recodes the 8 live Xero DRAFT bills created 2026-09-10 (before the R28 account-coding
// fix existed) off 850/NONE onto the approved account + VAT mapping confirmed in the
// read-only review logged at Q7 (PLAN.md). Explicitly approved by Kayne: "Recode #23,
// #24, #32, #34, #35, #38, #39, #40 via updateInvoiceCoding". Only recodes — never
// voids, approves, or creates a new bill. Each bill's current status is re-checked
// (DRAFT/SUBMITTED only) by updateInvoiceCoding itself before any write.

const tenantId = config.XERO_TENANT_ID;
const writeClient = new XeroWriteClient();

function shortHash(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

const RECODES = {
  23: { invoiceId: "5a09230d-cf9c-47d8-8657-a1a4e4465c08", accountCode: "453", taxCode: "TAX057" },
  24: { invoiceId: "74633598-5cfe-4a41-b1ee-a6123aca49c7", accountCode: "485", taxCode: "TAX023" },
  32: { invoiceId: "4126a9d3-8061-467c-bdfa-d032c14de59e", accountCode: "453", taxCode: "TAX057" },
  34: { invoiceId: "9f8b815e-17c4-471f-bf9a-8b3beb68c95a", accountCode: "480", taxCode: "TAX023" },
  35: { invoiceId: "060d076a-4905-49da-a2eb-b7c9f9b560bc", accountCode: "480", taxCode: "TAX023" },
  38: { invoiceId: "fda1e5d0-fa4f-4c7b-8610-eb423703d78f", accountCode: "480", taxCode: "TAX023" },
  39: { invoiceId: "7e0f6ef4-311f-4fab-974f-fe16f9b3743e", accountCode: "425", taxCode: "TAX021" },
  40: { invoiceId: "e6bd95ec-7fc6-448b-8c51-8f0d3163be66", accountCode: "480", taxCode: "TAX023" },
};

const idsToProcess = process.argv.slice(2).map(Number);
if (idsToProcess.length === 0) {
  console.error("usage: node --import tsx scripts/recode-existing-bills.mjs <id> [id...]");
  process.exit(1);
}

for (const id of idsToProcess) {
  const r = RECODES[id];
  if (!r) { console.log(`SKIP #${id}: not on the approved recode list — refusing.`); continue; }

  // Includes a per-run nonce: updateInvoiceCoding sets fixed field values on an existing,
  // already-identified invoice, so a duplicate call is a safe no-op (unlike createBill,
  // which must stay purely input-derived to prevent duplicate bill creation). A per-run
  // nonce lets retries proceed after Xero's own idempotency store rejects key reuse with
  // a differently-shaped payload (e.g. after the 2026-09-14 UnitAmount/Description fix).
  const idempotencyKey = `recode-bill:${shortHash(`${tenantId}:${r.invoiceId}:${r.accountCode}:${r.taxCode}:${Date.now()}`)}`;
  console.log(`#${id}: recoding ${r.invoiceId} -> AccountCode=${r.accountCode} TaxType=${r.taxCode}`);

  try {
    const result = await writeClient.updateInvoiceCoding(
      tenantId,
      r.invoiceId,
      r.accountCode,
      r.taxCode,
      idempotencyKey,
      false
    );
    console.log(`OK #${id}: recoded. New LineItems:`, JSON.stringify(result.LineItems?.map(l => ({ AccountCode: l.AccountCode, TaxType: l.TaxType }))));
  } catch (err) {
    console.log(`FAIL #${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await closePool();
