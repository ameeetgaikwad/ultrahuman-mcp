// Small client for the Ultrahuman API with caching, retries and a concurrency cap.
import type { OAuthTokens } from "./auth.ts";
import { addDays, today } from "./dates.ts";

const API = "https://partner.ultrahuman.com";
const MAX_CACHED_DAYS = 120;
const RECENT_TTL_MS = 5 * 60_000; // today and yesterday can still change
const PAST_TTL_MS = 6 * 60 * 60_000;
const RETRIES = 2;

export class UltrahumanApiError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Ultrahuman API error ${status}: ${body.slice(0, 300)}`);
    this.status = status;
  }
}

export type ApiAuth = { mode: "token"; apiToken: string } | { mode: "oauth"; oauth: OAuthTokens };

export interface ApiOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

interface CacheEntry {
  expires: number;
  value: Promise<unknown>;
}

export type DayResult = { ok: true; data: unknown } | { ok: false; error: string };

export class UltrahumanApi {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly auth: ApiAuth;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(auth: ApiAuth, opts: ApiOptions = {}) {
    this.auth = auth;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.baseUrl = opts.baseUrl ?? API;
  }

  get mode(): ApiAuth["mode"] {
    return this.auth.mode;
  }

  /** All ring (and CGM, if worn) data for one day. Cached; concurrent calls share one request. */
  dailyMetrics(day: string): Promise<unknown> {
    const hit = this.cache.get(day);
    if (hit && hit.expires > this.now()) return hit.value;

    const value = this.get(
      this.auth.mode === "token" ? "/api/v1/partner/daily_metrics" : "/api/partners/v1/user_data/metrics",
      { date: day },
    );
    const recent = day >= addDays(today(new Date(this.now())), -1);
    this.cache.set(day, { value, expires: this.now() + (recent ? RECENT_TTL_MS : PAST_TTL_MS) });
    value.catch(() => this.cache.delete(day)); // never cache a failure
    this.trimCache();
    return value;
  }

  /** Several days, at most `concurrency` requests at a time. One bad day does not sink the rest. */
  async dailyMetricsMany(days: string[], concurrency = 4): Promise<Map<string, DayResult>> {
    const results = new Map<string, DayResult>();
    let next = 0;
    const worker = async () => {
      while (next < days.length) {
        const day = days[next++]!;
        try {
          results.set(day, { ok: true, data: await this.dailyMetrics(day) });
        } catch (err) {
          results.set(day, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, days.length) }, worker));
    return new Map(days.map((d) => [d, results.get(d)!]));
  }

  /** Basic profile info. Only available with an OAuth app. */
  userInfo(): Promise<unknown> {
    return this.get("/api/partners/v1/user_data/user_info");
  }

  private async authHeader(): Promise<{ header: string; token: string }> {
    if (this.auth.mode === "token") return { header: this.auth.apiToken, token: this.auth.apiToken };
    const token = await this.auth.oauth.accessToken();
    return { header: `Bearer ${token}`, token };
  }

  private async get(pathname: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = `${this.baseUrl}${pathname}?${new URLSearchParams(params)}`;
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const { header, token } = await this.authHeader();
      let res: Response;
      try {
        res = await this.fetch(url, { headers: { Authorization: header, Accept: "application/json" } });
      } catch (err) {
        if (attempt < RETRIES) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw err;
      }

      if (res.status === 401 && this.auth.mode === "oauth" && !refreshed) {
        refreshed = true;
        await this.auth.oauth.handleUnauthorized(token); // token was rejected: refresh once and retry
        attempt--;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
        await this.sleep(retryAfterMs(res) ?? backoff(attempt));
        continue;
      }

      const text = await res.text();
      if (!res.ok) throw new UltrahumanApiError(res.status, text);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }

  private trimCache(): void {
    while (this.cache.size > MAX_CACHED_DAYS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

function backoff(attempt: number): number {
  return 500 * 3 ** attempt;
}

function retryAfterMs(res: Response): number | null {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? Math.min(s, 10) * 1000 : null;
}

