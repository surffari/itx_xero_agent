import { ResultSetHeader } from "mysql2";
import { getPool } from "./mysql.js";
import { toMysqlDateTime } from "../lib/dates.js";
import { stringifyJson } from "../lib/json.js";

export interface RawObjectInput {
  tenantId: string;
  objectType: string;
  objectId: string;
  sourceUpdatedAt?: unknown;
  payload: unknown;
}

export async function upsertRawObject(input: RawObjectInput): Promise<number> {
  const [result] = await getPool().execute<ResultSetHeader>(
    `
    INSERT INTO xero_raw_objects (
      tenant_id, object_type, object_id, source_updated_at, fetched_at, payload
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON DUPLICATE KEY UPDATE
      source_updated_at = VALUES(source_updated_at),
      fetched_at = CURRENT_TIMESTAMP,
      payload = VALUES(payload),
      id = LAST_INSERT_ID(id)
    `,
    [
      input.tenantId,
      input.objectType,
      input.objectId,
      toMysqlDateTime(input.sourceUpdatedAt),
      stringifyJson(input.payload)
    ]
  );
  return result.insertId;
}
