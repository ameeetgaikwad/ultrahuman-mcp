// The MCP tools your AI assistant can call. Everything here is read-only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { compare, direction, percentile, stats } from "./analysis.ts";
import type { UltrahumanApi } from "./api.ts";
import { addDays, daysBetween, DAY_PATTERN, isRealDay, lastNDays, today } from "./dates.ts";
import {
  GROUPS,
  HOURLY_METRICS,
  METRIC_NAMES,
  hourly,
  metricValue,
  parseDay,
  shrink,
  type Group,
  type MetricName,
  type ParsedDay,
} from "./metrics.ts";
import { registerPrompts } from "./prompts.ts";

const MAX_RANGE_DAYS = 14;
const MAX_TREND_DAYS = 90;
const DEFAULT_TREND_METRICS: MetricName[] = [
  "sleep_score",
  "total_sleep_minutes",
  "avg_sleep_hrv",
  "resting_hr",
  "recovery_score",
  "steps",
];

const readOnly = { readOnlyHint: true, openWorldHint: true };
const reply = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }] });
const fail = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

const dayArg = z.string().regex(DAY_PATTERN).describe("Day in YYYY-MM-DD format");
const optionalDay = dayArg.optional().describe("Day in YYYY-MM-DD format. Defaults to today.");
const metricList = z
  .array(z.enum(METRIC_NAMES))
  .min(1)
  .optional()
  .describe(`Metrics to include. Defaults to ${DEFAULT_TREND_METRICS.join(", ")}.`);

class BadInput extends Error {}

function checkDay(day: string): string {
  if (!isRealDay(day)) throw new BadInput(`"${day}" is not a real date. Use YYYY-MM-DD, e.g. 2026-03-01.`);
  return day;
}

function checkRange(start: string, end: string, max: number): string[] {
  checkDay(start);
  checkDay(end);
  if (start > end) throw new BadInput("start_date must be on or before end_date.");
  const days = daysBetween(start, end);
  if (days.length > max) throw new BadInput(`Please ask for at most ${max} days at a time.`);
  return days;
}

