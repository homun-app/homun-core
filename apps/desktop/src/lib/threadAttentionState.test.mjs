import test from "node:test";
import assert from "node:assert/strict";

import {
  applyThreadSignal,
  createThreadAttentionState,
  selectThread,
} from "./threadAttentionState.mjs";

test("background completion never changes selection", () => {
  const initial = createThreadAttentionState("thread_b");
  const next = applyThreadSignal(initial, {
    threadId: "thread_a",
    status: "completed",
    terminalEventId: 41,
  });

  assert.equal(next.selectedThreadId, "thread_b");
  assert.equal(next.byThread.thread_a, "completed_unread");
});

test("opening the task clears only its unread", () => {
  const unread = applyThreadSignal(createThreadAttentionState("thread_b"), {
    threadId: "thread_a",
    status: "completed",
    terminalEventId: 41,
  });
  const next = selectThread(unread, "thread_a");

  assert.equal(next.selectedThreadId, "thread_a");
  assert.equal(next.byThread.thread_a, "idle");
  assert.equal(next.seenTerminalEventIds.thread_a, 41);
});
