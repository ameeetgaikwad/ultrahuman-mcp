// Small client for the Ultrahuman API.
// Two ways to log in:
//   1. Personal API token  -> set ULTRAHUMAN_API_TOKEN
//   2. OAuth partner app   -> set ULTRAHUMAN_CLIENT_ID + ULTRAHUMAN_CLIENT_SECRET, then visit /login once
import fs from "node:fs/promises";
import path from "node:path";

const API = "https://partner.ultrahuman.com";
const AUTHORIZE_URL = "https://auth.ultrahuman.com/authorise";
const TOKEN_URL = `${API}/api/partners/oauth/token`;

const env = process.env;
export const SCOPES = env.ULTRAHUMAN_SCOPES || "profile ring_data cgm_data";
// Railway sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached, so the login
// survives restarts without any extra setup. Elsewhere it goes in ./data.
export const TOKEN_FILE =
  env.TOKEN_FILE || path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH || "data", "tokens.json");

export const mode = env.ULTRAHUMAN_API_TOKEN
  ? "token"
  : env.ULTRAHUMAN_CLIENT_ID && env.ULTRAHUMAN_CLIENT_SECRET
    ? "oauth"
    : null;

// ---------- OAuth token storage (only used in "oauth" mode) ----------

let tokens = null; // { access_token, refresh_token, expires_at }
let refreshing = null; // shared promise so we never refresh twice at once

async function loadTokens() {
  if (tokens) return tokens;
  try {
    tokens = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
  } catch {
    // No saved file yet. Allow a refresh token from env as a starting point.
    if (env.ULTRAHUMAN_REFRESH_TOKEN) {
      tokens = { refresh_token: env.ULTRAHUMAN_REFRESH_TOKEN, expires_at: 0 };
    }
  }
  return tokens;
}

async function saveTokens(data) {
  tokens = {
    access_token: data.access_token,
    // Ultrahuman gives a new refresh token each time; keep the old one if not.
    refresh_token: data.refresh_token || tokens?.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 86400) * 1000,
  };
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  // Only this user can read the file: it holds the keys to your health data.
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function requestToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ULTRAHUMAN_CLIENT_ID,
      client_secret: env.ULTRAHUMAN_CLIENT_SECRET,
      ...params,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ultrahuman login failed (${res.status}): ${text.slice(0, 300)}`);
  await saveTokens(JSON.parse(text));
}

export function loginUrl(redirectUri, state) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.ULTRAHUMAN_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${q}`;
}

export function finishLogin(code, redirectUri) {
  return requestToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

function refresh() {
  refreshing ??= (async () => {
    const t = await loadTokens();
    if (!t?.refresh_token) {
      throw new Error("Not connected to Ultrahuman yet. Open /login on this server in your browser first.");
    }
    await requestToken({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  })().finally(() => (refreshing = null));
  return refreshing;
}

async function accessToken() {
  const t = await loadTokens();
  if (!t?.access_token || Date.now() > t.expires_at - 60_000) await refresh();
  return tokens.access_token;
}

// ---------- API calls ----------

async function get(pathname, params = {}) {
  const url = `${API}${pathname}?${new URLSearchParams(params)}`;

  const send = async () => {
    const auth = mode === "token" ? env.ULTRAHUMAN_API_TOKEN : `Bearer ${await accessToken()}`;
    return fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
  };

  let res = await send();
  if (res.status === 401 && mode === "oauth") {
    await refresh(); // token was rejected, refresh and try once more
    res = await send();
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`Ultrahuman API error ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** All ring (and CGM, if you have one) metrics for one day. date = YYYY-MM-DD */
export function getDailyMetrics(date) {
  return mode === "token"
    ? get("/api/v1/partner/daily_metrics", { date })
    : get("/api/partners/v1/user_data/metrics", { date });
}

/** Basic profile info. Only available with an OAuth app. */
export function getUserInfo() {
  return get("/api/partners/v1/user_data/user_info");
}

export async function isConnected() {
  if (mode === "token") return true;
  if (mode === "oauth") return Boolean((await loadTokens())?.refresh_token);
  return false;
}
