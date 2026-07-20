import test from "node:test";
import assert from "node:assert/strict";
import { compactUsageRows } from "./usageViewModel.mjs";

test("compact summary keeps cost provenance visible", () => {
  const rows = compactUsageRows({
    logical_calls: 3,
    input_tokens: 1_000,
    output_tokens: 400,
    reasoning_tokens: 50,
    active_providers: 2,
    dominant_model: "model-a",
    trend_percent: -12,
    usage_coverage_percent: 100,
    cost: {
      provider_reported_microusd: 1_200_000,
      catalog_estimated_microusd: 300_000,
      manual_estimated_microusd: 0,
      unknown_cost_attempts: 1,
      cost_coverage_percent: 75,
    },
  }, "en-US");
  assert.equal(rows.cost.primary, "$1.20 reported");
  assert.equal(rows.cost.secondary, "$0.30 estimated · 1 unknown");
  assert.equal(rows.coverageWarning, true);
});

test("empty history returns a first-use state instead of zero-heavy KPIs", () => {
  assert.deepEqual(compactUsageRows({ logical_calls: 0 }, "en-US"), { kind: "empty" });
});
