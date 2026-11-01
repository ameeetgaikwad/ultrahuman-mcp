# Ultrahuman MCP

Chat with your Ultrahuman Ring data in Claude, ChatGPT, Cursor, or any other AI app that supports MCP ("Model Context Protocol", the standard way to plug tools into AI apps).

Once it's connected, you can ask things like:

- "How did I sleep last night?"
- "Compare my HRV and resting heart rate over the last 7 days."
- "Was my recovery better on the days I walked more?"
- "What was my average glucose yesterday?" (if you wear a CGM)

The AI only **reads** your data. Nothing gets changed.

## What it can see

| Tool | What it does |
| --- | --- |
| `get_daily_metrics` | Everything for one day: sleep score and stages, heart rate, HRV, resting heart rate, temperature, steps, movement, recovery, VO2 max, SpO2, and glucose |
| `get_metrics_for_range` | The same data for up to 14 days, for spotting trends |
| `get_user_info` | Your basic profile (only when you connect with an OAuth app, option B below) |

Heart rate and similar data come as hundreds of readings a day. By default the server turns those into a short summary (min, max, average) so your chat doesn't get flooded. Ask for "full detail" if you want every reading.

---

## 1. Get your Ultrahuman key

You only need **one** of these.

### Option A: Personal API token (easiest, recommended)

1. Go to <https://vision.ultrahuman.com/developer-docs> and log in with your Ultrahuman account.
2. Create a **Personal API token** and copy it.

### Option B: OAuth app (the [Partner API](https://www.ultrahuman.com/blog/accessing-the-ultrahuman-partnership-api/))

Use this if you already have an Ultrahuman partner app, or want the profile tool.

1. In the same developer portal, create an OAuth app. Copy its **Client ID** and **Client Secret**.
2. Set its **Redirect URI** to `https://YOUR-APP.up.railway.app/callback`. You'll get this address in step 2, and it has to match exactly.

## 2. Put it on Railway

1. Push this repo to your GitHub (or fork it).
2. On [Railway](https://railway.com): **New Project → Deploy from GitHub repo →** pick this repo.
3. Open the service, go to **Variables**, and add:

   | Variable | Value |
   | --- | --- |
   | `ULTRAHUMAN_API_TOKEN` | Your personal token (option A) |
   | `MCP_API_KEY` | A long random password you make up. This keeps strangers out of your data. Create one with `openssl rand -hex 32` |
   | `TZ` | Your timezone, e.g. `Asia/Kolkata` or `America/New_York`, so "today" means *your* today |

   For **option B**, skip `ULTRAHUMAN_API_TOKEN` and add these instead:

   | Variable | Value |
   | --- | --- |
   | `ULTRAHUMAN_CLIENT_ID` | From your OAuth app |
   | `ULTRAHUMAN_CLIENT_SECRET` | From your OAuth app |
   | `TOKEN_FILE` | `/data/tokens.json` |

   Then add a **Volume** to the service (right-click the service → **Attach Volume**) mounted at `/data`. This keeps you logged in when Railway restarts the app.

4. Go to **Settings → Networking → Generate Domain**. You'll get something like `https://ultrahuman-mcp-production.up.railway.app`.
5. Open that address in your browser. You should see `"connected": true` (option A).

**Option B only:** open `https://YOUR-APP.up.railway.app/login?key=YOUR_MCP_API_KEY` once, sign in to Ultrahuman, and approve. After that, `"connected"` will show `true`. The server keeps itself logged in from then on.

Your MCP address is:

```
https://YOUR-APP.up.railway.app/mcp
```

## 3. Connect your AI app

In each example below, replace `YOUR-APP` and `YOUR_MCP_API_KEY` with your own values.

### Claude (claude.ai web, desktop, mobile)

**Settings → Connectors → Add custom connector**

- Name: `Ultrahuman`
- URL: `https://YOUR-APP.up.railway.app/mcp?key=YOUR_MCP_API_KEY`

The connector screen only takes a URL, so the key goes at the end of it. Keep this URL private.

### Claude Code

```bash
claude mcp add --transport http ultrahuman https://YOUR-APP.up.railway.app/mcp \
  --header "Authorization: Bearer YOUR_MCP_API_KEY"
```

### Cursor, Windsurf, VS Code, and other apps

Most apps take a config like this:

```json
{
  "mcpServers": {
    "ultrahuman": {
      "url": "https://YOUR-APP.up.railway.app/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_API_KEY" }
    }
  }
}
```

If an app doesn't let you add headers, use the `?key=YOUR_MCP_API_KEY` URL from the Claude section.

### ChatGPT

Turn on developer mode in ChatGPT's settings, then add a custom connector using the `?key=` URL from the Claude section.

---

## Running it on your own computer (no hosting)

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/ameeetgaikwad/ultrahuman-mcp.git
cd ultrahuman-mcp
npm install
```

Then add it to Claude Desktop's config file (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "ultrahuman": {
      "command": "node",
      "args": ["/full/path/to/ultrahuman-mcp/src/index.js", "--stdio"],
      "env": { "ULTRAHUMAN_API_TOKEN": "your-token-here" }
    }
  }
}
```

Restart Claude Desktop and you're done. You don't need `MCP_API_KEY` here because nothing goes on the internet.

To run the web version locally instead: copy `.env.example` to `.env`, fill it in, and run `node --env-file=.env src/index.js`.

## Troubleshooting

- **"Wrong or missing MCP_API_KEY"**: the key in your AI app doesn't match the `MCP_API_KEY` on Railway.
- **"Incorrect Personal API Token"**: the Ultrahuman token is wrong or was deleted. Make a new one.
- **"Not connected to Ultrahuman yet"** (option B): open `/login?key=...` again. If this keeps happening after restarts, check that the volume is mounted at `/data`.
- **Redirect URI error on the Ultrahuman login page** (option B): the Redirect URI in your OAuth app must be exactly `https://YOUR-APP.up.railway.app/callback`.
- **Empty data for a day**: the ring may not have synced yet. Open the Ultrahuman app to sync.

## Good to know

- Ultrahuman also runs its own official MCP server at `https://api.ultrahuman.com/mcp`. This project is a small one you host and control yourself, built on their public API.
- Anyone who has your `MCP_API_KEY` (or the `?key=` URL) can read your health data. Treat it like a password. If it leaks, change it on Railway.
- Health data from this tool is for your own insight, not medical advice.

## Files

```
src/index.js       starts the server (web or local mode)
src/tools.js       the tools the AI can use
src/ultrahuman.js  talks to the Ultrahuman API
```

Run `npm test` to check that it works.

MIT license.
