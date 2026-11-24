import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, direction, percentile, stats } from "../src/analysis.ts";

test("stats ignore missing days instead of counting them as zero", () => {
  assert.deepEqual(stats([80, null, 70, 90]), { days_with_data: 3, avg: 80, median: 80, min: 70, max: 90 });
  assert.deepEqual(stats([null, null]), { days_with_data: 0, avg: null, median: null, min: null, max: null });
  assert.equal(stats([1, 2, 3, 4]).median, 2.5);
});

test("direction calls a steady climb rising and noise flat", () => {
  assert.equal(direction([50, 55, null, 65, 70]).direction, "rising");
  assert.equal(direction([70, 65, 60, 55]).direction, "falling");
  assert.equal(direction([60, 60.5, 59.8, 60.2, 60.1]).direction, "flat");
  assert.equal(direction([60, null, null, 70]).direction, "not enough data");
});

test("compare reports B relative to A", () => {
  const c = compare([60, 70], [77, 77]);
  assert.equal(c.change, 12);
  assert.equal(c.change_pct, 18.5);
  assert.equal(compare([null], [70]).change, null);
});

test("percentile places a value within the baseline", () => {
  assert.equal(percentile(50, [10, 20, 30, 40]), 100);
  assert.equal(percentile(5, [10, 20, 30, 40]), 0);
  assert.equal(percentile(25, [10, 20, 30, 40]), 50);
  assert.equal(percentile(1, []), null);
});
