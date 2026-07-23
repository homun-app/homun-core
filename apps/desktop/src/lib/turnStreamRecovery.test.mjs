import test from "node:test";
import assert from "node:assert/strict";

import { recoverTurnStream } from "./turnStreamRecovery.mjs";

test("reopens after non-terminal EOF from the last sequence", async () => {
  const cursors = [];
  const connections = [
    [{ turn_id: "turn", seq: 1, kind: "delta", payload: { text: "A" } }],
    [
      { turn_id: "turn", seq: 2, kind: "delta", payload: { text: "B" } },
      { turn_id: "turn", seq: 3, kind: "done", payload: {} },
    ],
  ];
  const accepted = [];

  const result = await recoverTurnStream({
    turnId: "turn",
    connect: async ({ since, onEvent }) => {
      cursors.push(since);
      for (const event of connections.shift() ?? []) onEvent(event);
    },
    getStatus: async () => ({ status: "running" }),
    onEvent: (event) => accepted.push(event.seq),
    sleep: async () => {},
    maxReconnects: 3,
  });

  assert.deepEqual(cursors, [0, 1]);
  assert.deepEqual(accepted, [1, 2, 3]);
  assert.equal(result.text, "AB");
  assert.equal(result.status, "completed");
});

test("ignores replayed sequence numbers across reconnects", async () => {
  const connections = [
    [{ turn_id: "turn", seq: 1, kind: "delta", payload: { text: "A" } }],
    [
      { turn_id: "turn", seq: 1, kind: "delta", payload: { text: "A" } },
      { turn_id: "turn", seq: 2, kind: "done", payload: {} },
    ],
  ];

  const result = await recoverTurnStream({
    turnId: "turn",
    connect: async ({ onEvent }) => {
      for (const event of connections.shift() ?? []) onEvent(event);
    },
    getStatus: async () => ({ status: "running" }),
    sleep: async () => {},
  });

  assert.equal(result.text, "A");
  assert.equal(result.lastSeq, 2);
});

test("fails with a typed error after the reconnect budget", async () => {
  await assert.rejects(
    recoverTurnStream({
      turnId: "turn",
      connect: async () => {},
      getStatus: async () => ({ status: "completed" }),
      sleep: async () => {},
      maxReconnects: 2,
    }),
    (error) => error?.code === "turn_stream_recovery_exhausted",
  );
});

test("does not exhaust reconnects while the durable turn is still running", async () => {
  let connections = 0;
  const result = await recoverTurnStream({
    turnId: "turn",
    connect: async ({ onEvent }) => {
      connections += 1;
      if (connections === 7) {
        onEvent({ turn_id: "turn", seq: 1, kind: "delta", payload: { text: "OK" } });
        onEvent({ turn_id: "turn", seq: 2, kind: "done", payload: {} });
      }
    },
    getStatus: async () => ({ status: "running" }),
    sleep: async () => {},
    maxReconnects: 2,
  });

  assert.equal(connections, 7);
  assert.equal(result.status, "completed");
  assert.equal(result.text, "OK");
});

test("settles after a durable user-approval handoff with streamed content", async () => {
  const result = await recoverTurnStream({
    turnId: "turn",
    connect: async ({ onEvent }) => {
      onEvent({
        turn_id: "turn",
        seq: 1,
        kind: "delta",
        payload: { text: "[PAYMENT_APPROVAL_REQUIRED]" },
      });
    },
    getStatus: async () => ({ status: "waiting_user_approval" }),
    sleep: async () => {},
  });

  assert.equal(result.status, "completed");
  assert.equal(result.text, "[PAYMENT_APPROVAL_REQUIRED]");
});

test("bounds an active turn that makes no durable stream progress", async () => {
  let statusReads = 0;
  await assert.rejects(
    recoverTurnStream({
      turnId: "turn",
      connect: async () => {},
      getStatus: async () => {
        statusReads += 1;
        if (statusReads > 4) throw new Error("test guard");
        return { status: "running" };
      },
      sleep: async () => {},
      maxActiveReconnects: 2,
    }),
    (error) => error?.code === "turn_stream_recovery_exhausted",
  );
});
