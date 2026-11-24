// Ready-made prompts that show up as one-click actions in apps that support MCP prompts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DAY_PATTERN } from "./dates.ts";

const ask = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "weekly_health_review",
    {
      title: "Weekly health review",
      description: "Review the last 7 days of sleep, recovery and activity against the week before.",
    },
    () =>
      ask(
        "Give me a weekly health review from my Ultrahuman Ring data. " +
          "Use compare_periods with preset 'this_week_vs_last_week', then get_trends for the last 7 days. " +
          "Cover sleep (score, duration, consistency), recovery (HRV, resting heart rate, recovery score) and activity (steps). " +
          "Lead with the 2-3 changes that matter most, explain them in plain language, and end with one concrete suggestion for next week. " +
          "Say so when a day has no data instead of guessing.",
      ),
  );

  server.registerPrompt(
    "sleep_analysis",
    {
      title: "Sleep analysis",
      description: "Look closely at one night of sleep and how it compares with your usual.",
      argsSchema: {
        date: z.string().regex(DAY_PATTERN).optional().describe("Day in YYYY-MM-DD (the morning you woke up). Defaults to today."),
      },
    },
    ({ date }) =>
      ask(
        `Analyse my sleep for ${date ?? "last night (today's date)"} using get_sleep, ` +
          "then get_baselines to see how it compares with my last 30 days. " +
          "Cover the score, total sleep, time in each stage, efficiency, bedtime and wake time, and overnight HRV and heart rate. " +
          "Point out anything unusual for me specifically, and suggest what might have caused it.",
      ),
  );

  server.registerPrompt(
    "recovery_check",
    {
      title: "Recovery check",
      description: "Should I push hard or take it easy today?",
    },
    () =>
      ask(
        "Check my recovery for today with get_recovery and get_baselines. " +
          "Compare today's HRV, resting heart rate, temperature and recovery score with my personal baseline. " +
          "Tell me in one line whether today looks like a day to push, train normally, or take it easy, then explain why in 2-3 bullets.",
      ),
  );

  server.registerPrompt(
    "metric_deep_dive",
    {
      title: "Metric deep dive",
      description: "Track one metric over time and look for what moves it.",
      argsSchema: {
        metric: z.string().describe("Metric name, e.g. sleep_score, avg_sleep_hrv, resting_hr, steps, recovery_score"),
        days: z.string().regex(/^\d+$/).optional().describe("How many days to look back (default 30)"),
      },
    },
    ({ metric, days }) =>
      ask(
        `Look at my ${metric} over the last ${days ?? "30"} days using get_trends. ` +
          "Describe the trend, the best and worst days, and how steady it is. " +
          "Then check whether it lines up with my other metrics on the same days (for example sleep vs next-day HRV, or steps vs sleep), " +
          "and only claim a link if the data clearly shows it.",
      ),
  );
}
