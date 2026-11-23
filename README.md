# Intactix Accounting Agent (Xero Agent)

Accounting agent for **Intactix B.V.** (GoPure EU), single Xero tenant. It syncs Xero data into
its own MySQL warehouse, reconciles transactions against PrestaShop orders and bank feeds
(Wise, Revolut), reads supplier invoices from the `xero@intactix.io` mailbox and prepares
**DRAFT** bills in Xero for human approval. It runs as the `intactix` OpenClaw agent and is
used by the VAs through Slack and Claude Code.

- Implementation plan and phase status: [`PLAN.md`](PLAN.md)
- Project rules for Claude Code: [`CLAUDE.md`](CLAUDE.md)
- VA operating procedure: [`docs/sop-va-xero-agent.html`](docs/sop-va-xero-agent.html)
  (published on Confluence as "Xero Agent")
- Accounting knowledge (VAT rules, open questions, rule register): [`knowledge/`](knowledge/)

## Safety rules (non-negotiable)

- Xero bills and invoices are created as **DRAFT** only, never auto-approved.
- Missing or uncertain invoice data goes to Needs Review; it is never invented.
- The IMAP mailbox is read-only (never mark, move or delete).
- Every write is gated: `XERO_WRITE_ENABLED`, idempotency key, audit log in `xero_write_log`.

## Layout

| Path | What |
|---|---|
| `src/cli.ts` | CLI: `auth`, `migrate`, `sync …` |
| `src/mcp/server.ts` | MCP server the OpenClaw gateway spawns (`intactix-tools`) |
| `src/xero/` | Xero read (`client.ts`), write (`write-client.ts`), Files API (`files-client.ts`), OAuth (`auth.ts`, `token-store.ts`), sync |
| `src/bills/`, `src/email/`, `src/nextcloud/` | Mailbox-to-draft-bill pipeline, routing, duplicate checks, Nextcloud status folders |
| `src/reconcile/`, `src/apply/`, `src/learn/` | Reconciliation engine, apply orchestrator, learning loop |
| `src/presta/`, `src/wise/`, `src/revolut/`, `src/vat/`, `src/accounting/` | Source connectors and accounting rules |
| `migrations/` | SQL schema for `intactix_agent_db` (apply with `npm run migrate`) |
| `scripts/` | One-off and operational scripts (batch drafts, polls, checks). Many are dated, single-use records of past runs. |

Not in git (see `.gitignore`): `.env`, `.keys/`, `node_modules/`, `dist/`, and all business data:
`workspace/` (agent workspace and memory), `audit/`, `scratch-incoming-review/`, PDFs.

## Setup

Requires Node 24 and the local MySQL `intactix_agent_db`.

```bash
npm ci
cp .env.example .env      # fill in values; never commit .env
npm run migrate
npm run check             # type-check
npm test
```

On the server the project lives in `/opt/projects/openclaw/gopure/intactix` (owner
`surffari`, group `gopure`, `.env` mode 0640). The gateway runs the MCP server from `src/`
via tsx with this directory as cwd, so source changes take effect after a gateway restart
(`systemctl --user restart openclaw-gateway.service`). `dist/` is not used at runtime.

## Xero connection

### Re-authorising (when the agent reports "Xero connection lost")

```bash
cd /opt/projects/openclaw/gopure/intactix
npx tsx src/cli.ts auth --manual
```

1. Open the printed URL and log in to Xero with a user who has access to the Intactix B.V. organisation; approve.
2. The browser is sent to `https://localhost/callback?code=…&state=…` and the page fails to load. That is expected.
3. Copy the full URL from the address bar and paste it into the terminal within a few minutes (the code is single-use).
4. The new refresh token is saved to `.env`. Confirm with a read-only call, e.g. `npm run sync:reference`.

With an `https://` redirect URI the CLI uses this manual flow automatically; the local callback
server only works with an `http://localhost:<port>` redirect URI registered in the Xero app.

### How the token is shared

Xero rotates the refresh token on every refresh and invalidates the old one. All Xero clients
get their access token from one module, `src/xero/token-store.ts`:

- the refresh token is read from `.env` **on disk** at each refresh, never kept from process start;
- refreshes are serialised across processes with a lock file (`.env.lock`) and de-duplicated in-process;
- the rotated token is written back atomically (temp file + rename, file mode preserved);
- on `invalid_grant` it re-reads `.env` once (in case `auth` just wrote a new token), otherwise it
  throws `XeroAuthLostError` with the re-auth instruction above.

Do not add another Xero client with its own token refresh: call `getXeroAccessToken()`.

## Tests

`npm test` runs the unit tests listed in `package.json` (no network, no database). Tests that
touch `.env` use a temp file. `scripts/test-*.mjs` are integration checks against the real
database; read them before running.
