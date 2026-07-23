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
      getStatus: async () => ({ status: "running" }),
      sleep: async () => {},
      maxReconnects: 2,
    }),
    (error) => error?.code === "turn_stream_recovery_exhausted",
  );
});
