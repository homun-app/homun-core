import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileChatMessages,
  reconcileChatThreads,
  reconcileMemoryArtifacts,
} from "./uiSnapshot.mjs";

function message(overrides = {}) {
  return {
    id: "message-1",
    role: "assistant",
    text: "stable",
    timestamp: "2026-07-20T12:00:00Z",
    attachments: [],
    eventParts: [],
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    reference: "artifact-1",
    name: "report.md",
    title: "Report",
    artifact_type: "markdown",
    source: "project",
    storage: "project",
    project_relative_path: "docs/report.md",
    project_path: "/project/docs/report.md",
    managed_path: null,
    size: 120,
    updated: false,
    thread: "thread-1",
    ...overrides,
  };
}

function thread(overrides = {}) {
  return {
    threadId: "thread-1",
    workspaceId: null,
    title: "One",
    subtitle: "A chat",
    status: "active",
    pinned: false,
    computerSessionId: "session-1",
    taskId: "task-1",
    updatedAt: "2026-07-20T12:00:00Z",
    messageCount: 2,
    source: null,
    channelRecipient: null,
    ...overrides,
  };
}

test("an unchanged poll keeps the previous thread array identity", () => {
  const current = [thread({ threadId: "a" }), thread({ threadId: "b", title: "Two" })];
  const incoming = [thread({ threadId: "a" }), thread({ threadId: "b", title: "Two" })];
  // Identity matters, not equality: a fresh array re-renders App, Sidebar, Shell
  // and ChatView every 2.5s, mid-stream.
  assert.strictEqual(reconcileChatThreads(current, incoming), current);
});

test("a changed thread yields a new array but reuses the untouched objects", () => {
  const current = [thread({ threadId: "a" }), thread({ threadId: "b", title: "Two" })];
  const incoming = [thread({ threadId: "a" }), thread({ threadId: "b", title: "Renamed" })];
  const result = reconcileChatThreads(current, incoming);
  assert.notStrictEqual(result, current);
  assert.strictEqual(result[0], current[0], "the untouched thread keeps its identity");
  assert.equal(result[1].title, "Renamed");
});

test("a reordered thread list is never swallowed, yet moved rows keep their identity", () => {
  // The sidebar is most-recent-first: a new message reorders the list without
  // changing any field. Reconciling by id alone would hide the move entirely.
  const current = [thread({ threadId: "a" }), thread({ threadId: "b", title: "Two" })];
  const incoming = [thread({ threadId: "b", title: "Two" }), thread({ threadId: "a" })];
  const result = reconcileChatThreads(current, incoming);
  assert.notStrictEqual(result, current);
  assert.deepEqual(result.map((item) => item.threadId), ["b", "a"]);
  assert.strictEqual(result[0], current[1], "the moved thread keeps its identity");
  assert.strictEqual(result[1], current[0], "the moved thread keeps its identity");
});

test("thread insertion and removal accept the incoming snapshot", () => {
  const one = [thread({ threadId: "a" })];
  const two = [thread({ threadId: "a" }), thread({ threadId: "b" })];
  assert.strictEqual(reconcileChatThreads(one, two), two);
  assert.strictEqual(reconcileChatThreads(two, one), one);
});

test("thread activity changes are not hidden by reconciliation", () => {
  const current = [thread()];
  for (const change of [
    { messageCount: 3 },
    { updatedAt: "2026-07-20T12:00:05Z" },
    { pinned: true },
    { status: "archived" },
    { subtitle: "Another chat" },
    { taskId: "task-2" },
    { computerSessionId: "session-2" },
    { workspaceId: "workspace-2" },
    { source: "telegram" },
    { channelRecipient: "@fabio" },
  ]) {
    const incoming = [thread(change)];
    const result = reconcileChatThreads(current, incoming);
    assert.notStrictEqual(
      result,
      current,
      `change ${JSON.stringify(change)} must reach the UI`,
    );
    assert.strictEqual(
      result[0],
      incoming[0],
      `change ${JSON.stringify(change)} must reach the UI`,
    );
  }
});

test("an absent previous thread list accepts the incoming snapshot", () => {
  const incoming = [thread()];
  assert.strictEqual(reconcileChatThreads(undefined, incoming), incoming);
});

test("unchanged message polling reuses the current snapshot", () => {
  const current = [message()];
  const incoming = [message()];
  assert.equal(reconcileChatMessages(current, incoming), current);
});

test("a real message change accepts the incoming snapshot", () => {
  const current = [message({ text: "before" })];
  const incoming = [message({ text: "after" })];
  assert.equal(reconcileChatMessages(current, incoming), incoming);
});

test("structured event changes are not hidden by reconciliation", () => {
  const current = [message({ eventParts: [{ type: "activity", text: "one" }] })];
  const incoming = [message({ eventParts: [{ type: "activity", text: "two" }] })];
  assert.equal(reconcileChatMessages(current, incoming), incoming);
});

test("attachment and metric changes are not hidden by reconciliation", () => {
  const current = [message({ attachments: [{ artifactId: "a", sizeBytes: 1 }] })];
  const incoming = [message({ attachments: [{ artifactId: "a", sizeBytes: 2 }] })];
  assert.equal(reconcileChatMessages(current, incoming), incoming);

  const currentMetrics = [message({ metrics: { generationTokens: 1 } })];
  const incomingMetrics = [message({ metrics: { generationTokens: 2 } })];
  assert.equal(reconcileChatMessages(currentMetrics, incomingMetrics), incomingMetrics);
});

test("message insertion and removal accept the incoming snapshot", () => {
  const one = [message({ id: "one" })];
  const two = [message({ id: "one" }), message({ id: "two" })];
  assert.equal(reconcileChatMessages(one, two), two);
  assert.equal(reconcileChatMessages(two, one), one);
});

test("unchanged artifact catalogs retain object identity", () => {
  const current = [artifact()];
  const incoming = [artifact()];
  assert.equal(reconcileMemoryArtifacts(current, incoming), current);
});

test("changed artifact metadata accepts the incoming catalog", () => {
  const current = [artifact()];
  const incoming = [artifact({ updated: true })];
  assert.equal(reconcileMemoryArtifacts(current, incoming), incoming);
});

test("changed artifact authorization paths accept the incoming catalog", () => {
  const current = [artifact()];
  const incoming = [artifact({ project_path: "/other/report.md" })];
  assert.equal(reconcileMemoryArtifacts(current, incoming), incoming);
});
