import test from "node:test";
import assert from "node:assert/strict";
import {
  costLabel,
  coverageState,
  providerLimitLabel,
  providerSnapshotState,
  remainingBudgetPercent,
  suggestionFactLabel,
} from "./usageViewModel.mjs";

test("reported and estimated costs are never merged into one unlabeled number", () => {
  assert.deepEqual(
    costLabel({ reported: 1_200_000, estimated: 300_000, unknown: 2 }, "en-US"),
    {
      reported: "$1.20 reported",
      estimated: "$0.30 estimated",
      unknown: "2 attempts unknown",
    },
  );
});

test("manual budget cannot be labeled provider quota", () => {
  assert.equal(
    providerLimitLabel({ source: "manual_budget", remainingPercent: 40 }),
    "40% of manual budget remaining",
  );
});

test("partial coverage remains visible", () => {
  assert.deepEqual(coverageState(82, 64), {
    tone: "warning",
    label: "82% usage · 64% cost",
  });
});

test("provider snapshot states distinguish unsupported unauthorized and stale", () => {
  assert.equal(providerSnapshotState({ status: "unsupported" }, 1_000).label, "Unsupported");
  assert.equal(providerSnapshotState({ status: "unauthorized" }, 1_000).label, "Unauthorized");
  assert.equal(
    providerSnapshotState({ status: "available", observed_at: 1 }, 200_000).label,
    "Stale provider data",
  );
});

test("unknown cost disables remaining budget arithmetic", () => {
  assert.equal(remainingBudgetPercent(10_000_000, 3_000_000, 0), null);
});

test("suggestion cost evidence names reported or estimated provenance", () => {
  assert.match(
    suggestionFactLabel({ kind: "cost", delta_percent: -40, provenance: "provider_reported" }),
    /provider-reported/,
  );
  assert.match(
    suggestionFactLabel({ kind: "cost", delta_percent: -25, provenance: "catalog_estimated" }),
    /catalog estimate/,
  );
});

test("suggestion evidence discloses when provenance is unavailable", () => {
  assert.match(
    suggestionFactLabel({ kind: "cost", delta_percent: -20, provenance: "unavailable" }),
    /evidence unavailable/,
  );
});