/** Wraps a tool body so bad input and API failures come back as readable tool errors. */
function safe<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return reply(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function createMcpServer(api: UltrahumanApi): McpServer {
  const server = new McpServer({ name: "ultrahuman", version: "2.0.0" });

  const day = async (date: string): Promise<ParsedDay> => parseDay(await api.dailyMetrics(checkDay(date)));

  /** Parsed days for a range; days that failed to load are reported, not dropped. */
  const days = async (dates: string[]) => {
    const raw = await api.dailyMetricsMany(dates);
    const parsed = new Map<string, ParsedDay | null>();
    const errors: Record<string, string> = {};
    for (const [d, r] of raw) {
      if (r.ok) parsed.set(d, parseDay(r.data));
      else {
        parsed.set(d, null);
        errors[d] = r.error;
      }
    }
    return { parsed, errors };
  };

  const series = (parsed: Map<string, ParsedDay | null>, dates: string[], metric: MetricName) =>
    dates.map((d) => {
      const p = parsed.get(d);
      return p ? metricValue(p, metric) : null;
    });

  server.registerTool(
    "get_daily_metrics",
    {
      title: "Get raw daily ring data",
      description:
        `Everything Ultrahuman has for one day, as returned by the API: sleep, heart rate, HRV, temperature, ` +
        `steps, movement, recovery, VO2 max, SpO2 and glucose if a CGM is worn. Long lists of readings are ` +
        `summarised unless full_detail is true. Prefer get_sleep / get_recovery / get_activity / get_glucose ` +
        `for a compact answer. Today is ${today()}. Last night's sleep is usually under today's date.`,
      inputSchema: {
        date: optionalDay,
        full_detail: z.boolean().optional().describe("Return every single reading instead of a summary. Much longer."),
      },
      annotations: readOnly,
    },
    safe(async ({ date, full_detail }: { date?: string; full_detail?: boolean }) => {
      const d = checkDay(date ?? today());
      const data = await api.dailyMetrics(d);
      return { date: d, ...asObject(full_detail ? data : shrink(data)) };
    }),
  );

  for (const group of GROUPS) {
    server.registerTool(
      `get_${group.name}`,
      {
        title: group.title,
        description: `${group.description} Today is ${today()}.`,
        inputSchema: { date: optionalDay },
        annotations: readOnly,
      },
      safe(async ({ date }: { date?: string }) => {
        const d = date ?? today();
        const p = await day(d);
        return { date: d, ...p[group.name as Group] };
      }),
    );
  }

  server.registerTool(
    "get_metrics_for_range",
    {
      title: "Get a compact summary for several days",
      description:
        `Parsed sleep, recovery, activity, glucose and vitals for each day in a range (up to ${MAX_RANGE_DAYS} days). ` +
        `For trends over longer periods use get_trends. Today is ${today()}.`,
      inputSchema: { start_date: dayArg.describe("First day, YYYY-MM-DD"), end_date: dayArg.describe("Last day, YYYY-MM-DD") },
      annotations: readOnly,
    },
    safe(async ({ start_date, end_date }: { start_date: string; end_date: string }) => {
      const dates = checkRange(start_date, end_date, MAX_RANGE_DAYS);
      const { parsed, errors } = await days(dates);
      const out: Record<string, unknown> = {};
      for (const d of dates) {
        const p = parsed.get(d);
        out[d] = p ? { sleep: p.sleep, recovery: p.recovery, activity: p.activity, glucose: p.glucose } : { error: errors[d] };
      }
      return out;
    }),
  );

  server.registerTool(
    "get_hourly",
    {
      title: "Get hour-by-hour readings",
      description:
        `One metric for one day, bucketed by hour (average, min, max and number of readings per hour; ` +
        `steps are totalled). Good for "when did my heart rate spike yesterday?". Today is ${today()}.`,
      inputSchema: {
        metric: z.enum(HOURLY_METRICS).describe("Which reading to bucket"),
        date: optionalDay,
      },
      annotations: readOnly,
    },
    safe(async ({ metric, date }: { metric: (typeof HOURLY_METRICS)[number]; date?: string }) => {
      const d = date ?? today();
      return { date: d, metric, ...hourly(await day(d), metric) };
    }),
  );

  server.registerTool(
    "get_trends",
    {
      title: "Get trends over time",
      description:
        `Daily values of chosen metrics over the last N days (up to ${MAX_TREND_DAYS}), with average, median, ` +
        `min, max and whether each metric is rising, falling or flat. Missing days are null, never 0. ` +
        `Available metrics: ${METRIC_NAMES.join(", ")}. Today is ${today()}.`,
      inputSchema: {
        metrics: metricList,
        days: z.number().int().min(2).max(MAX_TREND_DAYS).optional().describe("How many days to look back (default 14)"),
        end_date: dayArg.optional().describe("Last day of the window, YYYY-MM-DD. Defaults to today."),
      },
      annotations: readOnly,
    },
    safe(async ({ metrics, days: n, end_date }: { metrics?: MetricName[]; days?: number; end_date?: string }) => {
      const dates = lastNDays(checkDay(end_date ?? today()), n ?? 14);
      const { parsed, errors } = await days(dates);
      const out: Record<string, unknown> = {};
      for (const m of metrics ?? DEFAULT_TREND_METRICS) {
        const values = series(parsed, dates, m);
        out[m] = { ...stats(values), ...direction(values), daily: Object.fromEntries(dates.map((d, i) => [d, values[i]])) };
      }
      return { start_date: dates[0], end_date: dates.at(-1), metrics: out, ...(Object.keys(errors).length ? { errors } : {}) };
    }),
  );

  server.registerTool(
    "compare_periods",
    {
      title: "Compare two periods",
      description:
        `Compare metric averages between two date ranges, e.g. this week vs last week. Use a preset or give ` +
        `both ranges (each up to ${MAX_TREND_DAYS} days). Change is period B minus period A. Today is ${today()}.`,
      inputSchema: {
        preset: z
          .enum(["this_week_vs_last_week", "last_30_days_vs_previous_30"])
          .optional()
          .describe("Shortcut: A = the earlier period, B = the most recent one (ending today)"),
        period_a_start: dayArg.optional(),
        period_a_end: dayArg.optional(),
        period_b_start: dayArg.optional(),
        period_b_end: dayArg.optional(),
        metrics: metricList,
      },
      annotations: readOnly,
    },
    safe(
      async (args: {
        preset?: "this_week_vs_last_week" | "last_30_days_vs_previous_30";
        period_a_start?: string;
        period_a_end?: string;
        period_b_start?: string;
        period_b_end?: string;
        metrics?: MetricName[];
      }) => {
        let a: string[];
        let b: string[];
        if (args.preset) {
          const len = args.preset === "this_week_vs_last_week" ? 7 : 30;
          b = lastNDays(today(), len);
          a = lastNDays(addDays(b[0]!, -1), len);
        } else if (args.period_a_start && args.period_a_end && args.period_b_start && args.period_b_end) {
          a = checkRange(args.period_a_start, args.period_a_end, MAX_TREND_DAYS);
          b = checkRange(args.period_b_start, args.period_b_end, MAX_TREND_DAYS);
        } else {
          throw new BadInput("Give a preset, or all four of period_a_start, period_a_end, period_b_start, period_b_end.");
        }
        const { parsed, errors } = await days([...a, ...b]);
        const out: Record<string, unknown> = {};
        for (const m of args.metrics ?? DEFAULT_TREND_METRICS) out[m] = compare(series(parsed, a, m), series(parsed, b, m));
        return {
          period_a: `${a[0]} to ${a.at(-1)}`,
          period_b: `${b[0]} to ${b.at(-1)}`,
          metrics: out,
          ...(Object.keys(errors).length ? { errors } : {}),
        };
      },
    ),
  );

  server.registerTool(
    "get_baselines",
    {
      title: "Compare a day with your personal baseline",
      description:
        `For one day, each metric's value next to your own baseline over the preceding N days (default 30): ` +
        `average, typical range (min to max) and the day's percentile within it. Good for "is my HRV low for me?". ` +
        `Today is ${today()}.`,
      inputSchema: {
        date: optionalDay,
        baseline_days: z.number().int().min(7).max(MAX_TREND_DAYS).optional().describe("Days before `date` to use (default 30)"),
        metrics: metricList,
      },
      annotations: readOnly,
    },
    safe(async ({ date, baseline_days, metrics }: { date?: string; baseline_days?: number; metrics?: MetricName[] }) => {
      const d = checkDay(date ?? today());
      const base = lastNDays(addDays(d, -1), baseline_days ?? 30);
      const { parsed, errors } = await days([...base, d]);
      const target = parsed.get(d);
      const out: Record<string, unknown> = {};
      for (const m of metrics ?? DEFAULT_TREND_METRICS) {
        const value = target ? metricValue(target, m) : null;
        const baseline = series(parsed, base, m).filter((v): v is number => v !== null);
        out[m] = { value, baseline: stats(baseline), percentile: value === null ? null : percentile(value, baseline) };
      }
      return {
        date: d,
        baseline: `${base[0]} to ${base.at(-1)}`,
        metrics: out,
        ...(Object.keys(errors).length ? { errors } : {}),
      };
    }),
  );

  // The profile endpoint only exists for OAuth apps.
  if (api.mode === "oauth") {
    server.registerTool(
      "get_user_info",
      {
        title: "Get profile",
        description: "Get the Ultrahuman user's basic profile (name, email, timezone, etc.).",
        annotations: readOnly,
      },
      safe(async () => api.userInfo()),
    );
  }

  registerPrompts(server);
  return server;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { data: v };
}
