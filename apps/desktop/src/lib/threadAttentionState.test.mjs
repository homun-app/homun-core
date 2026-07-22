import test from "node:test";
import assert from "node:assert/strict";

import {
  applyThreadSignal,
  createThreadAttentionState,
  hydrateThreadAttentionState,
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

test("hydration preserves selection and derives unread from durable cursors", () => {
  const state = hydrateThreadAttentionState(createThreadAttentionState("thread_b"), [
    {
      threadId: "thread_a",
      status: "completed",
      terminalEventId: 41,
      lastSeenTerminalEventId: 12,
    },
    {
      threadId: "thread_b",
      status: "running",
      terminalEventId: 20,
      lastSeenTerminalEventId: 20,
    },
  ]);

  assert.equal(state.selectedThreadId, "thread_b");
  assert.equal(state.byThread.thread_a, "completed_unread");
  assert.equal(state.byThread.thread_b, "working");
  assert.equal(state.seenTerminalEventIds.thread_a, 12);
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

test("completion of the selected task records its terminal cursor as seen", () => {
  const next = applyThreadSignal(createThreadAttentionState("thread_a"), {
    threadId: "thread_a",
    status: "completed",
    terminalEventId: 41,
  });

  assert.equal(next.byThread.thread_a, "idle");
  assert.equal(next.seenTerminalEventIds.thread_a, 41);
});

test("late terminal signals cannot regress the cursor or restore unread", () => {
  const completed = applyThreadSignal(createThreadAttentionState("thread_b"), {
    threadId: "thread_a",
    status: "completed",
    terminalEventId: 41,
  });
  const read = selectThread(completed, "thread_a");
  const late = applyThreadSignal(read, {
    threadId: "thread_a",
    status: "completed",
    terminalEventId: 20,
  });

  assert.equal(late.terminalEventIds.thread_a, 41);
  assert.equal(late.seenTerminalEventIds.thread_a, 41);
  assert.equal(late.byThread.thread_a, "idle");
});
