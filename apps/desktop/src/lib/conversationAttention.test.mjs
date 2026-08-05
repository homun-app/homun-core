import test from "node:test";
import assert from "node:assert/strict";

import {
  attentionRequiredThreadIds,
  mergeConversationAttention,
  projectConversationAttention,
  requiresAttention,
} from "./conversationAttention.mjs";

test("approvals and uncertain effects resolve to their owning conversations", () => {
  const threads = [
    { threadId: "thread-a", taskId: "task-a", computerSessionId: "computer-a" },
    { threadId: "thread-b", taskId: "task-b", computerSessionId: "computer-b" },
  ];
  const approvals = [
    { taskId: "task-a", requestedBy: "task-a computer-a" },
  ];
  const effects = [
    { threadId: "thread-b" },
    { threadId: null },
  ];

  assert.deepEqual(
    [...attentionRequiredThreadIds(threads, approvals, effects)].sort(),
    ["thread-a", "thread-b"],
  );
});

test("a durable intervention projects waiting user without erasing unrelated states", () => {
  assert.deepEqual(
    mergeConversationAttention(
      {
        "thread-a": "idle",
        "thread-b": "working",
        "thread-c": "failed",
      },
      new Set(["thread-a", "thread-b"]),
    ),
    {
      "thread-a": "waiting_user",
      "thread-b": "waiting_user",
      "thread-c": "failed",
    },
  );
});

test("projectConversationAttention overlays working and waiting states", () => {
  assert.deepEqual(
    projectConversationAttention(
      {
        "thread-a": "idle",
        "thread-b": "completed_unread",
        "thread-c": "failed",
      },
      new Set(["thread-a", "thread-b", "thread-d"]),
      new Set(["thread-b"]),
    ),
    {
      "thread-a": "working",
      "thread-b": "waiting_user",
      "thread-c": "failed",
      "thread-d": "working",
    },
  );
});

test("the attention filter includes waits and failures, not active or unread conversations", () => {
  assert.equal(requiresAttention("waiting_user"), true);
  assert.equal(requiresAttention("failed"), true);
  assert.equal(requiresAttention("working"), false);
  assert.equal(requiresAttention("completed_unread"), false);
  assert.equal(requiresAttention("idle"), false);
});
