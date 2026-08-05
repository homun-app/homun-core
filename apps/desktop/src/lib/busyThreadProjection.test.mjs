import assert from "node:assert/strict";
import test from "node:test";

import { projectBusyThreadIds } from "./busyThreadProjection.mjs";

test("projectBusyThreadIds includes background and foreground streams", () => {
  assert.deepEqual(
    [...projectBusyThreadIds({
      backgroundStreamIds: new Set(["background"]),
      streamingThreadId: "foreground",
      chatThreads: [],
      taskItems: [],
    })].sort(),
    ["background", "foreground"],
  );
});

test("projectBusyThreadIds includes queued and running thread tasks", () => {
  assert.deepEqual(
    [...projectBusyThreadIds({
      backgroundStreamIds: new Set(),
      streamingThreadId: null,
      chatThreads: [
        { threadId: "a", taskId: "task_a" },
        { threadId: "b", taskId: "task_b" },
        { threadId: "c", taskId: "task_c" },
      ],
      taskItems: [
        { id: "task_a", status: "queued" },
        { id: "task_b", status: "running" },
        { id: "task_c", status: "completed" },
      ],
    })].sort(),
    ["a", "b"],
  );
});

test("projectBusyThreadIds keeps unique ids when sources overlap", () => {
  assert.deepEqual(
    [...projectBusyThreadIds({
      backgroundStreamIds: new Set(["thread"]),
      streamingThreadId: "thread",
      chatThreads: [{ threadId: "thread", taskId: "task" }],
      taskItems: [{ id: "task", status: "running" }],
    })],
    ["thread"],
  );
});
