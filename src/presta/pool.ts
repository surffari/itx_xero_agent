import mysql, { Pool, RowDataPacket } from "mysql2/promise";
import { config } from "../config.js";

let pool: Pool | null = null;

export function getPsPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.PS_BI_HOST,
      port: config.PS_BI_PORT,
      database: config.PS_BI_DATABASE,
      user: config.PS_BI_USER,
      password: config.PS_BI_PASSWORD,
      waitForConnections: true,
      connectionLimit: 4,
      timezone: "Z",
      decimalNumbers: true,
      supportBigNumbers: true
    });
  }
  return pool;
}

export async function psQuery<T extends RowDataPacket[] = RowDataPacket[]>(sql: string, params?: any): Promise<T> {
  const [rows] = await getPsPool().query<T>(sql, params);
  return rows;
}

export async function closePsPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
