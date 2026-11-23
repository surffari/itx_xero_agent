import { setTimeout as delay } from "node:timers/promises";
import { config, requireXeroConfig } from "../config.js";
import { updateDotEnv } from "../lib/envFile.js";

type AnyRecord = Record<string, any>;

interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class XeroClient {
  private token: TokenState | null = null;
  private readonly credentials = requireXeroConfig();

  async getTenants(): Promise<AnyRecord[]> {
    const token = await this.getAccessToken();
    const response = await fetch("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${token}` }
    });
    return this.parseResponse<AnyRecord[]>(response, "connections");
  }

  async getAll<T extends AnyRecord>(
    tenantId: string,
    endpoint: string,
    rootKey: string,
    options: { where?: string; order?: string; modifiedAfter?: string } = {}
  ): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    while (true) {
      const params = new URLSearchParams();
      params.set("page", String(page));
      if (options.where) params.set("where", options.where);
      if (options.order) params.set("order", options.order);

      const payload = await this.getAccounting(tenantId, `${endpoint}?${params.toString()}`, options.modifiedAfter);
      const pageItems = Array.isArray(payload[rootKey]) ? (payload[rootKey] as T[]) : [];
      results.push(...pageItems);

      if (pageItems.length < config.XERO_PAGE_SIZE) break;
      page += 1;
    }
    return results;
  }

  async getFinanceApi(tenantId: string, path: string, params?: Record<string, string>): Promise<AnyRecord> {
    const token = await this.getAccessToken();
    const cleanPath = path.replace(/^\//, "");
    let url = `https://api.xero.com/finance.xro/1.0/${cleanPath}`;
    if (params && Object.keys(params).length > 0) {
      url += `?${new URLSearchParams(params).toString()}`;
    }
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json"
      }
    });
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : config.XERO_RATE_LIMIT_RETRY_MS;
      await delay(Number.isFinite(waitMs) ? waitMs : config.XERO_RATE_LIMIT_RETRY_MS);
      return this.getFinanceApi(tenantId, path, params);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Finance API ${path} → ${response.status}. ` +
        `Bank Statements Plus is restricted for this app. Continue in Accounting API fallback mode; ` +
        `raw unreconciled Xero bank-feed lines will not be available from Xero.`
      );
    }
    return this.parseResponse<AnyRecord>(response, path);
  }

  async getAccounting(tenantId: string, path: string, modifiedAfter?: string): Promise<AnyRecord> {
    const token = await this.getAccessToken();
    const url = `https://api.xero.com/api.xro/2.0/${path.replace(/^\//, "")}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Xero-tenant-id": tenantId,
      Accept: "application/json"
    };
    if (modifiedAfter) headers["If-Modified-Since"] = modifiedAfter;

    const response = await fetch(url, { headers });
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : config.XERO_RATE_LIMIT_RETRY_MS;
      await delay(Number.isFinite(waitMs) ? waitMs : config.XERO_RATE_LIMIT_RETRY_MS);
      return this.getAccounting(tenantId, path, modifiedAfter);
    }
    return this.parseResponse<AnyRecord>(response, path);
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.token?.refreshToken ?? this.credentials.refreshToken
    });
    const basic = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString("base64");
    const response = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const token = await this.parseResponse<AnyRecord>(response, "token");
    this.token = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? this.credentials.refreshToken,
      expiresAt: Date.now() + Number(token.expires_in ?? 1800) * 1000
    };

    if (token.refresh_token && token.refresh_token !== this.credentials.refreshToken) {
      await updateDotEnv({ XERO_REFRESH_TOKEN: token.refresh_token });
      this.credentials.refreshToken = token.refresh_token;
      console.warn("Xero returned a rotated refresh token. XERO_REFRESH_TOKEN was updated in .env.");
    }
    return this.token.accessToken;
  }

  private async parseResponse<T>(response: Response, label: string): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        detail = parsed.Detail ?? parsed.Message ?? JSON.stringify(parsed);
      } catch {
        // leave raw text
      }
      throw new Error(`Xero ${label} request failed (${response.status}): ${detail}`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }
}
