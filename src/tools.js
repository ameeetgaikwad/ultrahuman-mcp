// The MCP tools your AI assistant can call.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDailyMetrics, getUserInfo, mode } from "./ultrahuman.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 14;

// Today's date in the server's timezone (set TZ, e.g. TZ=Asia/Kolkata).
const today = () => new Date().toLocaleDateString("en-CA");

// Heart rate, temperature etc. come as long lists of readings (hundreds per day).
// That is too much text for a chat, so long lists of numbers are replaced with
// a short summary: how many readings, min, max, average, first and last.
export function shrink(value) {
  if (Array.isArray(value)) {
    const nums = value
      .map((v) => (typeof v === "number" ? v : typeof v?.value === "number" ? v.value : null))
      .filter((n) => n !== null);
    if (value.length > 24 && nums.length === value.length) {
      const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
      return {
        readings: nums.length,
        min: Math.min(...nums),
        max: Math.max(...nums),
        avg: Math.round(avg * 10) / 10,
        first: value[0],
        last: value[value.length - 1],
      };
    }
    return value.map(shrink);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v)]));
  }
  return value;
}

const reply = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }] });
const fail = (err) => ({ content: [{ type: "text", text: String(err?.message || err) }], isError: true });

function datesBetween(start, end) {
  const out = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last && out.length <= MAX_RANGE_DAYS) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function createServer() {
  const server = new McpServer({ name: "ultrahuman", version: "1.0.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    "get_daily_metrics",
    {
      title: "Get daily ring data",
      description:
        `Get Ultrahuman Ring data for one day: sleep (score, stages, efficiency), heart rate, HRV, ` +
        `resting heart rate, skin temperature, steps, movement, recovery, VO2 max, SpO2, and glucose ` +
        `if a CGM is used. Today is ${today()}. Last night's sleep is usually under today's date.`,
      inputSchema: {
        date: z.string().regex(DAY).optional().describe("Day in YYYY-MM-DD format. Defaults to today."),
        full_detail: z
          .boolean()
          .optional()
          .describe("Return every single reading instead of a summary. Much longer. Default false."),
      },
      annotations: readOnly,
    },
    async ({ date, full_detail }) => {
      try {
        const data = await getDailyMetrics(date || today());
        return reply(full_detail ? data : shrink(data));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_metrics_for_range",
    {
      title: "Get ring data for several days",
      description:
        `Get summarized Ultrahuman Ring data for each day in a date range (up to ${MAX_RANGE_DAYS} days). ` +
        `Useful for trends like "how did I sleep this week?". Today is ${today()}.`,
      inputSchema: {
        start_date: z.string().regex(DAY).describe("First day, YYYY-MM-DD"),
        end_date: z.string().regex(DAY).describe("Last day, YYYY-MM-DD"),
      },
      annotations: readOnly,
    },
    async ({ start_date, end_date }) => {
      const days = datesBetween(start_date, end_date);
      if (days.length === 0) return fail("start_date must be on or before end_date.");
      if (days.length > MAX_RANGE_DAYS) return fail(`Please ask for at most ${MAX_RANGE_DAYS} days at a time.`);

      const result = {};
      for (const day of days) {
        try {
          result[day] = shrink(await getDailyMetrics(day));
        } catch (err) {
          result[day] = { error: String(err?.message || err) };
        }
      }
      return reply(result);
    },
  );

  // The profile endpoint only exists for OAuth apps.
  if (mode === "oauth") {
    server.registerTool(
      "get_user_info",
      {
        title: "Get profile",
        description: "Get the Ultrahuman user's basic profile (name, email, timezone, etc.).",
        annotations: readOnly,
      },
      async () => {
        try {
          return reply(await getUserInfo());
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  return server;
}
