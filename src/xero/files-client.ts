import { config } from "../config.js";
import { getXeroAccessToken } from "./token-store.js";

type AnyRecord = Record<string, any>;


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
    // Shared, disk-backed token store: see token-store.ts for why clients must not keep their own copy.
    return getXeroAccessToken();
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
