import test from "node:test";
import assert from "node:assert/strict";

import { applyTurnEvent, createTurnReplayState } from "./turnReplayState.mjs";

test("duplicate and post-terminal events are ignored", () => {
  let state = createTurnReplayState("turn");
  state = applyTurnEvent(state, {
    turn_id: "turn",
    seq: 1,
    kind: "delta",
    payload: { text: "A" },
  });
  state = applyTurnEvent(state, {
    turn_id: "turn",
    seq: 2,
    kind: "done",
    payload: {},
  });
  state = applyTurnEvent(state, {
    turn_id: "turn",
    seq: 2,
    kind: "done",
    payload: {},
  });
  state = applyTurnEvent(state, {
    turn_id: "turn",
    seq: 3,
    kind: "retry",
    payload: {},
  });

  assert.equal(state.text, "A");
  assert.equal(state.status, "completed");
  assert.equal(state.lastSeq, 2);
});

test("other turns and out-of-order events cannot mutate the snapshot", () => {
  const initial = applyTurnEvent(createTurnReplayState("turn"), {
    turn_id: "turn",
    seq: 4,
    kind: "delta",
    payload: { text: "stable" },
  });
  const other = applyTurnEvent(initial, {
    turn_id: "other",
    seq: 5,
    kind: "delta",
    payload: { text: "leak" },
  });
  const stale = applyTurnEvent(other, {
    turn_id: "turn",
    seq: 3,
    kind: "delta",
    payload: { text: "old" },
  });

  assert.deepEqual(stale, initial);
});

test("attempt abort clears provisional text and keeps the logical turn replayable", () => {
  let state = applyTurnEvent(createTurnReplayState("turn"), {
    turn_id: "turn",
    seq: 1,
    kind: "delta",
    payload: { text: "partial" },
  });
  state = applyTurnEvent(state, {
    turn_id: "turn",
    seq: 2,
    kind: "aborted",
    payload: { reason: "gateway_restart" },
  });
  state = applyTurnEvent(state, {
    turn_id: "turn",
    seq: 3,
    kind: "delta",
    payload: { text: "recovered" },
  });

  assert.equal(state.text, "recovered");
  assert.equal(state.status, "running");
  assert.equal(state.lastSeq, 3);
});
