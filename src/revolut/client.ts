import { createHmac } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REVOLUT_API_BASE = "https://b2b.revolut.com/api/1.0";
const BROKER_URL = "https://gopure.store/whooks/revolut/broker_api.php";
const TOKEN_SAFETY_SEC = 60;

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_CACHE_FILE = join(__dirname, "../../.revolut_token_cache.json");

export interface RevolutTransaction {
  id: string;
  type: string;
  state: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  reference: string | null;
  legs: {
    leg_id: string;
    account_id: string;
    amount: number;
    currency: string;
    description: string;
    counterparty?: { name?: string; account_id?: string };
  }[];
  merchant?: {
    name: string;
    city?: string;
    category_code?: string;
    country?: string;
  };
  card?: {
    card_number: string; // last 4 digits
    first_name?: string;
    last_name?: string;
  };
}

interface TokenCache {
  access_token: string;
  expires_at: number;
}

function brokerHmacSecret(): string {
  const s = process.env.REVOLUT_BROKER_HMAC ?? "";
  if (!s) throw new Error("REVOLUT_BROKER_HMAC must be set in .env");
  return s;
}

async function callBroker(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const secret = brokerHmacSecret();
  const body = JSON.stringify({ action, params });
  const ts = Math.floor(Date.now() / 1000);
  const message = `v1.${ts}.${body}`;
  const sig = "v1=" + createHmac("sha256", secret).update(message).digest("hex");

  const res = await fetch(BROKER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-RB-Timestamp": String(ts),
      "X-RB-Signature": sig,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Broker HTTP ${res.status}`);
  }
  const data = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
  if (!data.ok) throw new Error(`Broker error: ${data.error}`);
  return data.data;
}

async function getAccessToken(): Promise<string> {
  // Try local cache first
  if (existsSync(TOKEN_CACHE_FILE)) {
    try {
      const cache = JSON.parse(readFileSync(TOKEN_CACHE_FILE, "utf-8")) as TokenCache;
      if (cache.access_token && cache.expires_at > Math.floor(Date.now() / 1000) + TOKEN_SAFETY_SEC) {
        return cache.access_token;
      }
    } catch {
      // stale cache
    }
  }

  // Fetch from broker (broker manages OAuth refresh + rotation)
  const result = (await callBroker("get_access_token")) as { access_token: string };
  const token = result.access_token;
  if (!token) throw new Error("Broker returned no access_token");

  // Cache locally with a conservative 30-min TTL
  // (actual expiry is ~40 min but we don't know the exact value from the broker)
  const cache: TokenCache = { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 1800 };
  try {
    writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache));
  } catch {
    // non-fatal
  }

  return token;
}

export class RevolutClient {
  constructor() {
    // Validate HMAC secret is configured
    brokerHmacSecret();
  }

  async getTransactions(
    accountId: string,
    from: string,
    to: string,
    count = 1000
  ): Promise<RevolutTransaction[]> {
    const token = await getAccessToken();

    const params = new URLSearchParams({
      accountId,
      from: `${from}T00:00:00.000Z`,
      to: `${to}T23:59:59.999Z`,
      count: String(Math.min(count, 1000)),
    });

    const res = await fetch(`${REVOLUT_API_BASE}/transactions?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Revolut transactions API: HTTP ${res.status}: ${text}`);
    }

    return res.json() as Promise<RevolutTransaction[]>;
  }
}
