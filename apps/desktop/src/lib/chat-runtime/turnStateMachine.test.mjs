import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalTurnId,
  createRequestId,
  clearStreamStatusForRequest,
  isTerminalWsTurnStatus,
  isTurnIdle,
  requestIdFromTurnId,
} from "./turnStateMachine.mjs";

test("createLocalTurnId wraps requestId with turn_ prefix", () => {
  assert.equal(createLocalTurnId("chat_stream_123"), "turn_chat_stream_123");
  assert.equal(createLocalTurnId("abc"), "turn_abc");
});

test("createRequestId produces prefixed unique IDs", () => {
  const id1 = createRequestId("chat_stream");
  const id2 = createRequestId("chat_stream");
  assert.ok(id1.startsWith("chat_stream_"));
  assert.ok(id2.startsWith("chat_stream_"));
  assert.notEqual(id1, id2, "IDs must be unique");
});

test("createRequestId accepts arbitrary prefixes", () => {
  const steering = createRequestId("chat_steering");
  const regen = createRequestId("chat_stream_regen");
  assert.ok(steering.startsWith("chat_steering_"));
  assert.ok(regen.startsWith("chat_stream_regen_"));
});

test("clearStreamStatusForRequest clears matching request", () => {
  const current = { requestId: "req_1", phase: "thinking", title: "T", detail: "" };
  assert.equal(clearStreamStatusForRequest(current, "req_1"), null);
});

test("clearStreamStatusForRequest preserves non-matching request", () => {
  const current = { requestId: "req_1", phase: "thinking", title: "T", detail: "" };
  const result = clearStreamStatusForRequest(current, "req_2");
  assert.equal(result, current);
});

test("clearStreamStatusForRequest handles null current", () => {
  assert.equal(clearStreamStatusForRequest(null, "req_1"), null);
});

test("isTerminalWsTurnStatus recognises terminal statuses", () => {
  assert.equal(isTerminalWsTurnStatus("completed"), true);
  assert.equal(isTerminalWsTurnStatus("failed"), true);
  assert.equal(isTerminalWsTurnStatus("cancelled"), true);
});

test("isTerminalWsTurnStatus rejects non-terminal statuses", () => {
  assert.equal(isTerminalWsTurnStatus("running"), false);
  assert.equal(isTerminalWsTurnStatus("waiting_user_approval"), false);
  assert.equal(isTerminalWsTurnStatus("finalizing"), false);
  assert.equal(isTerminalWsTurnStatus(""), false);
});

test("isTurnIdle is true when no submit and no streaming", () => {
  assert.equal(isTurnIdle(false, null), true);
});

test("isTurnIdle is false when submitting", () => {
  assert.equal(isTurnIdle(true, null), false);
});

test("isTurnIdle is false when streaming", () => {
  assert.equal(isTurnIdle(false, "assistant_1"), false);
});

test("isTurnIdle is false when both submitting and streaming", () => {
  assert.equal(isTurnIdle(true, "assistant_1"), false);
});

test("requestIdFromTurnId strips turn_ prefix", () => {
  assert.equal(requestIdFromTurnId("turn_chat_stream_123"), "chat_stream_123");
});

test("requestIdFromTurnId returns unchanged if no prefix", () => {
  assert.equal(requestIdFromTurnId("chat_stream_123"), "chat_stream_123");
});
