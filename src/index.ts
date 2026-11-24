// Starts the server.
//   npm start                       -> web server (for Railway / any host). MCP lives at /mcp
//   node dist/index.js --stdio      -> local mode for Claude Desktop and similar apps
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { UltrahumanApi, type ApiAuth } from "./api.ts";
import { OAuthTokens } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { createApp } from "./http.ts";
import { createMcpServer } from "./server.ts";

const config = loadConfig();

if (!config.mode) {
  console.error(
    "Missing Ultrahuman login. Set ULTRAHUMAN_API_TOKEN (easiest), " +
      "or ULTRAHUMAN_CLIENT_ID and ULTRAHUMAN_CLIENT_SECRET. See README.md.",
  );
  process.exit(1);
}

const oauth =
  config.mode === "oauth"
    ? new OAuthTokens({
        clientId: config.clientId!,
        clientSecret: config.clientSecret!,
        scopes: config.scopes,
        tokenFile: config.tokenFile,
        initialRefreshToken: config.refreshToken,
      })
    : null;
const auth: ApiAuth = oauth ? { mode: "oauth", oauth } : { mode: "token", apiToken: config.apiToken! };
const api = new UltrahumanApi(auth);
const mcp = () => createMcpServer(api);

if (process.argv.includes("--stdio")) {
  await mcp().connect(new StdioServerTransport());
} else {
  if (!config.mcpApiKey) {
    console.error("Set MCP_API_KEY to a long random password so only you can read your health data.");
    process.exit(1);
  }
  const app = createApp({
    apiKey: config.mcpApiKey,
    publicUrl: config.publicUrl,
    mode: config.mode,
    oauth,
    createMcpServer: mcp,
  });
  app.listen(config.port, () => {
    console.log(`Ultrahuman MCP running on ${config.publicUrl} (${config.mode} mode)`);
    console.log(`MCP address: ${config.publicUrl}/mcp`);
    if (oauth) console.log(`Connect your ring once: ${config.publicUrl}/login?key=<MCP_API_KEY>`);
    if (oauth && config.onRailway && !config.hasPublicAddress) {
      console.log("No public address yet. In Railway go to Settings -> Networking -> Generate Domain, then redeploy.");
    }
  });
}
