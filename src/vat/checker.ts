import { RowDataPacket } from "mysql2/promise";
import { query } from "../db/mysql.js";
import { psQuery } from "../presta/pool.js";
import { config } from "../config.js";
import { COUNTRY_VAT_RULES } from "./rates.js";

const PS = config.PS_TABLE_PREFIX;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface XeroTaxRateRow extends RowDataPacket {
  tax_type: string;
  name: string;
  status: string;
  effective_rate: number;
}

interface PsRateRow extends RowDataPacket {
  ship_country: string;
  tax_rate: number;
  order_count: number;
  line_count: number;
}

export type VatIssueType =
  | "MISSING_XERO_RATE"       // PS orders to country, no Xero tax type mapped
  | "MISSING_COUNTRY_RULE"    // PS orders to country not in COUNTRY_VAT_RULES at all
  | "XERO_PS_MISMATCH"        // Xero effective_rate != dominant non-zero PS rate for country
  | "UNVERIFIED_REFERENCE_RATE"; // seeded expected rate differs from Xero rate (INFO only)

export type VatIssueSeverity = "ERROR" | "INFO";

export interface VatRateIssue {
  severity: VatIssueSeverity;
  issueType: VatIssueType;
  country: string;
  xeroTaxType?: string;
  xeroRatePct?: number;
  psRates?: Array<{ rate: number; orderCount: number; lineCount: number }>;
  expectedRatePct?: number;
  detail: string;
}

export interface VatRateAuditResult {
  auditDate: string;
  lookbackDays: number;
  issues: VatRateIssue[];
  countriesOk: string[];
  summary: {
    errors: number;
    infos: number;
    totalIssues: number;
    countriesChecked: number;
    countriesOk: number;
  };
}

// ---------------------------------------------------------------------------
// Main audit function
// ---------------------------------------------------------------------------

