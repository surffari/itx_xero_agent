import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTokenStore, XeroAuthLostError } from "./token-store.js";
import { readDotEnvValue, updateDotEnv, withEnvLock } from "../lib/envFile.js";

// Every test uses its own temp .env and a fake Xero: never the real .env, never the network.

/** Fake Xero token endpoint with real rotation semantics: each refresh token works exactly once. */
function fakeXero(initialToken: string, opts: { delayMs?: number } = {}) {
  let valid = new Set([initialToken]);
  let counter = 0;
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    const presented = new URLSearchParams(init.body).get("refresh_token")!;
    calls.push(presented);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (!valid.has(presented)) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token has been consumed" }), {
        status: 400
      });
    }
    valid.delete(presented);
    counter += 1;
    const next = `rt-${counter}`;
    valid.add(next);
    return new Response(JSON.stringify({ access_token: `at-${counter}`, refresh_token: next, expires_in: 1800 }), {
      status: 200
    });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    /** Simulate a fresh `auth --manual` grant. */
    grant(token: string) {
      valid.add(token);
    }
  };
}

async function tempEnv(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "token-store-test-"));
  const envPath = join(dir, ".env");
  await writeFile(envPath, content, { mode: 0o640 });
  return { dir, envPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const base = { clientId: "cid", clientSecret: "secret", lock: { timeoutMs: 5_000, staleMs: 2_000 } };

test("fake Xero rejects a reused refresh token (the old per-client behaviour fails)", async () => {
  const xero = fakeXero("rt-0");
  const first = await xero.fetchImpl("x", { body: "grant_type=refresh_token&refresh_token=rt-0" });
  const second = await xero.fetchImpl("x", { body: "grant_type=refresh_token&refresh_token=rt-0" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 400); // what each old client did with its own copy of the startup token
});

test("concurrent callers in one process share a single refresh", async () => {
  const env = await tempEnv("OTHER=keep\nXERO_REFRESH_TOKEN=rt-0\n");
  try {
    const xero = fakeXero("rt-0", { delayMs: 30 });
    const store = createTokenStore({ ...base, envPath: env.envPath, fetchImpl: xero.fetchImpl });
    const tokens = await Promise.all(Array.from({ length: 5 }, () => store.getAccessToken()));
    assert.deepEqual(new Set(tokens), new Set(["at-1"]));
    assert.equal(xero.calls.length, 1);
    assert.equal(await readDotEnvValue("XERO_REFRESH_TOKEN", env.envPath), "rt-1");
    assert.equal(await readDotEnvValue("OTHER", env.envPath), "keep");
  } finally {
    await env.cleanup();
  }
});

test("two stores (= two clients or two processes) never present a consumed token", async () => {
  const env = await tempEnv("XERO_REFRESH_TOKEN=rt-0\n");
  try {
    const xero = fakeXero("rt-0", { delayMs: 20 });
    let clock = 0;
    const now = () => clock;
    const a = createTokenStore({ ...base, envPath: env.envPath, fetchImpl: xero.fetchImpl, now });
    const b = createTokenStore({ ...base, envPath: env.envPath, fetchImpl: xero.fetchImpl, now });

    // Concurrent first refresh: serialised by the lock, second one reads the rotated token from disk.
    await Promise.all([a.getAccessToken(), b.getAccessToken()]);
    // Later refreshes after expiry, alternating stores.
    for (let i = 0; i < 3; i++) {
      clock += 31 * 60_000;
      await a.getAccessToken();
      await b.getAccessToken();
    }
    assert.equal(xero.calls.length, 8);
    assert.equal(new Set(xero.calls).size, 8, "every refresh token was used exactly once");
    assert.equal(await readDotEnvValue("XERO_REFRESH_TOKEN", env.envPath), "rt-8");
  } finally {
    await env.cleanup();
  }
});

test("invalid_grant re-reads .env once and recovers if auth wrote a new token", async () => {
  const env = await tempEnv("XERO_REFRESH_TOKEN=dead\n");
  try {
    const xero = fakeXero("unused");
    xero.grant("fresh-from-auth");
    let first = true;
    const fetchImpl = (async (url: string, init: any) => {
      if (first) {
        first = false;
        // auth --manual lands while this request is in flight
        await writeFile(env.envPath, "XERO_REFRESH_TOKEN=fresh-from-auth\n");
      }
      return xero.fetchImpl(url, init);
    }) as typeof fetch;
    const store = createTokenStore({ ...base, envPath: env.envPath, fetchImpl });
    assert.equal(await store.getAccessToken(), "at-1");
    assert.deepEqual(xero.calls, ["dead", "fresh-from-auth"]);
    assert.equal(await readDotEnvValue("XERO_REFRESH_TOKEN", env.envPath), "rt-1");
  } finally {
    await env.cleanup();
  }
});

test("a consumed token with no newer one on disk gives a clear re-auth error", async () => {
  const env = await tempEnv("XERO_REFRESH_TOKEN=dead\n");
  try {
    const xero = fakeXero("something-else");
    const store = createTokenStore({ ...base, envPath: env.envPath, fetchImpl: xero.fetchImpl });
    await assert.rejects(store.getAccessToken(), (error: any) => {
      assert.ok(error instanceof XeroAuthLostError);
      assert.match(error.message, /auth --manual/);
      return true;
    });
    assert.equal(xero.calls.length, 1);
  } finally {
    await env.cleanup();
  }
});

test("a failed .env write keeps the rotated token in memory and retries the save", async () => {
  const env = await tempEnv("XERO_REFRESH_TOKEN=rt-0\n");
  try {
    const xero = fakeXero("rt-0");
    let failWrites = true;
    const writes: string[] = [];
    const writeRefreshToken = async (token: string, path: string) => {
      if (failWrites) throw Object.assign(new Error("denied"), { code: "EACCES" });
      writes.push(token);
      await updateDotEnv({ XERO_REFRESH_TOKEN: token }, path);
    };
    let clock = 0;
    const store = createTokenStore({
      ...base,
      envPath: env.envPath,
      fetchImpl: xero.fetchImpl,
      writeRefreshToken,
      now: () => clock
    });
    const origError = console.error;
    console.error = () => {};
    try {
      await store.getAccessToken(); // rt-0 -> rt-1, save fails
    } finally {
      console.error = origError;
    }
    assert.equal(await readDotEnvValue("XERO_REFRESH_TOKEN", env.envPath), "rt-0");

    failWrites = false;
    clock += 31 * 60_000;
    await store.getAccessToken(); // must present rt-1 (memory), not dead rt-0 (disk)
    assert.deepEqual(xero.calls, ["rt-0", "rt-1"]);
    assert.deepEqual(writes, ["rt-2"]);
    assert.equal(await readDotEnvValue("XERO_REFRESH_TOKEN", env.envPath), "rt-2");
  } finally {
    await env.cleanup();
  }
});

test("updateDotEnv is atomic-by-rename and keeps the file mode and other keys", async () => {
  const env = await tempEnv("A=1\nXERO_REFRESH_TOKEN=old\nB=two words\n");
  try {
    await updateDotEnv({ XERO_REFRESH_TOKEN: "new$&token" }, env.envPath);
    assert.equal((await stat(env.envPath)).mode & 0o777, 0o640);
    assert.equal(await readFile(env.envPath, "utf8"), "A=1\nXERO_REFRESH_TOKEN=new$&token\nB=two words\n");
  } finally {
    await env.cleanup();
  }
});

test("a lock left by a dead process is taken over", async () => {
  const env = await tempEnv("X=1\n");
  try {
    // 4194305 > kernel pid_max (4194304), so this pid can never be alive
    await writeFile(`${env.envPath}.lock`, `4194305:deadbeef\n${Date.now()}\n`);
    const result = await withEnvLock(async () => "ran", env.envPath, { timeoutMs: 2_000, staleMs: 60_000 });
    assert.equal(result, "ran");
    await assert.rejects(stat(`${env.envPath}.lock`), { code: "ENOENT" });
  } finally {
    await env.cleanup();
  }
});

test("a live lock is waited for, not stolen", async () => {
  const env = await tempEnv("X=1\n");
  try {
    const order: string[] = [];
    let release!: () => void;
    const held = withEnvLock(
      () =>
        new Promise<void>((resolve) => {
          order.push("first-start");
          release = () => {
            order.push("first-end");
            resolve();
          };
        }),
      env.envPath
    );
    await new Promise((r) => setTimeout(r, 20));
    const second = withEnvLock(async () => {
      order.push("second");
    }, env.envPath, { timeoutMs: 2_000, staleMs: 60_000 });
    await new Promise((r) => setTimeout(r, 200));
    release();
    await Promise.all([held, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  } finally {
    await env.cleanup();
  }
});
