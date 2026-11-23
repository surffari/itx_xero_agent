import { config, requireXeroConfig } from "../config.js";
import { updateDotEnv } from "../lib/envFile.js";

type AnyRecord = Record<string, any>;

interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface InboxFile {
  fileId: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdDateUtc: string | null;
}

interface FilesFolder {
  Id?: string;
  FileCount?: number;
}

/**
 * Xero Files API client (https://api.xero.com/files.xro/1.0/).
 * Requires `files.read` OAuth scope — add it to XERO_AUTH_SCOPES and re-run consent.
 * Lists inbox files and downloads content for matching. File deletion is
 * available for cleanup after a file is confidently attached to a Xero bill.
 */
export class XeroFilesClient {
  private token: TokenState | null = null;
  private readonly credentials = requireXeroConfig();

  async listInboxFiles(tenantId: string): Promise<InboxFile[]> {
    const token = await this.getAccessToken();
    const inboxResp = await fetch("https://api.xero.com/files.xro/1.0/Inbox", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });
    const inbox = await this.parseResponse<FilesFolder>(inboxResp, "getInbox");
    if (!inbox.Id) return [];

    const files: AnyRecord[] = [];
    const pageSize = 100;
    for (let page = 1; ; page += 1) {
      const resp = await fetch(
        `https://api.xero.com/files.xro/1.0/Files?pagesize=${pageSize}&page=${page}&sort=CreatedDateUTC&direction=DESC`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Xero-tenant-id": tenantId,
            Accept: "application/json",
          },
        }
      );
      const body = await this.parseResponse<AnyRecord>(resp, "listFiles");
      const items = Array.isArray(body.Items) ? body.Items : [];
      files.push(...items.filter((f) => f.FolderId === inbox.Id));

      const totalCount = Number(body.TotalCount ?? items.length);
      if (items.length === 0 || page * pageSize >= totalCount) break;
      if (inbox.FileCount !== undefined && files.length >= inbox.FileCount) break;
    }

    return files.map((f) => ({
      fileId: f.Id ?? f.FileId ?? "",
      fileName: f.Name ?? f.FileName ?? "",
      mimeType: f.MimeType ?? f.ContentType ?? null,
      sizeBytes: f.Size ?? f.FileSize ?? null,
      createdDateUtc: f.CreatedDateUtc ?? f.Created ?? null,
    }));
  }

  async downloadFile(tenantId: string, fileId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const token = await this.getAccessToken();
    const resp = await fetch(`https://api.xero.com/files.xro/1.0/Files/${fileId}/Content`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": tenantId,
      },
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`Xero Files downloadFile ${resp.status}: ${detail}`);
    }
    const contentType = resp.headers.get("content-type") ?? "application/octet-stream";
    const buffer = Buffer.from(await resp.arrayBuffer());
    return { buffer, mimeType: contentType };
  }

  async deleteFile(tenantId: string, fileId: string): Promise<void> {
    const token = await this.getAccessToken();
    const resp = await fetch(`https://api.xero.com/files.xro/1.0/Files/${fileId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`Xero Files deleteFile ${resp.status}: ${detail}`);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.accessToken;
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.token?.refreshToken ?? this.credentials.refreshToken,
    });
    const basic = Buffer.from(
      `${this.credentials.clientId}:${this.credentials.clientSecret}`
    ).toString("base64");
    const response = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const token = await this.parseResponse<AnyRecord>(response, "token");
    this.token = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? this.credentials.refreshToken,
      expiresAt: Date.now() + Number(token.expires_in ?? 1800) * 1000,
    };
    if (token.refresh_token && token.refresh_token !== this.credentials.refreshToken) {
      await updateDotEnv({ XERO_REFRESH_TOKEN: token.refresh_token });
      this.credentials.refreshToken = token.refresh_token;
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
      throw new Error(`Xero Files ${label} failed (${response.status}): ${detail}`);
    }
    return text ? (JSON.parse(text) as T) : ([] as unknown as T);
  }
}
