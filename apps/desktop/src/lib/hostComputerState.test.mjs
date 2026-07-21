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

test("safe app identity and resume generation are reduced", () => {
  const state = reduceHostComputerEvent(initialHostComputerState, {
    sequence: 1, session_id: "session", generation: 3, phase: "paused_by_user",
    app: "Notes", window: "Project notes", value: "private body",
  });
  assert.equal(state.generation, 3);
  assert.equal(state.app, "Notes");
  assert.equal(state.window, "Project notes");
  assert.equal(JSON.stringify(state).includes("private body"), false);
});

test("a new session starts its own sequence after a terminal session", () => {
  const finished = reduceHostComputerEvent(initialHostComputerState, {
    sequence: 8, session_id: "old", phase: "done", app: "Notes",
  });

  const next = reduceHostComputerEvent(finished, {
    sequence: 1, session_id: "new", phase: "observing", app: "Mail",
  });

  assert.equal(next.sessionId, "new");
  assert.equal(next.sequence, 1);
  assert.equal(next.phase, "observing");
  assert.equal(next.app, "Mail");
  assert.equal(next.needsHydration, false);
});
