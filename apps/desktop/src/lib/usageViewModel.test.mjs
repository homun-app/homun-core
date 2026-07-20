import test from "node:test";
import assert from "node:assert/strict";
import {
  costLabel,
  coverageState,
  providerLimitLabel,
  providerSnapshotState,
  remainingBudgetPercent,
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