export async function auditVatRates(
  tenantId: string,
  lookbackDays = 365
): Promise<VatRateAuditResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // 1. Load all synced Xero tax rates from warehouse
  const xeroRows = await query<XeroTaxRateRow[]>(
    `SELECT tax_type, name, status, effective_rate
     FROM xero_tax_rates
     WHERE tenant_id = ?`,
    [tenantId]
  );
  const xeroByType: Record<string, XeroTaxRateRow> = {};
  for (const r of xeroRows) xeroByType[r.tax_type] = r;

  // 2. Build country → Xero rate map (only for countries with a taxType configured)
  const xeroByCountry: Record<string, XeroTaxRateRow | undefined> = {};
  for (const [iso, rule] of Object.entries(COUNTRY_VAT_RULES)) {
    if (rule.taxType) xeroByCountry[iso] = xeroByType[rule.taxType];
  }

  // 3. Query PS for distinct (ship_country, tax_rate) combinations in the lookback window
  const psRows = await psQuery<PsRateRow[]>(
    `SELECT c.iso_code AS ship_country,
            od.tax_rate,
            COUNT(DISTINCT o.id_order) AS order_count,
            COUNT(od.id_order_detail) AS line_count
     FROM ${PS}orders o
     JOIN ${PS}order_state os ON os.id_order_state = o.current_state
     JOIN ${PS}address a ON a.id_address = o.id_address_delivery
     JOIN ${PS}country c ON c.id_country = a.id_country
     JOIN ${PS}order_detail od ON od.id_order = o.id_order
     WHERE o.date_add >= ?
       AND os.invoice = 1
     GROUP BY c.iso_code, od.tax_rate
     ORDER BY c.iso_code, COUNT(o.id_order) DESC`,
    [cutoffStr]
  );

  // Group PS rows by country
  const psByCountry: Record<string, Array<{ rate: number; orderCount: number; lineCount: number }>> = {};
  for (const row of psRows) {
    if (!psByCountry[row.ship_country]) psByCountry[row.ship_country] = [];
    psByCountry[row.ship_country].push({
      rate: Number(row.tax_rate),
      orderCount: Number(row.order_count),
      lineCount: Number(row.line_count),
    });
  }

  // 4. Run checks over the union of PS countries and configured countries
  const issues: VatRateIssue[] = [];
  const countriesOk: string[] = [];

  const allCountries = new Set([
    ...Object.keys(psByCountry),
    // Also check configured countries even if no PS orders in the window (Xero rate still needs to be valid)
    ...Object.keys(COUNTRY_VAT_RULES).filter(iso => COUNTRY_VAT_RULES[iso].taxType),
  ]);

  for (const country of [...allCountries].sort()) {
    const rule = COUNTRY_VAT_RULES[country];
    const psRates = psByCountry[country] ?? [];
    const hasPsOrders = psRates.length > 0;

    // Country has PS orders but is completely unknown
    if (!rule) {
      if (hasPsOrders) {
        issues.push({
          severity: "ERROR",
          issueType: "MISSING_COUNTRY_RULE",
          country,
          psRates,
          detail: `PS has orders shipped to ${country} (${totalOrders(psRates)} orders in ${lookbackDays}d) but this country has no entry in COUNTRY_VAT_RULES. Add a rule.`,
        });
      }
      continue;
    }

    // Export countries: just verify PS applies 0% (non-zero would be a coding error)
    if (rule.rateCategory === "EXPORT") {
      const nonZero = psRates.filter(r => r.rate > 0);
      if (hasPsOrders && nonZero.length > 0) {
        issues.push({
          severity: "ERROR",
          issueType: "XERO_PS_MISMATCH",
          country,
          xeroTaxType: rule.taxType ?? undefined,
          xeroRatePct: 0,
          psRates,
          detail: `Export country ${country} has PS orders with non-zero tax rates: ${nonZero.map(r => r.rate + "%").join(", ")}. Export sales should carry 0% VAT.`,
        });
      } else if (!issues.some(i => i.country === country)) {
        countriesOk.push(country);
      }
      continue;
    }

    // EU OSS or NL domestic: no taxType means Xero rate not yet created
    if (!rule.taxType) {
      if (hasPsOrders) {
        issues.push({
          severity: "ERROR",
          issueType: "MISSING_XERO_RATE",
          country,
          psRates,
          expectedRatePct: rule.expectedRatePct ?? undefined,
          detail: `PS has ${totalOrders(psRates)} orders shipped to ${country} in the last ${lookbackDays} days, but no Xero OSS tax rate is configured for this country. Create one in Xero and update COUNTRY_VAT_RULES.`,
        });
      }
      // No PS orders + no Xero rate = not a problem yet; omit from output
      continue;
    }

    const xeroRate = xeroByCountry[country];

    // taxType is set in rules but not found in warehouse — sync hasn't run or rate deleted
    if (!xeroRate) {
      issues.push({
        severity: "ERROR",
        issueType: "MISSING_XERO_RATE",
        country,
        xeroTaxType: rule.taxType,
        psRates: hasPsOrders ? psRates : undefined,
        expectedRatePct: rule.expectedRatePct ?? undefined,
        detail: `COUNTRY_VAT_RULES maps ${country} → ${rule.taxType} but this tax type was not found in the warehouse. Run sync_reference to refresh, or check if the rate was deleted in Xero.`,
      });
      continue;
    }

    // Xero rate inactive?
    if (xeroRate.status !== "ACTIVE") {
      issues.push({
        severity: "ERROR",
        issueType: "MISSING_XERO_RATE",
        country,
        xeroTaxType: rule.taxType,
        xeroRatePct: xeroRate.effective_rate,
        psRates: hasPsOrders ? psRates : undefined,
        detail: `Xero tax type ${rule.taxType} (${country}) has status "${xeroRate.status}" — not ACTIVE. Reactivate or create a replacement.`,
      });
      continue;
    }

    // Xero rate exists and is active — compare to dominant non-zero PS rate
    if (hasPsOrders) {
      const nonZero = psRates.filter(r => r.rate > 0);
      const dominant = nonZero[0]; // already sorted by order_count desc
      if (dominant && Math.abs(dominant.rate - xeroRate.effective_rate) > 0.1) {
        issues.push({
          severity: "ERROR",
          issueType: "XERO_PS_MISMATCH",
          country,
          xeroTaxType: rule.taxType,
          xeroRatePct: xeroRate.effective_rate,
          psRates,
          detail: `${country}: Xero ${rule.taxType} = ${xeroRate.effective_rate}%, but dominant PS tax rate for this country is ${dominant.rate}% (${dominant.orderCount} orders, ${dominant.lineCount} lines). Rates must match — investigate whether PS or Xero needs correction.`,
        });
        continue;
      }
    }

    // Compare Xero rate against seeded reference (INFO only — reference is unverified)
    if (rule.expectedRatePct !== null && Math.abs(xeroRate.effective_rate - rule.expectedRatePct) > 0.1) {
      issues.push({
        severity: "INFO",
        issueType: "UNVERIFIED_REFERENCE_RATE",
        country,
        xeroTaxType: rule.taxType,
        xeroRatePct: xeroRate.effective_rate,
        psRates: hasPsOrders ? psRates : undefined,
        expectedRatePct: rule.expectedRatePct,
        detail: `${country}: Xero rate is ${xeroRate.effective_rate}%, seeded reference is ${rule.expectedRatePct}%. Reference is unverified — confirm with accountant whether the Xero rate is correct before treating this as an error.`,
      });
      continue;
    }

    // All checks passed
    countriesOk.push(country);
  }

  const errors = issues.filter(i => i.severity === "ERROR").length;
  const infos = issues.filter(i => i.severity === "INFO").length;

  return {
    auditDate: new Date().toISOString(),
    lookbackDays,
    issues,
    countriesOk,
    summary: {
      errors,
      infos,
      totalIssues: issues.length,
      countriesChecked: allCountries.size,
      countriesOk: countriesOk.length,
    },
  };
}

