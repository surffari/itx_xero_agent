import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, withConnection } from "./mysql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../migrations");

export async function runMigrations() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  await withConnection(async (conn) => {
    for (const file of files) {
      const id = file;
      const [existing] = await conn.query("SELECT id FROM schema_migrations WHERE id = ?", [id]);
      if (Array.isArray(existing) && existing.length > 0) continue;

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await conn.beginTransaction();
      try {
        for (const statement of splitSqlStatements(sql)) {
          if (statement.trim()) {
            await conn.query(statement);
          }
        }
        await conn.query("INSERT INTO schema_migrations (id) VALUES (?)", [id]);
        await conn.commit();
        console.log(`Applied migration ${id}`);
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    }
  });
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\r?\n|$)/g)
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim()
    )
    .filter((part) => part.length > 0);
}
