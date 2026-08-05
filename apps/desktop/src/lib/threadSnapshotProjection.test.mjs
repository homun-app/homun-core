import assert from "node:assert/strict";
import test from "node:test";

import { projectThreadSnapshotSelection } from "./threadSnapshotProjection.mjs";

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

test("projectThreadSnapshotSelection preserves the current active thread when still active", () => {
  const current = thread("current");
  const backendActive = thread("backend");

  assert.deepEqual(
    projectThreadSnapshotSelection({
      mappedThreads: [backendActive, current],
      activeThreadId: "current",
      snapshotActiveThreadId: "backend",
      defaultThread,
    }),
    {
      desiredThreads: [backendActive, current],
      preservedThread: current,
      selectedThread: current,
    },
  );
});

test("projectThreadSnapshotSelection falls through backend active, first active, and default", () => {
  const archivedCurrent = thread("current", "archived");
  const backendActive = thread("backend");
  const otherActive = thread("other");

  assert.equal(
    projectThreadSnapshotSelection({
      mappedThreads: [archivedCurrent, backendActive, otherActive],
      activeThreadId: "current",
      snapshotActiveThreadId: "backend",
      defaultThread,
    }).selectedThread,
    backendActive,
  );

  assert.equal(
    projectThreadSnapshotSelection({
      mappedThreads: [archivedCurrent, otherActive],
      activeThreadId: "missing",
      snapshotActiveThreadId: "missing",
      defaultThread,
    }).selectedThread,
    otherActive,
  );

  assert.deepEqual(
    projectThreadSnapshotSelection({
      mappedThreads: [],
      activeThreadId: "missing",
      snapshotActiveThreadId: "missing",
      defaultThread,
    }),
    {
      desiredThreads: [defaultThread],
      preservedThread: undefined,
      selectedThread: defaultThread,
    },
  );
});
