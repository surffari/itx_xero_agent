import { randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, stat, unlink, link } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "dotenv";

/**
 * Absolute path of the project `.env` (src/lib/ or dist/lib/ -> project root), so reads and
 * writes do not depend on the process cwd.
 */
export const DEFAULT_ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));

/** Read one key straight from the .env file on disk (not from the startup `process.env`). */
export async function readDotEnvValue(key: string, path = DEFAULT_ENV_PATH): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const value = parse(content)[key];
  return value ? value : undefined;
}

/**
 * Update keys in the .env file atomically: write a temp file in the same directory, then rename
 * it over the original. Keeps the original file mode (default 0640). A reader never sees a
 * half-written file, and the write works for any user who can write the directory.
 */
export async function updateDotEnv(values: Record<string, string | undefined>, path = DEFAULT_ENV_PATH) {
  let content = "";
  let mode = 0o640;
  try {
    content = await readFile(path, "utf8");
    mode = (await stat(path)).mode & 0o777;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const escaped = value.replaceAll('"', '\\"');
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, () => `${key}=${escaped}`);
    } else {
      content += `${content.endsWith("\n") || content.length === 0 ? "" : "\n"}${key}=${escaped}\n`;
    }
  }

  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await open(tmpPath, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(tmpPath, mode); // open() mode is filtered by umask; set it explicitly
    await rename(tmpPath, path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export interface EnvLockOptions {
  /** Give up waiting for the lock after this long. */
  timeoutMs?: number;
  /** A lock older than this is treated as abandoned. Must exceed the longest critical section. */
  staleMs?: number;
}

/**
 * Run `fn` while holding a cross-process lock file `<envPath>.lock`. A lock whose owner pid is
 * dead, or which is older than `staleMs`, is taken over.
 */
export async function withEnvLock<T>(
  fn: () => Promise<T>,
  envPath = DEFAULT_ENV_PATH,
  options: EnvLockOptions = {}
): Promise<T> {
  const lockPath = `${envPath}.lock`;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const staleMs = options.staleMs ?? 30_000;
  const nonce = `${process.pid}:${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o640);
      try {
        await handle.writeFile(`${nonce}\n${Date.now()}\n`, "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    await maybeBreakStaleLock(lockPath, staleMs);
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${lockPath}.`);
    }
    await delay(50 + Math.floor(Math.random() * 100));
  }

  try {
    return await fn();
  } finally {
    try {
      const current = await readFile(lockPath, "utf8");
      if (current.startsWith(`${nonce}\n`)) await unlink(lockPath);
    } catch {
      // lock already gone
    }
  }
}

async function maybeBreakStaleLock(lockPath: string, staleMs: number): Promise<void> {
  let content: string;
  try {
    content = await readFile(lockPath, "utf8");
  } catch {
    return; // released meanwhile
  }
  const [owner = "", createdRaw = ""] = content.split("\n");
  const pid = Number(owner.split(":")[0]);
  const created = Number(createdRaw);
  const ownerDead = Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid);
  const tooOld = Number.isFinite(created) && Date.now() - created > staleMs;
  // A lock still being written (empty content) is not stale.
  if (!content || !(ownerDead || tooOld)) return;

  // Move it aside atomically; only one contender can win the rename.
  const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await rename(lockPath, aside);
  } catch {
    return;
  }
  // If what we moved is not the lock we judged stale, a new owner got in between: put it back.
  const moved = await readFile(aside, "utf8").catch(() => "");
  if (moved !== content) {
    await link(aside, lockPath).catch(() => {});
  }
  await unlink(aside).catch(() => {});
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM"; // exists but owned by another user
  }
}