function totalOrders(rates: Array<{ orderCount: number }>): number {
  // Sum distinct order counts (PS query groups per rate, so orders may overlap)
  return Math.max(...rates.map(r => r.orderCount));
}

// ---------------------------------------------------------------------------
// Country VAT investigation (single-country deep-dive for the agent)
// ---------------------------------------------------------------------------

export interface CountryVatInvestigation {
  country: string;
  lookbackDays: number;
  /** Current entry in COUNTRY_VAT_RULES, null if country is not mapped */
  currentMapping: {
    taxType: string | null;
    accountCode: string;
    rateCategory: string;
    expectedRatePct: number | null;
  } | null;
  /** Distinct tax rates actually charged in PrestaShop for this country in the lookback window */
  psActuals: Array<{ taxRate: number; orderCount: number; lineCount: number }>;
  /**
   * All Xero tax rates in the warehouse whose name contains the ISO code as a word
   * (e.g. "TAX060 - VAT On Sales in Estonia 22%", "TAX061 - VAT On Sales in EE STD 24%").
   * Includes inactive/deleted rates so the agent can see the full picture.
   */
  xeroMatches: Array<{ taxType: string; name: string; status: string; effectiveRate: number }>;
  /** Derived flags for the agent to reason about */
  flags: string[];
}

/** English country names for EU + GB, used to extend Xero rate name search beyond ISO code. */
const COUNTRY_ENGLISH_NAMES: Record<string, string> = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", CY: "Cyprus", CZ: "Czech",
  DE: "Germany|German", DK: "Denmark|Danish", EE: "Estonia", ES: "Spain|Spanish",
  FI: "Finland|Finnish", FR: "France|French", GR: "Greece|Greek", HR: "Croatia",
  HU: "Hungary", IE: "Ireland|Irish", IT: "Italy|Italian", LT: "Lithuania",
  LU: "Luxembourg", LV: "Latvia", MT: "Malta", NL: "Netherlands|Dutch",
  PL: "Poland|Polish", PT: "Portugal", RO: "Romania", SE: "Sweden|Swedish",
  SI: "Slovenia", SK: "Slovakia|Slovak", GB: "United Kingdom|UK",
};

/**
 * Deep-dive into a single country's VAT rate situation.
 * Returns PS actuals, all matching Xero rates, and flags for agent reasoning.
 */
