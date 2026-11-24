// Everything the server reads from the environment, parsed once.
import path from "node:path";

export type AuthMode = "token" | "oauth";

export interface Config {
  mode: AuthMode | null;
  apiToken?: string;
  clientId?: string;
  clientSecret?: string;
  /** Optional starting point for OAuth before the first /login. */
  refreshToken?: string;
  scopes: string;
  tokenFile: string;
  mcpApiKey?: string;
  port: number;
  publicUrl: string;
  onRailway: boolean;
  hasPublicAddress: boolean;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const port = Number(env.PORT) || 3000;
  const mode: AuthMode | null = env.ULTRAHUMAN_API_TOKEN
    ? "token"
    : env.ULTRAHUMAN_CLIENT_ID && env.ULTRAHUMAN_CLIENT_SECRET
      ? "oauth"
      : null;

  // Railway sets RAILWAY_PUBLIC_DOMAIN for you. Set PUBLIC_URL for a custom domain or another host.
  const publicUrl = (
    env.PUBLIC_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)
  ).replace(/\/$/, "");

  return {
    mode,
    apiToken: env.ULTRAHUMAN_API_TOKEN,
    clientId: env.ULTRAHUMAN_CLIENT_ID,
    clientSecret: env.ULTRAHUMAN_CLIENT_SECRET,
    refreshToken: env.ULTRAHUMAN_REFRESH_TOKEN,
    scopes: env.ULTRAHUMAN_SCOPES || "profile ring_data cgm_data",
    // Railway sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached, so the login
    // survives restarts without any extra setup. Elsewhere it goes in ./data.
    tokenFile: env.TOKEN_FILE || path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH || "data", "tokens.json"),
    mcpApiKey: env.MCP_API_KEY,
    port,
    publicUrl,
    onRailway: Boolean(env.RAILWAY_ENVIRONMENT),
    hasPublicAddress: Boolean(env.PUBLIC_URL || env.RAILWAY_PUBLIC_DOMAIN),
  };
}
