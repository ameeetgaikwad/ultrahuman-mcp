// Calendar-day helpers. Days are plain "YYYY-MM-DD" strings in the server's timezone (TZ).

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in the server's timezone (set TZ, e.g. TZ=Asia/Kolkata). */
export function today(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA");
}

/** True when the string is a real calendar day ("2026-02-30" is not). */
export function isRealDay(day: string): boolean {
  if (!DAY_PATTERN.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every day from start to end inclusive. Empty when start is after end. */
export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The `count` days ending on `end` (inclusive), oldest first. */
export function lastNDays(end: string, count: number): string[] {
  return daysBetween(addDays(end, -(count - 1)), end);
}
