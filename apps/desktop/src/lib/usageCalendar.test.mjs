import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCalendarDays,
  routeLabel,
  totalTokens,
  usageIntensityLevels,
} from "./usageCalendar.mjs";

const DAY = 86_400;
const jul17 = Date.UTC(2026, 6, 17) / 1_000;
const jul21 = Date.UTC(2026, 6, 21) / 1_000;

const seriesFixture = {
  coverage_started_at: jul17,
  generated_at: jul21 + 43_200,
  timezone_offset_minutes: 0,
  days: [{
    day_epoch: jul21,
    logical_calls: 2,
    attempts: 2,
    successful_attempts: 2,
    failed_attempts: 0,
    aborted_attempts: 0,
    known_usage_attempts: 2,
    unknown_usage_attempts: 0,
    input_tokens: 120,
    output_tokens: 30,
    reasoning_tokens: 10,
    cache_read_tokens: 20,
    cache_write_tokens: 0,
    cost_breakdown: {
      provider_reported_microusd: 2_000,
      catalog_estimated_microusd: 0,
      manual_estimated_microusd: 0,
      not_billed_attempts: 0,
      unknown_cost_attempts: 0,
      cost_coverage_percent: 100,
    },
    dominant_provider: "ollama-cloud",
    dominant_model: "qwen",
  }],
};

test("covered missing days are zero while pre-coverage days are unavailable", () => {
  const days = buildCalendarDays(seriesFixture, "7d", jul21 * 1_000);
  assert.equal(days.length, 7);
  assert.equal(days[0].state, "unavailable");
  assert.equal(days[4].state, "zero");
  assert.equal(days[6].state, "active");
});

test("a single outlier does not flatten every active day", () => {
  assert.deepEqual(usageIntensityLevels([10, 20, 30, 10_000]), [1, 2, 3, 4]);
});

test("route label contains the real provider and model", () => {
  assert.equal(
    routeLabel({ dominant_provider: "ollama-cloud", dominant_model: "qwen" }),
    "ollama-cloud → qwen",
  );
});

test("total tokens includes cache traffic", () => {
  assert.equal(totalTokens(seriesFixture.days[0]), 180);
});

test("all window starts at the first covered local day", () => {
  const series = {
    ...seriesFixture,
    coverage_started_at: jul17 + 23 * 3_600,
  };
  const days = buildCalendarDays(series, "all", (jul21 + DAY) * 1_000);
  assert.equal(days[0].day_epoch, jul17);
});
