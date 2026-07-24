import assert from "node:assert/strict";
import test from "node:test";
import { nextSettledValue } from "./settledText.mjs";

test("a value that keeps changing is never settled early", () => {
  // Highlighting a growing fence on every frame is the cost we are removing:
  // only a quiet block is worth syntax-highlighting.
  assert.equal(nextSettledValue({ current: "abc", settled: "", elapsedMs: 40, quietMs: 120 }), "");
});

test("a value quiet for long enough settles", () => {
  assert.equal(nextSettledValue({ current: "abc", settled: "", elapsedMs: 200, quietMs: 120 }), "abc");
});

test("the very first value settles immediately", () => {
  assert.equal(
    nextSettledValue({ current: "abc", settled: undefined, elapsedMs: 0, quietMs: 120 }),
    "abc",
  );
});
