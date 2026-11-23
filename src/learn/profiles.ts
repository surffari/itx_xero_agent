import { execute, query } from "../db/mysql.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupplierProfile {
  id: number;
  contactName: string;
  countryIso: string | null;
  vatId: string | null;
  entityType: "company" | "individual" | "platform";
  supplyType: "goods" | "services" | "mixed";
  defaultTaxCode: string | null;
  defaultAccountCode: string | null;
  notes: string | null;
  confidence: number;
  viesValidatedAt: string | null;
  viesValid: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProfileInput {
  contactName: string;
  countryIso?: string | null;
  vatId?: string | null;
  entityType?: "company" | "individual" | "platform";
  supplyType?: "goods" | "services" | "mixed";
  defaultTaxCode?: string | null;
  defaultAccountCode?: string | null;
  notes?: string | null;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Profile cache (short-lived; profiles change infrequently)
// ---------------------------------------------------------------------------

let profileCache: Map<string, SupplierProfile> | null = null;
let profileCacheTs = 0;
const CACHE_TTL_MS = 60_000;

export function invalidateProfileCache(): void {
  profileCache = null;
}

async function loadAllProfiles(): Promise<Map<string, SupplierProfile>> {
  const now = Date.now();
  if (profileCache && now - profileCacheTs < CACHE_TTL_MS) return profileCache;

  const rows = await query<any[]>(
    `SELECT id, contact_name, country_iso, vat_id, entity_type, supply_type,
            default_tax_code, default_account_code, notes, confidence,
            vies_validated_at, vies_valid, created_at, updated_at
     FROM supplier_tax_profiles
     ORDER BY contact_name ASC`
  );

  const map = new Map<string, SupplierProfile>();
  for (const r of rows) {
    map.set(r.contact_name.toLowerCase(), rowToProfile(r));
  }
  profileCache = map;
  profileCacheTs = now;
  return map;
}

function rowToProfile(r: any): SupplierProfile {
  return {
    id: r.id,
    contactName: r.contact_name,
    countryIso: r.country_iso ?? null,
    vatId: r.vat_id ?? null,
    entityType: r.entity_type,
    supplyType: r.supply_type,
    defaultTaxCode: r.default_tax_code ?? null,
    defaultAccountCode: r.default_account_code ?? null,
    notes: r.notes ?? null,
    confidence: Number(r.confidence),
    viesValidatedAt: r.vies_validated_at
      ? (r.vies_validated_at instanceof Date
          ? r.vies_validated_at.toISOString()
          : String(r.vies_validated_at))
      : null,
    viesValid: r.vies_valid !== null && r.vies_valid !== undefined ? Boolean(r.vies_valid) : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Look up a supplier profile by exact contact name (case-insensitive). */
export async function getSupplierProfile(contactName: string): Promise<SupplierProfile | null> {
  const map = await loadAllProfiles();
  return map.get(contactName.toLowerCase()) ?? null;
}

/** List all profiles, optionally filtered by a substring of contact_name. */
export async function listSupplierProfiles(search?: string): Promise<SupplierProfile[]> {
  const map = await loadAllProfiles();
  const all = [...map.values()];
  if (!search) return all;
  const lc = search.toLowerCase();
  return all.filter(p => p.contactName.toLowerCase().includes(lc));
}

/** Create or update a supplier profile. Returns the id. */
export async function upsertSupplierProfile(input: UpsertProfileInput): Promise<number> {
  await execute(
    `INSERT INTO supplier_tax_profiles
       (contact_name, country_iso, vat_id, entity_type, supply_type,
        default_tax_code, default_account_code, notes, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       country_iso          = COALESCE(VALUES(country_iso), country_iso),
       vat_id               = COALESCE(VALUES(vat_id), vat_id),
       entity_type          = VALUES(entity_type),
       supply_type          = VALUES(supply_type),
       default_tax_code     = COALESCE(VALUES(default_tax_code), default_tax_code),
       default_account_code = COALESCE(VALUES(default_account_code), default_account_code),
       notes                = COALESCE(VALUES(notes), notes),
       confidence           = VALUES(confidence),
       updated_at           = NOW()`,
    [
      input.contactName,
      input.countryIso ?? null,
      input.vatId ?? null,
      input.entityType ?? "company",
      input.supplyType ?? "services",
      input.defaultTaxCode ?? null,
      input.defaultAccountCode ?? null,
      input.notes ?? null,
      input.confidence ?? 0.50,
    ]
  );

  invalidateProfileCache();

  const rows = await query<any[]>(
    `SELECT id FROM supplier_tax_profiles WHERE contact_name = ?`,
    [input.contactName]
  );
  return rows[0]?.id ?? 0;
}
