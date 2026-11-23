export function toMysqlDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "string") return null;

  const msMatch = /\/Date\((\d+)(?:[+-]\d+)?\)\//.exec(value);
  if (msMatch) return new Date(Number(msMatch[1])).toISOString().slice(0, 10);

  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);

  const ymd = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return ymd ? ymd[0] : null;
}

export function toMysqlDateTime(value: unknown): string | null {
  const date = toMysqlDate(value);
  if (!date) return null;
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 19).replace("T", " ");
  }
  return `${date} 00:00:00`;
}

export function isoDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}
