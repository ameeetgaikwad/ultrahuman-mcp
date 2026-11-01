import { test } from "node:test";
import assert from "node:assert/strict";
import { shrink } from "../src/tools.js";

test("long lists of readings become a short summary", () => {
  const values = Array.from({ length: 100 }, (_, i) => ({ value: 60 + (i % 10), timestamp: i }));
  const out = shrink({ hr: { unit: "BPM", values }, sleep: { score: 82 } });
  assert.equal(out.hr.unit, "BPM");
  assert.equal(out.hr.values.readings, 100);
  assert.equal(out.hr.values.min, 60);
  assert.equal(out.hr.values.max, 69);
  assert.deepEqual(out.sleep, { score: 82 });
});
