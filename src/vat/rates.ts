/**
 * Single source of truth for country → Xero tax type mapping and expected VAT rates.
 *
 * HOW TO USE:
 * - invoice-builder.ts and reconcile/engine.ts import COUNTRY_VAT_RULES from here.
 * - vat/checker.ts uses this for the audit_vat_rates MCP tool.
 * - When Xero gains a new tax rate (e.g., for a country we start selling to):
 *   update taxType to the new Xero TaxType code.
 * - expectedRatePct is seeded from known EU rates but is NOT verified against
 *   official EU sources — treat it as a starting hint, not a compliance oracle.
 *   The audit tool marks reference-rate checks as INFO until the accountant confirms.
 */

export interface CountryVatRule {
  /** Xero account code: "207" EU/domestic online sales, "200" export / non-EU */
  accountCode: string;
  /**
   * Xero TaxType code for this country.
   * null = no Xero tax rate created yet for this country.
   * Checker will raise MISSING_XERO_RATE if PS has orders to a null-taxType country.
   */
  taxType: string | null;
  /** Classification drives account code and whether OSS rules apply. */
  rateCategory: "EU_OSS" | "NL_DOMESTIC" | "EXPORT";
  /**
   * Expected standard VAT rate as a percentage (e.g., 20.0 for 20%).
   * null = unknown / not seeded yet.
   * UNVERIFIED — use as a hint for the agent; do not generate ERROR alerts from this alone.
   * Source and verification date are tracked in knowledge/country-vat.md.
   */
  expectedRatePct: number | null;
}

/** All EU member states + GB (export). Expand when new countries are sold to. */
export const COUNTRY_VAT_RULES: Record<string, CountryVatRule> = {
  // NL domestic (standard NL BTW, separate from OSS)
  NL: { accountCode: "207", taxType: "TAX008", rateCategory: "NL_DOMESTIC", expectedRatePct: 21 },

  // EU OSS — countries with existing Xero tax rates (validated in Phase 1)
  FR: { accountCode: "207", taxType: "TAX005", rateCategory: "EU_OSS", expectedRatePct: 20 },
  DE: { accountCode: "207", taxType: "TAX009", rateCategory: "EU_OSS", expectedRatePct: 19 },
  BE: { accountCode: "207", taxType: "TAX006", rateCategory: "EU_OSS", expectedRatePct: 21 },
  IE: { accountCode: "207", taxType: "TAX018", rateCategory: "EU_OSS", expectedRatePct: 23 },
  SE: { accountCode: "207", taxType: "TAX055", rateCategory: "EU_OSS", expectedRatePct: 25 },
  ES: { accountCode: "207", taxType: "TAX054", rateCategory: "EU_OSS", expectedRatePct: 21 },
  IT: { accountCode: "207", taxType: "TAX047", rateCategory: "EU_OSS", expectedRatePct: 22 },
  PT: { accountCode: "207", taxType: "TAX007", rateCategory: "EU_OSS", expectedRatePct: 23 },
  HU: { accountCode: "207", taxType: "TAX024", rateCategory: "EU_OSS", expectedRatePct: 27 },
  AT: { accountCode: "207", taxType: "TAX048", rateCategory: "EU_OSS", expectedRatePct: 20 },

  // EU OSS — Xero rates confirmed in warehouse (2026-06-21 sync)
  // NOTE: expectedRatePct is intentionally the known EU standard rate even where Xero effective_rate
  // differs (e.g. SK is coded 20% in Xero but actual standard is 23%). Mismatch is caught by audit.
  DK: { accountCode: "207", taxType: "TAX029", rateCategory: "EU_OSS", expectedRatePct: 25 },
  FI: { accountCode: "207", taxType: "TAX032", rateCategory: "EU_OSS", expectedRatePct: 25.5 },
  // EE: two Xero rates exist — TAX060 "VAT On Sales in Estonia" 22%, TAX061 "VAT On Sales in EE STD 24%"
  // Estonia raised from 20%→22% (Jan 2024); may have raised again to 24% in 2025.
  // Leaving null until accountant confirms which rate is current and which taxType to use.
  EE: { accountCode: "207", taxType: null, rateCategory: "EU_OSS", expectedRatePct: 22 },
  PL: { accountCode: "207", taxType: "TAX041", rateCategory: "EU_OSS", expectedRatePct: 23 },
  // CZ: PS orders currently charge 15% and Xero has matching RDC TAX049.
  // TAX028 (21% STD) also exists; use it only if standard-rate CZ orders appear.
  CZ: { accountCode: "207", taxType: "TAX049", rateCategory: "EU_OSS", expectedRatePct: 15 },
  // SK: TAX046 is in Xero but effective_rate is 20.0 — actual SK standard rate is 23% since Jan 2025.
  // Xero rate needs correction. Audit will catch the mismatch against PS tax rates.
  SK: { accountCode: "207", taxType: "TAX046", rateCategory: "EU_OSS", expectedRatePct: 23 },
  RO: { accountCode: "207", taxType: "TAX043", rateCategory: "EU_OSS", expectedRatePct: 19 },
  BG: { accountCode: "207", taxType: "TAX026", rateCategory: "EU_OSS", expectedRatePct: 20 },
  // HR: only TAX035 "VAT On Sales HR RDC 13%" exists in Xero. Standard HR rate is 25%; no STD rate created.
  // Using RDC 13% as the only available option. Create an HR STD 25% rate if standard-rate orders are found.
  HR: { accountCode: "207", taxType: "TAX035", rateCategory: "EU_OSS", expectedRatePct: 25 },
  LT: { accountCode: "207", taxType: "TAX059", rateCategory: "EU_OSS", expectedRatePct: 21 },
  LV: { accountCode: "207", taxType: "TAX039", rateCategory: "EU_OSS", expectedRatePct: 21 },
  LU: { accountCode: "207", taxType: "TAX038", rateCategory: "EU_OSS", expectedRatePct: 17 },
  SI: { accountCode: "207", taxType: "TAX056", rateCategory: "EU_OSS", expectedRatePct: 9.5 },
  CY: { accountCode: "207", taxType: "TAX027", rateCategory: "EU_OSS", expectedRatePct: 19 },
  MT: { accountCode: "207", taxType: "TAX025", rateCategory: "EU_OSS", expectedRatePct: 18 },
  GR: { accountCode: "207", taxType: "TAX034", rateCategory: "EU_OSS", expectedRatePct: 24 },

  // Non-EU / export — zero VAT, export account
  GB: { accountCode: "200", taxType: "TAX011", rateCategory: "EXPORT", expectedRatePct: 0 },
};

/** Reverse lookup: Xero TaxType → country ISO code. Computed once at module load. */
export const TAX_TYPE_TO_COUNTRY: Record<string, string> = Object.entries(COUNTRY_VAT_RULES)
  .filter(([, r]) => r.taxType !== null)
  .reduce((acc, [iso, r]) => { acc[r.taxType!] = iso; return acc; }, {} as Record<string, string>);

/** Returns the rule for a country, or null if not in the map. */
export function getCountryRule(isoCode: string): CountryVatRule | null {
  return COUNTRY_VAT_RULES[isoCode.toUpperCase()] ?? null;
}

/** Returns true if the country is an EU OSS destination (not export, not NL domestic). */
export function isEuOss(isoCode: string): boolean {
  return COUNTRY_VAT_RULES[isoCode.toUpperCase()]?.rateCategory === "EU_OSS";
}
