// Trend, comparison and baseline maths over per-day metric values. Missing days stay missing.

export interface Stats {
  days_with_data: number;
  avg: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export type Direction = "rising" | "falling" | "flat" | "not enough data";

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function stats(values: (number | null)[]): Stats {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return { days_with_data: 0, avg: null, median: null, min: null, max: null };
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return {
    days_with_data: nums.length,
    avg: round(nums.reduce((a, b) => a + b, 0) / nums.length),
    median: round(median),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

/**
 * Direction of a daily series from a least-squares slope. "flat" when the change across
 * the whole window is under 3% of the average, so day-to-day noise is not called a trend.
 */
export function direction(values: (number | null)[]): { direction: Direction; change_per_day: number | null } {
  const points = values.flatMap((v, i) => (v === null ? [] : [[i, v] as const]));
  if (points.length < 3) return { direction: "not enough data", change_per_day: null };
  const n = points.length;
  const mx = points.reduce((a, [x]) => a + x, 0) / n;
  const my = points.reduce((a, [, y]) => a + y, 0) / n;
  const sxx = points.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  const slope = points.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / sxx;
  const span = points[n - 1]![0] - points[0]![0];
  const relative = my === 0 ? 0 : Math.abs((slope * span) / my);
  return {
    direction: relative < 0.03 ? "flat" : slope > 0 ? "rising" : "falling",
    change_per_day: round(slope, 2),
  };
}

export interface Comparison {
  a: Stats;
  b: Stats;
  change: number | null;
  change_pct: number | null;
}

/** Period B compared with period A (change = B avg − A avg). */
export function compare(a: (number | null)[], b: (number | null)[]): Comparison {
  const sa = stats(a);
  const sb = stats(b);
  const change = sa.avg !== null && sb.avg !== null ? round(sb.avg - sa.avg) : null;
  const change_pct = change !== null && sa.avg ? round((change / sa.avg) * 100) : null;
  return { a: sa, b: sb, change, change_pct };
}

/** Where `value` sits relative to a personal baseline, as a percentile of the baseline days. */
export function percentile(value: number, baseline: number[]): number | null {
  if (baseline.length === 0) return null;
  const below = baseline.filter((v) => v < value).length;
  const equal = baseline.filter((v) => v === value).length;
  return Math.round(((below + equal / 2) / baseline.length) * 100);
}
