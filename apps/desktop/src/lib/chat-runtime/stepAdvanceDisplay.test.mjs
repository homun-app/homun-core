import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidStepAdvancePayload, stepAdvanceDisplay } from "./stepAdvanceDisplay.mjs";

const base = {
  step_id: "step_01",
  title: "Ricerca voli",
  from: "doing",
  to: "done",
  verified: true,
  note: null,
};

test("isValidStepAdvancePayload accepts the exact contract shape", () => {
  assert.equal(isValidStepAdvancePayload(base), true);
  assert.equal(isValidStepAdvancePayload({ ...base, from: null, verified: null, note: null }), true);
});

test("isValidStepAdvancePayload rejects missing or mistyped contract fields", () => {
  assert.equal(isValidStepAdvancePayload(null), false);
  assert.equal(isValidStepAdvancePayload({}), false);
  assert.equal(isValidStepAdvancePayload({ step_id: "s", title: "t" }), false);
  assert.equal(isValidStepAdvancePayload({ step_id: "s", title: 1, to: "done" }), false);
});

test("verified completion maps to the verified label", () => {
  const display = stepAdvanceDisplay(base);
  assert.equal(display.kind, "verified");
  assert.equal(display.i18nKey, "chat.stepAdvance.verified");
  assert.deepEqual(display.params, { title: "Ricerca voli" });
});

test("verified=true but to!=done stays a transition", () => {
  const display = stepAdvanceDisplay({ ...base, to: "doing" });
  assert.equal(display.kind, "transition");
});

test("failed verification carries the note", () => {
  const display = stepAdvanceDisplay({ ...base, verified: false, note: "timeout rete" });
  assert.equal(display.kind, "unverified");
  assert.equal(display.i18nKey, "chat.stepAdvance.unverified");
  assert.deepEqual(display.params, { title: "Ricerca voli", note: "timeout rete" });
});

test("failed verification without note uses the noteless label", () => {
  const display = stepAdvanceDisplay({ ...base, verified: false, note: null });
  assert.equal(display.kind, "unverified");
  assert.equal(display.i18nKey, "chat.stepAdvance.unverifiedNoNote");
  assert.deepEqual(display.params, { title: "Ricerca voli" });
});

test("generic status change maps from -> to", () => {
  const display = stepAdvanceDisplay({ ...base, verified: null, from: "todo", to: "doing" });
  assert.equal(display.kind, "transition");
  assert.equal(display.i18nKey, "chat.stepAdvance.transition");
  assert.deepEqual(display.params, { title: "Ricerca voli", from: "todo", to: "doing" });
});

test("a null from falls back to an em dash", () => {
  const display = stepAdvanceDisplay({ ...base, verified: null, from: null, to: "doing" });
  assert.equal(display.params.from, "\u2014");
});
