import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UltrahumanApi } from "../src/api.ts";
import { OAuthTokens, TOKEN_URL } from "../src/auth.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function tokenFile(contents: object): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uh-test-"));
  const file = path.join(dir, "tokens.json");
  await fs.writeFile(file, JSON.stringify(contents));
  return file;
}

function oauth(file: string, fetchFn: typeof fetch) {
  return new OAuthTokens({ clientId: "id", clientSecret: "secret", scopes: "ring_data", tokenFile: file, fetch: fetchFn });
}

test("concurrent calls with an expired token refresh exactly once", async () => {
  const file = await tokenFile({ access_token: "old", refresh_token: "r1", expires_at: 0 });
  let tokenCalls = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    if (String(input) === TOKEN_URL) {
      tokenCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return json({ access_token: "new", refresh_token: "r2", expires_in: 3600 });
    }
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer new");
    return json({ data: {} });
  };
  const api = new UltrahumanApi({ mode: "oauth", oauth: oauth(file, fetchFn) }, { fetch: fetchFn });

  await api.dailyMetricsMany(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);

  assert.equal(tokenCalls, 1);
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.refresh_token, "r2");
});

test("parallel 401s on the same token trigger one refresh, then retry", async () => {
  const file = await tokenFile({ access_token: "stale", refresh_token: "r1", expires_at: Date.now() + 3_600_000 });
  let tokenCalls = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    if (String(input) === TOKEN_URL) {
      tokenCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 });
    }
    const auth = new Headers(init?.headers).get("Authorization");
    return auth === "Bearer fresh" ? json({ ok: true }) : json({ error: "expired" }, 401);
  };
  const api = new UltrahumanApi({ mode: "oauth", oauth: oauth(file, fetchFn) }, { fetch: fetchFn });

  const results = await api.dailyMetricsMany(["2026-01-01", "2026-01-02", "2026-01-03"]);

  assert.equal(tokenCalls, 1);
  for (const r of results.values()) assert.deepEqual(r, { ok: true, data: { ok: true } });
});

test("a day is fetched once and then served from cache", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls++;
    return json({ data: { n: calls } });
  };
  const api = new UltrahumanApi({ mode: "token", apiToken: "t" }, { fetch: fetchFn });

  const [a, b] = await Promise.all([api.dailyMetrics("2026-01-01"), api.dailyMetrics("2026-01-01")]);
  const c = await api.dailyMetrics("2026-01-01");

  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test("5xx is retried, 4xx is not, and failures are not cached", async () => {
  const statuses = [503, 200];
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls++;
    const s = statuses.shift() ?? 400;
    return s === 200 ? json({ data: "ok" }) : json({ error: "nope" }, s);
  };
  const api = new UltrahumanApi({ mode: "token", apiToken: "t" }, { fetch: fetchFn, sleep: async () => {} });

  assert.deepEqual(await api.dailyMetrics("2026-01-01"), { data: "ok" });
  assert.equal(calls, 2);

  await assert.rejects(api.dailyMetrics("2026-01-02"), /Ultrahuman API error 400/);
  await assert.rejects(api.dailyMetrics("2026-01-02"), /Ultrahuman API error 400/);
  assert.equal(calls, 4, "a failed day is fetched again, not served from cache");
});

test("the personal token is sent as-is to the token endpoint", async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const fetchFn: typeof fetch = async (input, init) => {
    seen = { url: String(input), auth: new Headers(init?.headers).get("Authorization") };
    return json({});
  };
  await new UltrahumanApi({ mode: "token", apiToken: "abc" }, { fetch: fetchFn }).dailyMetrics("2026-03-01");
  assert.deepEqual(seen, {
    url: "https://partner.ultrahuman.com/api/v1/partner/daily_metrics?date=2026-03-01",
    auth: "abc",
  });
});
