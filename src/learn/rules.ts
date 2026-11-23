import { execute, query } from "../db/mysql.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuleInputs {
  transactionType?: string;  // ACCREC / ACCPAY / BANK_SPEND / BANK_RECEIVE
  contactName?: string;
  accountCode?: string;
  description?: string;
  shipCountryIso?: string;
  currency?: string;
}

export interface RuleHit {
  ruleId: number;
  ruleName: string;
  assignedAccountCode: string | null;
  assignedAccountName: string | null;
  assignedTaxCode: string | null;
  assignedContactName: string | null;
  confidence: number;
}

export interface DecisionItem {
  queueKey: string;
  domain: "MATCH" | "TAX_CODE" | "ACCOUNT_CODE" | "SUPPLIER_PROFILE" | "OTHER";
  transactionType?: string;
  contactName?: string;
  xeroInvoiceId?: string;
  psOrderId?: number;
  runId?: number;
  evidence: object;
  question: string;
}

// ---------------------------------------------------------------------------
// Rule application
// ---------------------------------------------------------------------------

interface StoredRule {
  id: number;
  rule_name: string;
  match_transaction_type: string | null;
  match_contact_name_re: string | null;
  match_account_code: string | null;
  match_description_re: string | null;
  match_ship_country_iso: string | null;
  match_currency: string | null;
  assigned_account_code: string | null;
  assigned_account_name: string | null;
  assigned_tax_code: string | null;
  assigned_contact_name: string | null;
  confidence: number;
}

let ruleCache: StoredRule[] | null = null;
let ruleCacheTs = 0;
const CACHE_TTL_MS = 60_000;

async function loadActiveRules(): Promise<StoredRule[]> {
  const now = Date.now();
  if (ruleCache && now - ruleCacheTs < CACHE_TTL_MS) return ruleCache;

  const rows = await query<any[]>(
    `SELECT id, rule_name, match_transaction_type, match_contact_name_re,
            match_account_code, match_description_re, match_ship_country_iso,
            match_currency, assigned_account_code, assigned_account_name,
            assigned_tax_code, assigned_contact_name, confidence
     FROM agent_rules
     WHERE active = TRUE
     ORDER BY priority ASC`
  );

  ruleCache = rows as StoredRule[];
  ruleCacheTs = now;
  return ruleCache;
}

export function invalidateRuleCache(): void {
  ruleCache = null;
}

// EU member states (27-country OSS scope)
const EU_COUNTRIES = new Set([
  "AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU",
  "IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"
]);

function matchesCountry(ruleCountry: string, input: string | undefined): boolean {
  if (!input) return false;
  if (ruleCountry === "EU") return EU_COUNTRIES.has(input.toUpperCase());
  if (ruleCountry === "NON_EU") return !EU_COUNTRIES.has(input.toUpperCase());
  return ruleCountry.toUpperCase() === input.toUpperCase();
}

function matchesRule(rule: StoredRule, inputs: RuleInputs): boolean {
  if (rule.match_transaction_type) {
    if (!inputs.transactionType) return false;
    if (rule.match_transaction_type !== inputs.transactionType) return false;
  }

  if (rule.match_contact_name_re) {
    if (!inputs.contactName) return false;
    try {
      if (!new RegExp(rule.match_contact_name_re, "i").test(inputs.contactName)) return false;
    } catch {
      return false;
    }
  }

  if (rule.match_account_code) {
    if (rule.match_account_code !== inputs.accountCode) return false;
  }

  if (rule.match_description_re) {
    if (!inputs.description) return false;
    try {
      if (!new RegExp(rule.match_description_re, "i").test(inputs.description)) return false;
    } catch {
      return false;
    }
  }

  if (rule.match_ship_country_iso) {
    if (!matchesCountry(rule.match_ship_country_iso, inputs.shipCountryIso)) return false;
  }

  if (rule.match_currency) {
    if (rule.match_currency !== inputs.currency) return false;
  }

  return true;
}

export async function applyRules(inputs: RuleInputs): Promise<RuleHit | null> {
  const rules = await loadActiveRules();
  for (const rule of rules) {
    if (!matchesRule(rule, inputs)) continue;
    return {
      ruleId: rule.id,
      ruleName: rule.rule_name,
      assignedAccountCode: rule.assigned_account_code,
      assignedAccountName: rule.assigned_account_name,
      assignedTaxCode: rule.assigned_tax_code,
      assignedContactName: rule.assigned_contact_name,
      confidence: Number(rule.confidence),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decision queue
// ---------------------------------------------------------------------------

export async function enqueueDecision(item: DecisionItem): Promise<number> {
  await execute(
    `INSERT IGNORE INTO decision_queue
       (queue_key, domain, transaction_type, contact_name, xero_invoice_id, ps_order_id,
        run_id, evidence, question)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.queueKey,
      item.domain,
      item.transactionType ?? null,
      item.contactName ?? null,
      item.xeroInvoiceId ?? null,
      item.psOrderId ?? null,
      item.runId ?? null,
      JSON.stringify(item.evidence),
      item.question,
    ]
  );
  const rows = await query<any[]>(
    `SELECT id FROM decision_queue WHERE queue_key = ?`,
    [item.queueKey]
  );
  return rows[0]?.id ?? 0;
}

export async function answerDecision(
  id: number,
  answer: string,
  answeredBy: "human" | "agent"
): Promise<void> {
  await execute(
    `UPDATE decision_queue
     SET answer = ?, answered_by = ?, answered_at = NOW(), status = 'answered', updated_at = NOW()
     WHERE id = ? AND status = 'open'`,
    [answer, answeredBy, id]
  );
}

export async function promoteToRule(
  decisionId: number,
  rule: {
    priority?: number;
    ruleName: string;
    scope?: string;
    matchTransactionType?: string;
    matchContactNameRe?: string;
    matchAccountCode?: string;
    matchDescriptionRe?: string;
    matchShipCountryIso?: string;
    matchCurrency?: string;
    assignedAccountCode?: string;
    assignedAccountName?: string;
    assignedTaxCode?: string;
    assignedContactName?: string;
    confidence?: number;
    notes?: string;
  }
): Promise<number> {
  const ruleRow = await execute(
    `INSERT INTO agent_rules
       (priority, rule_name, scope, match_transaction_type, match_contact_name_re,
        match_account_code, match_description_re, match_ship_country_iso, match_currency,
        assigned_account_code, assigned_account_name, assigned_tax_code, assigned_contact_name,
        confidence, source, decision_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HUMAN', ?, ?)`,
    [
      rule.priority ?? 500,
      rule.ruleName,
      rule.scope ?? "ALL",
      rule.matchTransactionType ?? null,
      rule.matchContactNameRe ?? null,
      rule.matchAccountCode ?? null,
      rule.matchDescriptionRe ?? null,
      rule.matchShipCountryIso ?? null,
      rule.matchCurrency ?? null,
      rule.assignedAccountCode ?? null,
      rule.assignedAccountName ?? null,
      rule.assignedTaxCode ?? null,
      rule.assignedContactName ?? null,
      rule.confidence ?? 0.85,
      decisionId,
      rule.notes ?? null,
    ]
  );
  const newRuleId = ruleRow.insertId as number;

  await execute(
    `UPDATE decision_queue
     SET status = 'promoted', promoted_rule_id = ?, updated_at = NOW()
     WHERE id = ?`,
    [newRuleId, decisionId]
  );

  invalidateRuleCache();
  return newRuleId;
}
