import assert from "node:assert/strict";
import test from "node:test";
import { initialHostComputerState, reduceHostComputerEvent } from "./hostComputerState.mjs";

test("physical takeover invalidates approval controls and shows resume", () => {
  const waiting = reduceHostComputerEvent(initialHostComputerState, {
    sequence: 1, session_id: "s", phase: "awaiting_approval",
    approval: { category: "send", summary: "Send message", action_digest: "digest", text: "secret" },
  });
  const paused = reduceHostComputerEvent(waiting, { sequence: 2, session_id: "s", phase: "paused_by_user" });
  assert.equal(paused.pendingApproval, null);
  assert.equal(paused.canResume, true);
  assert.equal(JSON.stringify(paused).includes("secret"), false);
});

test("stale events are ignored and sequence gaps request hydration", () => {
  const active = reduceHostComputerEvent(initialHostComputerState, { sequence: 4, phase: "acting" });
  assert.equal(reduceHostComputerEvent(active, { sequence: 3, phase: "failed" }), active);
  assert.equal(reduceHostComputerEvent(active, { sequence: 6, phase: "done" }).needsHydration, true);
});

test("screenshots remain opaque references", () => {
  const state = reduceHostComputerEvent(initialHostComputerState, {
    sequence: 1, phase: "observing", artifact_ref: "host-computer:abc", data: "base64-secret",
  });
  assert.equal(state.artifactRef, "host-computer:abc");
  assert.equal(JSON.stringify(state).includes("base64-secret"), false);
});
