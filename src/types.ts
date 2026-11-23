export type JsonObject = Record<string, unknown>;

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type FindingStatus = "open" | "reviewed" | "ignored" | "resolved";

export interface AuditContext {
  runId: number;
  tenantId: string;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface AuditFindingInput {
  findingType: string;
  severity: Severity;
  confidence: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  accountCode?: string | null;
  accountName?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  amount?: number | null;
  currencyCode?: string | null;
  findingSummary: string;
  evidenceJson?: JsonObject;
  recommendedAction?: string | null;
}
