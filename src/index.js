// Starts the server.
//   npm start              -> web server (for Railway / any host). MCP lives at /mcp
//   node src/index.js --stdio -> local mode for Claude Desktop and similar apps
import crypto from "node:crypto";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./tools.js";
import { mode, loginUrl, finishLogin, isConnected } from "./ultrahuman.js";

const env = process.env;

if (!mode) {
  console.error(
    "Missing Ultrahuman login. Set ULTRAHUMAN_API_TOKEN (easiest), " +
      "or ULTRAHUMAN_CLIENT_ID and ULTRAHUMAN_CLIENT_SECRET. See README.md.",
  );
  process.exit(1);
}

if (process.argv.includes("--stdio")) {
  await createServer().connect(new StdioServerTransport());
} else {
  startWebServer();
}

function startWebServer() {
  const KEY = env.MCP_API_KEY;
  if (!KEY) {
    console.error("Set MCP_API_KEY to a long random password so only you can read your health data.");
    process.exit(1);
  }

  const PORT = Number(env.PORT) || 3000;
  // Railway sets RAILWAY_PUBLIC_DOMAIN for you. Otherwise set PUBLIC_URL.
  const PUBLIC_URL = (
    env.PUBLIC_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)
  ).replace(/\/$/, "");
  const REDIRECT_URI = `${PUBLIC_URL}/callback`;

  // Accept the key as "Authorization: Bearer <key>" or as "?key=<key>" in the URL
  // (some apps, like the Claude.ai connector screen, only let you paste a URL).
  const keyMatches = (given) => {
    const a = Buffer.from(String(given || ""));
    const b = Buffer.from(KEY);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const requireKey = (req, res, next) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (keyMatches(bearer) || keyMatches(req.query.key)) return next();
    res.status(401).json({ error: "Wrong or missing MCP_API_KEY" });
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/", async (_req, res) => {
    res.json({ name: "ultrahuman-mcp", mode, connected: await isConnected(), mcp: `${PUBLIC_URL}/mcp` });
  });
  app.get("/health", (_req, res) => res.send("ok"));

  // A fresh server for every request keeps things simple (no sessions to track).
  app.post("/mcp", requireKey, async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    }
  });
  app.all("/mcp", (_req, res) => res.status(405).set("Allow", "POST").send("Use POST"));

  // One-time Ultrahuman login for OAuth mode.
  const pendingStates = new Set();
  app.get("/login", requireKey, (_req, res) => {
    if (mode !== "oauth") return res.send("Using a personal API token, no login needed.");
    const state = crypto.randomBytes(16).toString("hex");
    pendingStates.add(state);
    setTimeout(() => pendingStates.delete(state), 10 * 60_000);
    res.redirect(loginUrl(REDIRECT_URI, state));
  });
  app.get("/callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).type("text/plain").send(`Ultrahuman said: ${error}`);
    if (!code || !pendingStates.delete(state)) {
      return res.status(400).send("Login link expired or invalid. Open /login again.");
    }
    try {
      await finishLogin(code, REDIRECT_URI);
      res.send("Connected to Ultrahuman. You can close this tab and start chatting.");
    } catch (err) {
      console.error(err);
      res.status(500).type("text/plain").send(String(err.message));
    }
  });

  app.listen(PORT, () => {
    console.log(`Ultrahuman MCP running on ${PUBLIC_URL} (${mode} mode)`);
    console.log(`MCP address: ${PUBLIC_URL}/mcp`);
    if (mode === "oauth") console.log(`Connect your ring once: ${PUBLIC_URL}/login?key=<MCP_API_KEY>`);
  });
}
