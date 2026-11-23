// Bills Management: the third real safety net in the create_bill_from_mailbox_file write
// path (see account-code-guard.ts and routing.ts's checkDuplicate). create_bill_from_mailbox_file
// previously had ZERO contact-dedup logic: `contact_id ? {ContactID} : {Name: supplier_name}`,
// letting Xero's own fuzzy name matching silently pick (or create) a contact. That is exactly
// how this project's known near-duplicate Xero contacts came to exist -- Paulo Tomas / Paulo
// Thomas, Kuura Solutions LLC / Kuurasolutions.com, DigitalOcean LLC / Digitalocean EU B.V.,
// Atlassian / Atlassian Pty Ltd, Anthropic / Anthropic, PBC, and a 4-way Tradethno split
// (Tradethno / Tradethno pte. ltd. / Tradethno pte. ltd / Tradethno pte ltd), all four ACTIVE
// simultaneously in the live warehouse today. This module never auto-merges or auto-picks
// between near-duplicates -- it only decides whether supplier_name is unambiguous enough to
// resolve automatically, or must be refused back to a human with the candidates named.
//
// Pure decision logic over facts the caller supplies (the synced xero_contacts rows) -- no DB
// or Xero calls here. See contact-resolution-guard.test.ts.

export interface XeroContactRef {
  contact_id: string;
  name: string;
  status: string;
}

export interface ContactResolution {
  ok: boolean;
  /** Set when ok=true and an unambiguous existing contact was found. Undefined (with ok=true)
   *  means no existing contact matches at all -- a genuinely new supplier, safe to create by
   *  bare name as before. */
  contactId?: string;
  /** Present when ok=false. Verbatim-safe to return to the caller as the Needs Review reason. */
  reason?: string;
}

// Legal-entity suffixes stripped before comparison, longest-first so "pte ltd" matches before
// a bare trailing "ltd" would. Each is matched as a normalized (lowercase, alnum-only) token.
const LEGAL_SUFFIXES = [
  "pte ltd", "pty ltd", "pte limited", "pty limited",
  "b v", "bv", "gmbh", "plc", "nv",
  "llc", "ltd", "limited", "incorporated", "inc", "corporation", "corp", "co",
].sort((a, b) => b.length - a.length);

function normalize(name: string): { collapsed: string; words: string[] } {
  let n = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (n === suf) {
        n = "";
        changed = true;
        break;
      }
      if (n.endsWith(" " + suf)) {
        n = n.slice(0, n.length - suf.length - 1).trim();
        changed = true;
        break;
      }
    }
  }
  const words = n.split(" ").filter(Boolean);
  return { collapsed: words.join(""), words };
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** True if `a` and `b` look like they could name the same real-world entity. */
function looksLikeSameSupplier(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na.collapsed || !nb.collapsed) return false;
  if (na.collapsed === nb.collapsed) return true;

  const [shorter, longer] = na.collapsed.length <= nb.collapsed.length ? [na.collapsed, nb.collapsed] : [nb.collapsed, na.collapsed];
  if (shorter.length >= 4 && longer.startsWith(shorter)) return true;

  // Edit-distance threshold scales with length -- a distance of 2 on a 3-letter string
  // (e.g. "KVK" vs "KPN") is two-thirds different, not a near-duplicate; the same distance
  // on "Paulo Tomas"/"Paulo Thomas" is a one-letter typo. Short strings require an exact
  // (distance<=1) near-miss; longer ones tolerate distance<=2.
  const shortestLen = Math.min(na.collapsed.length, nb.collapsed.length);
  if (Math.max(na.collapsed.length, nb.collapsed.length) <= 20 && shortestLen >= 4) {
    const dist = levenshtein(na.collapsed, nb.collapsed);
    const threshold = shortestLen <= 6 ? 1 : 2;
    if (dist <= threshold) return true;
  }

  // Same distinctive first word (e.g. "Canva Design and Publishing" vs "Canva Pro") -- short
  // first words are excluded as too generic to mean anything on their own.
  const firstA = na.words[0];
  const firstB = nb.words[0];
  if (firstA && firstB && firstA.length >= 4 && firstA === firstB) return true;

  return false;
}

/**
 * Decide whether `supplierName` may be resolved to a Xero contact automatically.
 *
 * - An explicit `contactIdOverride` is always trusted outright (the caller already resolved
 *   it, e.g. by checking which contact has real bill history, same as every manual batch in
 *   this project has done so far).
 * - Exactly one ACTIVE contact matches by exact (case-insensitive) name, AND no other ACTIVE
 *   contact looks like a near-duplicate of it or of supplierName -> resolved automatically.
 * - Any ambiguity -- multiple exact matches, OR one exact match alongside other near-duplicate
 *   candidates, OR no exact match but one or more near-duplicate candidates -- refuses, naming
 *   every candidate, so a human picks (same as the IAR-004 Tradethno dual-role risk this
 *   mirrors).
 * - No exact or near match at all -> ok:true with no contactId: a genuinely new supplier, safe
 *   to create by bare name exactly as before.
 */
export function resolveContactForBill(
  supplierName: string,
  contactIdOverride: string | null | undefined,
  contacts: readonly XeroContactRef[]
): ContactResolution {
  const override = (contactIdOverride ?? "").trim();
  if (override) {
    return { ok: true, contactId: override };
  }

  const name = supplierName.trim();
  const active = contacts.filter((c) => c.status === "ACTIVE");

  const exact = active.filter((c) => c.name.trim().toLowerCase() === name.toLowerCase());
  const near = active.filter(
    (c) => !exact.includes(c) && looksLikeSameSupplier(c.name, name)
  );

  if (exact.length === 0 && near.length === 0) {
    return { ok: true, contactId: undefined };
  }

  if (exact.length === 1 && near.length === 0) {
    return { ok: true, contactId: exact[0].contact_id };
  }

  const candidates = [...exact, ...near];
  const names = candidates.map((c) => `"${c.name}"`).join(", ");
  return {
    ok: false,
    reason:
      `supplier_name "${name}" is ambiguous against the synced Xero contacts: ${names}. ` +
      (exact.length > 1
        ? "Multiple contacts share this exact name. "
        : exact.length === 1
          ? "An exact name match exists, but other similarly-named contacts do too — confirm which one actually has this supplier's real bill history before proceeding (do not assume the exact-name match is the one in use). "
          : "No exact match, but one or more similarly-named contacts exist — this may be a spelling or legal-suffix variant of an existing supplier rather than a new one. ") +
      "Supply contact_id explicitly once confirmed.",
  };
}
