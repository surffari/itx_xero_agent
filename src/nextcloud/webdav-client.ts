import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const SECRETS_PATH = "/opt/secrets/nextcloud_bills_agent.env";

export interface NextcloudCredentials {
  baseUrl: string; // e.g. https://cloud.gopure.shop/remote.php/dav/files/xero-agent/Xero-Bills/
  user: string;
  appPassword: string;
}

/**
 * Loads the dedicated `xero-agent` service-account credentials (D10) from the
 * centralized secrets store — never from this repo's own .env. Read once per process;
 * throws (does not silently fall back) if any of the three keys is missing.
 */
export function loadNextcloudCredentials(): NextcloudCredentials {
  const parsed = loadDotenv({ path: SECRETS_PATH }).parsed ?? {};
  const baseUrl = parsed.NEXTCLOUD_WEBDAV_URL;
  const user = parsed.NEXTCLOUD_WEBDAV_USER;
  const appPassword = parsed.NEXTCLOUD_WEBDAV_APP_PASSWORD;
  const missing = [
    ["NEXTCLOUD_WEBDAV_URL", baseUrl],
    ["NEXTCLOUD_WEBDAV_USER", user],
    ["NEXTCLOUD_WEBDAV_APP_PASSWORD", appPassword],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Missing Nextcloud WebDAV credentials in ${SECRETS_PATH}: ${missing.join(", ")}`);
  }
  return { baseUrl: baseUrl!, user: user!, appPassword: appPassword! };
}

/**
 * Minimal WebDAV client for the `xero-agent` Nextcloud account (D10). Only what Bills
 * Management needs: upload a file into a status subfolder, move a file between folders,
 * download a file back (e.g. to edit the shared review-log workbook in place), and list
 * a folder's current contents (for verifying what actually landed, not trusting an
 * upload's own success return value). Never logs the Authorization header or the raw
 * app-password.
 */
export class NextcloudWebDavClient {
  private readonly creds: NextcloudCredentials;

  constructor(creds: NextcloudCredentials = loadNextcloudCredentials()) {
    this.creds = creds;
  }

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.creds.user}:${this.creds.appPassword}`).toString("base64");
  }

  private urlFor(relativePath: string): string {
    const base = this.creds.baseUrl.endsWith("/") ? this.creds.baseUrl : this.creds.baseUrl + "/";
    const encodedSegments = relativePath
      .split("/")
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    return base + encodedSegments;
  }

  /** PUT a file into `relativePath` (e.g. "📥 01 - Incoming/23_ESA 7500.pdf"). Overwrites if it already exists. */
  async uploadFile(relativePath: string, data: Buffer, contentType = "application/pdf"): Promise<void> {
    const resp = await fetch(this.urlFor(relativePath), {
      method: "PUT",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": contentType,
      },
      body: data as unknown as BodyInit,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`WebDAV PUT ${relativePath} failed (${resp.status}): ${detail.slice(0, 300)}`);
    }
  }

  /**
   * WebDAV MOVE — relocates a file already in Nextcloud (e.g. Incoming -> Ready for
   * Xero) without re-downloading/re-uploading it. Overwrite:F — fails loudly on an
   * unexpected name collision at the destination rather than silently overwriting.
   */
  async moveFile(fromRelativePath: string, toRelativePath: string): Promise<void> {
    const resp = await fetch(this.urlFor(fromRelativePath), {
      method: "MOVE",
      headers: {
        Authorization: this.authHeader(),
        Destination: this.urlFor(toRelativePath),
        Overwrite: "F",
      },
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`WebDAV MOVE ${fromRelativePath} -> ${toRelativePath} failed (${resp.status}): ${detail.slice(0, 300)}`);
    }
  }

  /** DELETE a file. Used only for cleaning up a known mistaken duplicate — never for a document's canonical copy. */
  async deleteFile(relativePath: string): Promise<void> {
    const resp = await fetch(this.urlFor(relativePath), {
      method: "DELETE",
      headers: { Authorization: this.authHeader() },
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`WebDAV DELETE ${relativePath} failed (${resp.status}): ${detail.slice(0, 300)}`);
    }
  }

  /** GET a file's raw bytes. Used to read back a document already in Nextcloud (e.g. the shared review-log workbook) before editing it in place. */
  async downloadFile(relativePath: string): Promise<Buffer> {
    const resp = await fetch(this.urlFor(relativePath), {
      method: "GET",
      headers: { Authorization: this.authHeader() },
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`WebDAV GET ${relativePath} failed (${resp.status}): ${detail.slice(0, 300)}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  /** PROPFIND Depth:1 on a folder; returns the names of its immediate children (files and subfolders). */
  async listFolder(relativePath: string): Promise<string[]> {
    const resp = await fetch(this.urlFor(relativePath), {
      method: "PROPFIND",
      headers: {
        Authorization: this.authHeader(),
        Depth: "1",
        "Content-Type": "application/xml",
      },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`WebDAV PROPFIND ${relativePath} failed (${resp.status}): ${detail.slice(0, 300)}`);
    }
    const xml = await resp.text();
    const hrefs = [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => decodeURIComponent(m[1]));
    // First href is the folder itself; the rest are children. Return just the last path segment of each.
    return hrefs
      .slice(1)
      .map((href) => href.replace(/\/$/, "").split("/").pop() ?? "")
      .filter(Boolean);
  }
}