export async function investigateCountryVat(
  tenantId: string,
  countryIso: string,
  lookbackDays = 365
): Promise<CountryVatInvestigation> {
  const iso = countryIso.toUpperCase();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // 1. Current mapping
  const rule = COUNTRY_VAT_RULES[iso] ?? null;

  // 2. PS actuals for this country
  const psRows = await psQuery<PsRateRow[]>(
    `SELECT c.iso_code AS ship_country,
            od.tax_rate,
            COUNT(DISTINCT o.id_order) AS order_count,
            COUNT(od.id_order_detail) AS line_count
     FROM ${PS}orders o
     JOIN ${PS}order_state os ON os.id_order_state = o.current_state
     JOIN ${PS}address a ON a.id_address = o.id_address_delivery
     JOIN ${PS}country c ON c.id_country = a.id_country
     JOIN ${PS}order_detail od ON od.id_order = o.id_order
     WHERE o.date_add >= ? AND os.invoice = 1 AND c.iso_code = ?
     GROUP BY c.iso_code, od.tax_rate
     ORDER BY COUNT(o.id_order) DESC`,
    [cutoffStr, iso]
  );
  const psActuals = psRows.map(r => ({
    taxRate: Number(r.tax_rate),
    orderCount: Number(r.order_count),
    lineCount: Number(r.line_count),
  }));

  // 3. All Xero rates whose name contains the ISO code or country name as a standalone word
  const allXero = await query<XeroTaxRateRow[]>(
    `SELECT tax_type, name, status, effective_rate FROM xero_tax_rates WHERE tenant_id = ?`,
    [tenantId]
  );
  // Build a combined pattern: ISO code + any known English name variants
  const nameParts = [iso];
  const countryNames = COUNTRY_ENGLISH_NAMES[iso];
  if (countryNames) nameParts.push(...countryNames.split("|"));
  const combinedPattern = nameParts
    .map(p => `(?<![A-Za-z])${p}(?![A-Za-z])`)
    .join("|");
  const wordBoundary = new RegExp(combinedPattern, "i");
  const xeroMatches = allXero
    .filter(r => wordBoundary.test(r.name))
    .map(r => ({
      taxType: r.tax_type,
      name: r.name,
      status: r.status,
      effectiveRate: Number(r.effective_rate),
    }));

  // 4. Derive flags
  const flags: string[] = [];

  if (!rule) {
    flags.push(`MISSING_COUNTRY_RULE: ${iso} has no entry in COUNTRY_VAT_RULES.`);
  } else {
    if (rule.taxType === null) {
      flags.push(`NULL_TAX_TYPE: ${iso} is in COUNTRY_VAT_RULES but taxType is null — no Xero rate mapped.`);
    }

    const activeMatches = xeroMatches.filter(r => r.status === "ACTIVE");
    if (activeMatches.length === 0 && xeroMatches.length > 0) {
      flags.push(`NO_ACTIVE_XERO_RATE: ${xeroMatches.length} Xero rate(s) found for ${iso} but none are ACTIVE.`);
    }
    if (activeMatches.length > 1) {
      const summary = activeMatches.map(r => `${r.taxType} "${r.name}" ${r.effectiveRate}%`).join(", ");
      flags.push(`MULTIPLE_ACTIVE_RATES: ${activeMatches.length} active Xero rates match ${iso} — ${summary}. Determine which is correct and archive the other(s).`);
    }

    if (rule.taxType) {
      const mapped = allXero.find(r => r.tax_type === rule.taxType);
      if (mapped) {
        if (rule.expectedRatePct !== null && Math.abs(mapped.effective_rate - rule.expectedRatePct) > 0.1) {
          flags.push(`XERO_EXPECTED_MISMATCH: Mapped ${rule.taxType} has effective_rate=${mapped.effective_rate}% but expectedRatePct in COUNTRY_VAT_RULES is ${rule.expectedRatePct}%. Xero rate needs correction or expectedRatePct needs update.`);
        }
      } else {
        flags.push(`MAPPED_RATE_NOT_IN_WAREHOUSE: COUNTRY_VAT_RULES maps ${iso} → ${rule.taxType} but this tax type is absent from the warehouse. Run sync_reference.`);
      }
    }
  }

  if (psActuals.length === 0) {
    flags.push(`NO_PS_ORDERS: No invoiced PS orders found for ${iso} in the last ${lookbackDays} days.`);
  } else {
    const dominant = psActuals[0];
    if (rule?.taxType) {
      const mapped = allXero.find(r => r.tax_type === rule.taxType);
      if (mapped && Math.abs(dominant.taxRate - mapped.effective_rate) > 0.1) {
        flags.push(`PS_XERO_MISMATCH: PS charges ${dominant.taxRate}% (${dominant.orderCount} orders), Xero ${rule.taxType} is ${mapped.effective_rate}%. These must match.`);
      }
    } else if (rule?.taxType === null) {
      // Suggest candidate based on PS rate
      const rateMatch = xeroMatches.filter(r => r.status === "ACTIVE" && Math.abs(r.effectiveRate - dominant.taxRate) <= 0.1);
      if (rateMatch.length === 1) {
        flags.push(`CANDIDATE_MATCH: PS charges ${dominant.taxRate}% and exactly one active Xero rate matches: ${rateMatch[0].taxType} "${rateMatch[0].name}" ${rateMatch[0].effectiveRate}%.`);
      } else if (rateMatch.length > 1) {
        flags.push(`MULTIPLE_CANDIDATES: PS charges ${dominant.taxRate}% and ${rateMatch.length} active Xero rates match that rate: ${rateMatch.map(r => `${r.taxType} "${r.name}" ${r.effectiveRate}%`).join(", ")}.`);
      } else {
        flags.push(`NO_CANDIDATE_MATCH: PS charges ${dominant.taxRate}% but no active Xero rate for ${iso} matches that rate.`);
      }
    }
  }

  return {
    country: iso,
    lookbackDays,
    currentMapping: rule
      ? {
          taxType: rule.taxType,
          accountCode: rule.accountCode,
          rateCategory: rule.rateCategory,
          expectedRatePct: rule.expectedRatePct,
        }
      : null,
    psActuals,
    xeroMatches,
    flags,
  };
}
