// Bills Management: account-code and VAT/tax-treatment determination for supplier bills.
// Encodes the approved account mapping and VAT SOP (knowledge/rule-register.md, IAR-003
// through IAR-010) as an explicit, cited decision — never a silent default. If neither a
// verified supplier profile nor a rule-register pattern confidently resolves BOTH the
// account code and the tax treatment, this returns confident:false, and the caller must
// route to Needs Review rather than fall back to 850 Suspense / Tax Exempt.
//
// This never calls Xero and never reads the database itself — it is pure decision logic
// over facts the caller supplies (read from the actual invoice, same as extracted_supplier
// etc. in routing.ts). A missing/unsupplied fact is treated as unknown, not as "assume
// the common case" — per the approved VAT rule: never guess.

const INTACTIX_COUNTRY = "NL";

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);

export interface SupplierTaxProfileFacts {
  defaultAccountCode: string | null;
  defaultTaxCode: string | null;
  confidence: number; // 0-1, matches supplier_tax_profiles.confidence
}

export interface InvoiceFacts {
  supplierName: string;
  supplierCountryIso: string | null; // ISO-2, null if not determinable from the invoice
  description: string; // what the line/service actually is, as read from the invoice
  explicitVatRatePct: number | null; // the rate literally shown on the invoice, if any (e.g. 21, 9, 0)
  reverseChargeStated: boolean; // true only if the invoice ITSELF states reverse charge / self-assessed VAT
  entityType?: "company" | "individual" | "platform";
}

export interface AccountCodingResult {
  confident: boolean;
  accountCode: string | null;
  accountReason: string | null;
  taxCode: string | null;
  taxReason: string | null;
  reason: string; // overall summary — used verbatim as the Needs Review reason when not confident
}

/**
 * Account-code rules from knowledge/rule-register.md (IAR-003 through IAR-010).
 * Deliberately conservative: explicit keyword/entity matches only, each cited to the
 * rule that justifies it. Returns null (not a guess) when nothing matches.
 */
function matchAccountCode(facts: InvoiceFacts): { code: string; reason: string } | null {
  const name = facts.supplierName.toLowerCase();
  const desc = facts.description.toLowerCase();

  // IAR-006: external VAs / contractors / freelancer platforms.
  const contractorMarkers = [
    "onlinejobs", "upwork", "fiverr", "freelanc", "contractor", "virtual assistant",
    "customer service", "bookkeeping", "va service",
  ];
  if (facts.entityType === "individual" || contractorMarkers.some((m) => name.includes(m) || desc.includes(m))) {
    return { code: "480", reason: "IAR-006: external VA/contractor/freelancer costs -> 480 Contractor & Freelance Services" };
  }

  // IAR-005: freight, fulfilment, shipping, courier.
  const freightMarkers = ["shipping", "freight", "courier", "fulfilment", "fulfillment", "dsv", "monta", "stamps.com", "shipstation"];
  if (freightMarkers.some((m) => name.includes(m) || desc.includes(m))) {
    return { code: "425", reason: "IAR-005: freight/courier/shipping costs -> 425 Freight & Courier" };
  }

  // IAR-003/004: raw materials, product/COGS purchases.
  const cogsMarkers = ["raw material", "ecommerce platform development", "product development"];
  if (cogsMarkers.some((m) => desc.includes(m))) {
    return { code: "310", reason: "IAR-003: raw material/product purchase -> 310 Cost of Goods Sold" };
  }

  // IAR-010: recurring SaaS / software subscriptions.
  const subscriptionMarkers = ["subscription", "saas", "software", "hosting", "cloud", "front"];
  if (subscriptionMarkers.some((m) => name.includes(m) || desc.includes(m))) {
    return { code: "485", reason: "IAR-010: recurring software/subscription costs -> 485 Subscriptions & Services" };
  }

  // Office/compliance costs (registered address, KvK, compliance fees).
  const complianceMarkers = ["registratieadres", "kvk", "registered address", "compliance"];
  if (complianceMarkers.some((m) => desc.includes(m))) {
    return { code: "453", reason: "IAR-010 pattern: office/compliance costs -> 453 Office & Compliance Costs" };
  }

  return null;
}

