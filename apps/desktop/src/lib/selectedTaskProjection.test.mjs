import assert from "node:assert/strict";
import test from "node:test";

import { projectSelectedTask } from "./selectedTaskProjection.mjs";

const fallbackTask = {
  id: "fallback",
  title: "Fallback",
  kind: "old",
  status: "completed",
  priority: "normal",
  resource: "local",
  risk: "low",
  updated: "now",
};

const activeThread = {
  taskId: "task-active",
  title: "Active thread",
};

test("projectSelectedTask returns the selected task when it exists", () => {
  const selected = {
    ...fallbackTask,
    id: "selected",
    title: "Selected task",
  };

  assert.equal(
    projectSelectedTask({
      taskItems: [selected],
      selectedTaskId: "selected",
      activeThread,
      fallbackTask,
    }),
    selected,
  );
});

test("projectSelectedTask derives a prompt-session fallback from the active thread", () => {
  assert.deepEqual(
    projectSelectedTask({
      taskItems: [],
      selectedTaskId: "missing",
      activeThread,
      fallbackTask,
    }),
    {
      ...fallbackTask,
      id: "task-active",
      title: "Active thread",
      kind: "prompt_session",
      status: "queued",
    },
  );
});
