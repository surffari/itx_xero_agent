import { config } from "../config.js";
import { DEFAULT_ENV_PATH, readDotEnvValue, updateDotEnv, withEnvLock, type EnvLockOptions } from "../lib/envFile.js";

/**
 * One source of truth for the Xero OAuth token.
 *
 * Xero rotates the refresh token on every refresh and invalidates the old one. Before this
 * module each Xero client kept its own copy of the refresh token from process start, so the
 * second client to refresh presented an already-used token ("Refresh token has been consumed").
 *
 * Rules enforced here:
 * - The refresh token is never held from startup: it is read from `.env` on disk at each refresh.
 * - Refreshes are serialised across processes with a lock file, and de-duplicated in-process.
 * - A rotated refresh token is written back atomically before the lock is released.
 * - Only the short-lived access token is cached in memory, shared by every client in the process.
 */

const TOKEN_URL = "https://identity.xero.com/connect/token";
const REFRESH_KEY = "XERO_REFRESH_TOKEN";
const EXPIRY_MARGIN_MS = 60_000;

export class XeroAuthLostError extends Error {
  constructor(detail: string) {
    super(
      `Xero connection lost (${detail}). The stored refresh token is no longer valid. ` +
        "Re-authorise once with: npx tsx src/cli.ts auth --manual"
    );
    this.name = "XeroAuthLostError";
  }
}

export interface TokenStoreOptions {
  clientId?: string;
  clientSecret?: string;
  envPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  lock?: EnvLockOptions;
  /** Injectable for tests; defaults to the atomic `.env` writer. */
  writeRefreshToken?: (token: string, envPath: string) => Promise<void>;
  requestTimeoutMs?: number;
}

export interface TokenStore {
  getAccessToken(): Promise<string>;
  /** Drop the cached access token (e.g. after an API 401). */
  invalidate(): void;
}

export function createTokenStore(options: TokenStoreOptions = {}): TokenStore {
  const envPath = options.envPath ?? DEFAULT_ENV_PATH;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const writeRefreshToken =
    options.writeRefreshToken ?? ((token: string, path: string) => updateDotEnv({ [REFRESH_KEY]: token }, path));

  let cached: { accessToken: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;
  /** A rotated refresh token we could not save yet. It is the only valid one, so it wins over disk. */
  let unsaved: string | null = null;

  function credentials() {
    const clientId = options.clientId ?? config.XERO_CLIENT_ID;
    const clientSecret = options.clientSecret ?? config.XERO_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("XERO_CLIENT_ID and XERO_CLIENT_SECRET are required.");
    }
    return { clientId, clientSecret };
  }

  async function requestToken(refreshToken: string) {
    const { clientId, clientSecret } = credentials();
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    const text = await response.text();
    let body: Record<string, any> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { ok: response.ok, status: response.status, body, text };
  }

  async function saveRotated(token: string): Promise<void> {
    try {
      await writeRefreshToken(token, envPath);
      unsaved = null;
    } catch (error: any) {
      unsaved = token;
      console.error(
        `[xero] CRITICAL: could not save the rotated Xero refresh token to ${envPath} (${error?.code ?? error?.message}). ` +
          "It is kept in memory and the save is retried on the next refresh; if this process exits first, Xero must be re-authorised."
      );
    }
  }

  async function refresh(): Promise<string> {
    return withEnvLock(
      async () => {
        const onDisk = await readDotEnvValue(REFRESH_KEY, envPath);
        let used = unsaved ?? onDisk;
        if (!used) throw new XeroAuthLostError(`${REFRESH_KEY} is empty in ${envPath}`);

        let result = await requestToken(used);
        if (!result.ok && result.body?.error === "invalid_grant") {
          // Someone (auth, or a process running older code) may have just written a newer token.
          const latest = await readDotEnvValue(REFRESH_KEY, envPath);
          if (latest && latest !== used) {
            used = latest;
            unsaved = null;
            result = await requestToken(used);
          }
          if (!result.ok && result.body?.error === "invalid_grant") {
            throw new XeroAuthLostError(String(result.body.error_description ?? "invalid_grant"));
          }
        }
        if (!result.ok) {
          throw new Error(`Xero token request failed (${result.status}): ${result.text}`);
        }

        const rotated: string = result.body.refresh_token ?? used;
        if (rotated !== onDisk) await saveRotated(rotated);
        cached = {
          accessToken: result.body.access_token,
          expiresAt: now() + Number(result.body.expires_in ?? 1800) * 1000
        };
        return cached.accessToken;
      },
      envPath,
      options.lock
    );
  }

  return {
    async getAccessToken() {
      if (cached && cached.expiresAt > now() + EXPIRY_MARGIN_MS) return cached.accessToken;
      if (!inflight) {
        inflight = refresh().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    invalidate() {
      cached = null;
    }
  };
}

let defaultStore: TokenStore | null = null;

/** Process-wide token store shared by XeroClient, XeroWriteClient and XeroFilesClient. */
export function getXeroAccessToken(): Promise<string> {
  defaultStore ??= createTokenStore();
  return defaultStore.getAccessToken();
}
