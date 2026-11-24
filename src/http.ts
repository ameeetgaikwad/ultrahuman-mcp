// The hosted web server: MCP at POST /mcp, plus the one-time OAuth login.
import crypto from "node:crypto";
import express, { type RequestHandler } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthTokens } from "./auth.ts";
import type { AuthMode } from "./config.ts";

export interface WebOptions {
  apiKey: string;
  publicUrl: string;
  mode: AuthMode;
  oauth: OAuthTokens | null;
  createMcpServer: () => McpServer;
}

const LOGIN_STATE_TTL_MS = 10 * 60_000;

export function createApp(opts: WebOptions): express.Express {
  const redirectUri = `${opts.publicUrl}/callback`;
  const expectedKey = Buffer.from(opts.apiKey);

  // Accept the key as "Authorization: Bearer <key>" or as "?key=<key>" in the URL
  // (some apps, like the Claude.ai connector screen, only let you paste a URL).
  const keyMatches = (given: unknown): boolean => {
    if (typeof given !== "string") return false;
    const a = Buffer.from(given);
    return a.length === expectedKey.length && crypto.timingSafeEqual(a, expectedKey);
  };
  const requireKey: RequestHandler = (req, res, next) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (keyMatches(bearer) || keyMatches(req.query.key)) return next();
    res.status(401).json({ error: "Wrong or missing MCP_API_KEY" });
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/", async (_req, res) => {
    const connected = opts.mode === "token" || Boolean(await opts.oauth?.isConnected());
    res.json({ name: "ultrahuman-mcp", mode: opts.mode, connected, mcp: `${opts.publicUrl}/mcp` });
  });
  app.get("/health", (_req, res) => {
    res.send("ok");
  });

  // A fresh MCP server per request keeps things stateless (no sessions to track).
  // The Ultrahuman client underneath is shared, so its cache survives between requests.
  app.post("/mcp", requireKey, async (req, res) => {
    const server = opts.createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    }
  });
  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").send("Use POST");
  });

  // One-time Ultrahuman login for OAuth mode.
  const pendingStates = new Set<string>();
  app.get("/login", requireKey, (_req, res) => {
    if (!opts.oauth) {
      res.send("Using a personal API token, no login needed.");
      return;
    }
    const state = crypto.randomBytes(16).toString("hex");
    pendingStates.add(state);
    setTimeout(() => pendingStates.delete(state), LOGIN_STATE_TTL_MS).unref();
    res.redirect(opts.oauth.loginUrl(redirectUri, state));
  });
  app.get("/callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (typeof error === "string") {
      res.status(400).type("text/plain").send(`Ultrahuman said: ${error}`);
      return;
    }
    if (!opts.oauth || typeof code !== "string" || typeof state !== "string" || !pendingStates.delete(state)) {
      res.status(400).send("Login link expired or invalid. Open /login again.");
      return;
    }
    try {
      await opts.oauth.finishLogin(code, redirectUri);
      res.send("Connected to Ultrahuman. You can close this tab and start chatting.");
    } catch (err) {
      console.error(err);
      res.status(500).type("text/plain").send(err instanceof Error ? err.message : String(err));
    }
  });

  return app;
}