/**
 * VAT/tax-treatment determination — the approved domestic/EU/non-EU procedure:
 *   1. Domestic (NL->NL): use the rate actually shown on the invoice.
 *   2. EU cross-border: only Reverse Charge if the invoice explicitly states it.
 *   3. Non-EU: never automatically Reverse Charge or Tax Exempt — only a cited SOP match.
 *   4. Anything else: undetermined, not a guess.
 */
function determineTaxCode(facts: InvoiceFacts): { code: string; reason: string } | null {
  const isDomestic = facts.supplierCountryIso === INTACTIX_COUNTRY;
  const isEu = facts.supplierCountryIso !== null && EU_COUNTRIES.has(facts.supplierCountryIso);

  // Rule 2 / Rule 3: explicit reverse charge stated and supported by the invoice itself.
  if (facts.reverseChargeStated) {
    return { code: "TAX021", reason: "Invoice explicitly states reverse charge -> self-assessed EU/cross-border VAT (TAX021)" };
  }

  // Rule 1: domestic NL invoice with an explicit rate shown.
  if (isDomestic && facts.explicitVatRatePct != null) {
    if (facts.explicitVatRatePct === 21) {
      return { code: "TAX057", reason: "Domestic NL invoice, explicit 21% VAT shown -> NL Standard VAT (TAX057)" };
    }
    // Only the 21% domestic rate has a confirmed Xero purchase-tax-code precedent in the
    // rule register today. A different rate shown is real information, not nothing — but
    // without a verified code for it, this is a human decision, not a guess.
    return null;
  }

  // Rule 3: non-EU, nothing charged, no reverse charge stated — only a cited SOP
  // precedent may resolve this (never an automatic non-EU default).
  if (!isEu && facts.explicitVatRatePct == null && !facts.reverseChargeStated) {
    const knownNoVatPattern =
      facts.entityType === "individual" ||
      ["stamps.com", "shipstation", "front", "frontapp"].some((m) => facts.supplierName.toLowerCase().includes(m));
    if (knownNoVatPattern) {
      return {
        code: "TAX023",
        reason: "Non-EU vendor, no VAT shown, matches documented SOP precedent (overseas individual contractor / US SaaS vendor pattern, IAR-005/IAR-006) -> No VAT (TAX023)",
      };
    }
  }

  return null;
}

/**
 * Full account + VAT determination for one supplier bill. A verified, high-confidence
 * supplier_tax_profiles record always wins (it represents an already-confirmed fact, not
 * an inference). Otherwise both the account code AND the tax code must resolve via the
 * cited rule-register patterns above, or this returns confident:false.
 */
export function determineAccountAndTax(
  facts: InvoiceFacts,
  supplierProfile: SupplierTaxProfileFacts | null
): AccountCodingResult {
  if (
    supplierProfile &&
    supplierProfile.confidence >= 0.75 &&
    supplierProfile.defaultAccountCode &&
    supplierProfile.defaultTaxCode
  ) {
    const reason = `Verified supplier_tax_profiles record (confidence ${supplierProfile.confidence})`;
    return {
      confident: true,
      accountCode: supplierProfile.defaultAccountCode,
      accountReason: reason,
      taxCode: supplierProfile.defaultTaxCode,
      taxReason: reason,
      reason: "Matched an existing, verified supplier tax profile",
    };
  }

  const account = matchAccountCode(facts);
  const tax = determineTaxCode(facts);

  if (!account || !tax) {
    const missing = [!account && "account code", !tax && "VAT/tax treatment"].filter(Boolean).join(" and ");
    return {
      confident: false,
      accountCode: account?.code ?? null,
      accountReason: account?.reason ?? null,
      taxCode: tax?.code ?? null,
      taxReason: tax?.reason ?? null,
      reason: `Could not confidently determine ${missing} from the approved account mapping / Tax SOP — never defaulting to 850 or Tax Exempt`,
    };
  }

  return {
    confident: true,
    accountCode: account.code,
    accountReason: account.reason,
    taxCode: tax.code,
    taxReason: tax.reason,
    reason: `${account.reason}; ${tax.reason}`,
  };
}
