import http from "node:http";
import readline from "node:readline";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { updateDotEnv } from "../lib/envFile.js";

type AnyRecord = Record<string, any>;

export async function runXeroAuthFlow(
  options: {
    timeoutSeconds?: number;
    printUrlOnly?: boolean;
    redirectUri?: string;
    manual?: boolean;
  } = {}
) {
  if (!config.XERO_CLIENT_ID || !config.XERO_CLIENT_SECRET || !config.XERO_REDIRECT_URI) {
    throw new Error("XERO_CLIENT_ID, XERO_CLIENT_SECRET, and XERO_REDIRECT_URI are required.");
  }

  const redirectUri = options.redirectUri ?? config.XERO_REDIRECT_URI;
  const state = randomBytes(24).toString("hex");
  const authUrl = new URL("https://login.xero.com/identity/connect/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.XERO_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", config.XERO_AUTH_SCOPES);
  authUrl.searchParams.set("state", state);

  console.log("Open this Xero authorization URL in your browser:");
  console.log(authUrl.toString());
  console.log("");

  if (options.printUrlOnly) return;

  let code: string;
  if (options.manual) {
    code = await promptForCode(redirectUri, state);
  } else {
    const redirect = new URL(redirectUri);
    const timeoutMs = (options.timeoutSeconds ?? 300) * 1000;
    const callback = await waitForCallback(redirect, state, timeoutMs);
    code = callback.code;
  }

  const token = await exchangeCodeForToken(code, redirectUri);
  await updateDotEnv({
    XERO_REDIRECT_URI: options.redirectUri,
    XERO_REFRESH_TOKEN: token.refresh_token,
    XERO_TENANT_ID: await maybeResolveSingleTenantId(token.access_token)
  });

  console.log("Xero refresh token saved to .env.");
  if (!token.refresh_token) {
    console.warn("Xero did not return a refresh token. Confirm the authorization URL included offline_access.");
  }
}

function promptForCode(redirectUri: string, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`Redirect URI is: ${redirectUri}`);
    console.log("After authorizing, your browser will be redirected to that URI.");
    console.log("It may fail to load — that's fine. Copy the full URL from your browser's address bar and paste it here.");
    console.log("");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Paste the full redirect URL: ", (answer) => {
      rl.close();
      try {
        const parsed = new URL(answer.trim());
        const error = parsed.searchParams.get("error");
        if (error) {
          reject(new Error(`Xero authorization failed: ${parsed.searchParams.get("error_description") ?? error}`));
          return;
        }
        const returnedState = parsed.searchParams.get("state");
        if (returnedState !== expectedState) {
          reject(new Error(`OAuth state mismatch — expected ${expectedState}, got ${returnedState}`));
          return;
        }
        const code = parsed.searchParams.get("code");
        if (!code) {
          reject(new Error("No authorization code found in the pasted URL."));
          return;
        }
        resolve(code);
      } catch {
        reject(new Error(`Could not parse URL: ${answer}`));
      }
    });
  });
}

function waitForCallback(redirect: URL, expectedState: string, timeoutMs: number): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const host = redirect.hostname === "localhost" ? "127.0.0.1" : redirect.hostname;
    const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
    const expectedPath = redirect.pathname || "/";

    const server = http.createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", redirect.origin);
        if (requestUrl.pathname !== expectedPath) {
          res.writeHead(404).end("Not found");
          return;
        }
        const error = requestUrl.searchParams.get("error");
        if (error) {
          const description = requestUrl.searchParams.get("error_description") ?? error;
          res.writeHead(400, { "content-type": "text/plain" }).end(`Xero authorization failed: ${description}`);
          cleanup();
          reject(new Error(`Xero authorization failed: ${description}`));
          return;
        }
        const state = requestUrl.searchParams.get("state");
        if (state !== expectedState) {
          res.writeHead(400, { "content-type": "text/plain" }).end("Invalid OAuth state.");
          cleanup();
          reject(new Error("Invalid OAuth state returned by callback."));
          return;
        }
        const code = requestUrl.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "content-type": "text/plain" }).end("Missing authorization code.");
          cleanup();
          reject(new Error("Xero callback did not include an authorization code."));
          return;
        }
        res.writeHead(200, { "content-type": "text/html" }).end(
          "<h1>Xero connected</h1><p>You can close this tab and return to the terminal.</p>"
        );
        cleanup();
        resolve({ code });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Xero OAuth callback."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (error) => {
      cleanup();
      reject(error);
    });
    server.listen(port, host);
  });
}

async function exchangeCodeForToken(code: string, redirectUri: string): Promise<AnyRecord> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri
  });
  const basic = Buffer.from(`${config.XERO_CLIENT_ID}:${config.XERO_CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  return parseXeroResponse(response, "token exchange");
}

async function maybeResolveSingleTenantId(accessToken: string): Promise<string | undefined> {
  const response = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const tenants = await parseXeroResponse<AnyRecord[]>(response, "connections");
  if (tenants.length === 1 && tenants[0]?.tenantId) {
    console.log(`Single Xero tenant found; saving XERO_TENANT_ID=${tenants[0].tenantId}.`);
    return tenants[0].tenantId;
  }
  if (tenants.length > 1) {
    console.log("Multiple Xero tenants are connected. Set XERO_TENANT_ID manually if you want a specific tenant:");
    for (const tenant of tenants) {
      console.log(`- ${tenant.tenantName ?? "(unnamed)"}: ${tenant.tenantId}`);
    }
  }
  return undefined;
}

async function parseXeroResponse<T = AnyRecord>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error_description ?? parsed.Detail ?? parsed.Message ?? JSON.stringify(parsed);
    } catch {
      // keep raw body
    }
    throw new Error(`Xero ${label} failed (${response.status}): ${detail}`);
  }
  return JSON.parse(text) as T;
}
