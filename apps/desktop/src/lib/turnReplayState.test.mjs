import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTurnEvent,
  createTurnReplayState,
  prepareHitlResumeMessages,
} from "./turnReplayState.mjs";

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

test("terminal done text replaces speculative deltas from a rejected model round", () => {
  let state = applyTurnEvent(createTurnReplayState("turn", { lastSeq: 16 }), {
    turn_id: "turn",
    seq: 17,
    kind: "delta",
    payload: { text: "replayed wait" },
  });
  state = applyTurnEvent(state, {
    turn_id: "turn",
    seq: 18,
    kind: "done",
    payload: { text: "SCELTA RIPRESA ALFA" },
  });

  assert.equal(state.text, "SCELTA RIPRESA ALFA");
  assert.equal(state.status, "completed");
});

test("a typed suspended event closes only the streamed revision", () => {
  const state = applyTurnEvent(createTurnReplayState("turn"), {
    turn_id: "turn",
    seq: 4,
    kind: "suspended",
    payload: { revision: 1 },
  });

  assert.equal(state.status, "completed");
  assert.equal(state.lastSeq, 4);
});

test("HITL resume reuses one assistant after the user resolution", () => {
  const original = [
    { id: "prompt", role: "user", text: "choose" },
    { id: "assistant", role: "assistant", text: "A or B", eventParts: [{ type: "choice" }] },
  ];
  const resolution = { id: "resolution", role: "user", text: "A" };

  const prepared = prepareHitlResumeMessages(original, "assistant", resolution);

  assert.deepEqual(
    prepared.promptMessages.map((message) => message.id),
    ["prompt", "resolution"],
  );
  assert.equal(prepared.streamingMessage.id, "assistant");
  assert.equal(prepared.streamingMessage.text, "");
  assert.deepEqual(prepared.streamingMessage.eventParts, []);
  assert.equal(original[1].text, "A or B");
});
