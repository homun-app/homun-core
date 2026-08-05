import assert from "node:assert/strict";
import test from "node:test";

import { selectInitialThreadFromSnapshot } from "./initialThreadSelection.mjs";

const defaultThread = {
  threadId: "default",
  taskId: "task-default",
  status: "active",
  title: "Default",
};

const thread = (threadId, status = "active") => ({
  threadId,
  taskId: `task-${threadId}`,
  status,
  title: threadId,
});

test("selectInitialThreadFromSnapshot prefers the backend active thread", () => {
  const first = thread("first");
  const backendActive = thread("backend-active");

  assert.deepEqual(
    selectInitialThreadFromSnapshot({
      mappedThreads: [first, backendActive],
      snapshotActiveThreadId: "backend-active",
      defaultThread,
    }),
    {
      desiredThreads: [first, backendActive],
      selectedThread: backendActive,
    },
  );
});

test("selectInitialThreadFromSnapshot falls back to first mapped thread and default", () => {
  const first = thread("first");

  assert.deepEqual(
    selectInitialThreadFromSnapshot({
      mappedThreads: [first],
      snapshotActiveThreadId: "missing",
      defaultThread,
    }),
    {
      desiredThreads: [first],
      selectedThread: first,
    },
  );

  assert.deepEqual(
    selectInitialThreadFromSnapshot({
      mappedThreads: [],
      snapshotActiveThreadId: "missing",
      defaultThread,
    }),
    {
      desiredThreads: [defaultThread],
      selectedThread: defaultThread,
    },
  );
});
