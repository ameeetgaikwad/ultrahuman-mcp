// OAuth token handling for the Ultrahuman partner app (only used in "oauth" mode).
import fs from "node:fs/promises";
import path from "node:path";

export const AUTHORIZE_URL = "https://auth.ultrahuman.com/authorise";
export const TOKEN_URL = "https://partner.ultrahuman.com/api/partners/oauth/token";

/** Same shape as the file the JS version wrote, so an existing login keeps working. */
export interface SavedTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number | string;
}

export interface OAuthOptions {
  clientId: string;
  clientSecret: string;
  scopes: string;
  tokenFile: string;
  /** Used only when there is no token file yet. */
  initialRefreshToken?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class OAuthTokens {
  private tokens: SavedTokens | null = null;
  private loaded = false;
  private refreshing: Promise<void> | null = null;
  private readonly opts: OAuthOptions;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(opts: OAuthOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  loginUrl(redirectUri: string, state: string): string {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.opts.clientId,
      redirect_uri: redirectUri,
      scope: this.opts.scopes,
      state,
    });
    return `${AUTHORIZE_URL}?${q}`;
  }

  async finishLogin(code: string, redirectUri: string): Promise<void> {
    await this.requestToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  async isConnected(): Promise<boolean> {
    return Boolean((await this.load())?.refresh_token);
  }

  /** A valid access token, refreshing first if it is missing or about to expire. */
  async accessToken(): Promise<string> {
    const t = await this.load();
    if (!t?.access_token || this.now() > t.expires_at - 60_000) await this.refresh();
    const token = this.tokens?.access_token;
    if (!token) throw new Error("Ultrahuman did not return an access token.");
    return token;
  }

  /**
   * Called when Ultrahuman rejected `rejected`. Only refresh if nobody has replaced that
   * token yet: Ultrahuman rotates refresh tokens, so refreshing twice would reuse a dead one.
   */
  async handleUnauthorized(rejected: string): Promise<void> {
    if (this.tokens?.access_token === rejected) await this.refresh();
  }

  /** Refresh the access token. Concurrent callers share one request. */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const t = await this.load();
      if (!t?.refresh_token) {
        throw new Error("Not connected to Ultrahuman yet. Open /login on this server in your browser first.");
      }
      await this.requestToken({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async load(): Promise<SavedTokens | null> {
    if (this.loaded) return this.tokens;
    try {
      this.tokens = JSON.parse(await fs.readFile(this.opts.tokenFile, "utf8")) as SavedTokens;
    } catch {
      // No saved login yet. A refresh token from the environment can seed it.
      if (this.opts.initialRefreshToken) {
        this.tokens = { refresh_token: this.opts.initialRefreshToken, expires_at: 0 };
      }
    }
    this.loaded = true;
    return this.tokens;
  }

  private async requestToken(params: Record<string, string>): Promise<void> {
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        ...params,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Ultrahuman login failed (${res.status}): ${text.slice(0, 300)}`);
    await this.save(JSON.parse(text) as TokenResponse);
  }

  private async save(data: TokenResponse): Promise<void> {
    this.tokens = {
      access_token: data.access_token,
      // Ultrahuman usually sends a new refresh token; keep the old one if it does not.
      refresh_token: data.refresh_token || this.tokens?.refresh_token,
      expires_at: this.now() + (Number(data.expires_in) || 86_400) * 1000,
    };
    this.loaded = true;
    await fs.mkdir(path.dirname(this.opts.tokenFile), { recursive: true });
    // Only this user can read the file: it holds the keys to your health data.
    await fs.writeFile(this.opts.tokenFile, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
  }
}
