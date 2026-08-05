import assert from "node:assert/strict";
import test from "node:test";

import {
  projectEffectResolutionError,
  projectTaskQueueSnapshot,
} from "./taskQueueProjection.mjs";

const fallbackTasks = [{ id: "fallback", title: "Fallback" }];

const task = (id) => ({ id, title: `Task ${id}` });
const approval = (id) => ({ id, title: `Approval ${id}` });
const uncertainEffect = (id) => ({ receipt_id: id, summary: `Effect ${id}` });

const mapTask = (item) => ({ id: item.id, title: item.title, mapped: "task" });
const mapApproval = (item) => ({ id: item.id, title: item.title, mapped: "approval" });
const mapUncertainEffect = (item) => ({
  id: item.receipt_id,
  summary: item.summary,
  mapped: "effect",
});

test("projectTaskQueueSnapshot combines task lanes and maps approvals and effects", () => {
  assert.deepEqual(
    projectTaskQueueSnapshot({
      snapshot: {
        active: [task("active")],
        queued: [task("queued")],
        blocked: [task("blocked")],
        recent_failures: [task("failed")],
        waiting_approvals: [approval("approval")],
        uncertain_effects: [uncertainEffect("effect")],
      },
      fallbackTasks,
      mapTask,
      mapApproval,
      mapUncertainEffect,
    }),
    {
      taskItems: [
        { id: "active", title: "Task active", mapped: "task" },
        { id: "queued", title: "Task queued", mapped: "task" },
        { id: "blocked", title: "Task blocked", mapped: "task" },
        { id: "failed", title: "Task failed", mapped: "task" },
      ],
      approvelItems: [{ id: "approval", title: "Approval approval", mapped: "approval" }],
      uncertainEffectItems: [
        { id: "effect", summary: "Effect effect", mapped: "effect" },
      ],
    },
  );
});

test("projectTaskQueueSnapshot falls back to mock tasks for empty task lanes", () => {
  assert.deepEqual(
    projectTaskQueueSnapshot({
      snapshot: {
        active: [],
        queued: [],
        blocked: [],
        recent_failures: [],
        waiting_approvals: [],
        uncertain_effects: [],
      },
      fallbackTasks,
      mapTask,
      mapApproval,
      mapUncertainEffect,
    }),
    {
      taskItems: fallbackTasks,
      approvelItems: [],
      uncertainEffectItems: [],
    },
  );
});

test("projectEffectResolutionError preserves only errors for still-visible effects", () => {
  const current = { receiptId: "effect", message: "still present" };

  assert.equal(
    projectEffectResolutionError(current, [{ id: "effect" }, { id: "other" }]),
    current,
  );
  assert.equal(projectEffectResolutionError(current, [{ id: "other" }]), null);
  assert.equal(projectEffectResolutionError(null, [{ id: "effect" }]), null);
});
