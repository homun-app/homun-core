import test from "node:test";
import assert from "node:assert/strict";
import { projectAutomationRunState } from "./automationRunProjection.mjs";

test("automation scheduled run uses kernel turn status when projection matches thread", () => {
  const display = projectAutomationRunState(
    { status: "queued", thread_id: "thread-auto" },
    { thread_id: "thread-auto", turn: { status: "waiting_approval" } },
  );

  assert.deepEqual(display, {
    state: "running",
    labelKey: "automations.inProgress",
  });
});

test("automation scheduled run ignores projection for a different thread", () => {
  const display = projectAutomationRunState(
    { status: "queued", thread_id: "thread-auto" },
    { thread_id: "thread-other", turn: { status: "running" } },
  );

  assert.deepEqual(display, {
    state: "queued",
    labelKey: "automations.inQueue",
  });
});

test("automation scheduled run falls back to task queue status without projection", () => {
  assert.deepEqual(projectAutomationRunState({ status: "running", thread_id: null }, null), {
    state: "running",
    labelKey: "automations.inProgress",
  });
  assert.deepEqual(projectAutomationRunState({ status: "waiting_time", thread_id: null }, null), {
    state: "queued",
    labelKey: "automations.inQueue",
  });
});
