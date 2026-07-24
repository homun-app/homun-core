import test from "node:test";
import assert from "node:assert/strict";

import { createStreamSequenceGate } from "./streamSequenceGate.mjs";

test("accepts each request sequence once", () => {
  const gate = createStreamSequenceGate();

  assert.equal(gate.accept({ request_id: "r", seq: 7 }), true);
  assert.equal(gate.accept({ request_id: "r", seq: 7 }), false);
  assert.equal(gate.accept({ request_id: "r", seq: 6 }), false);
  assert.equal(gate.accept({ request_id: "r", seq: 8 }), true);
  assert.equal(gate.accept({ request_id: "other", seq: 1 }), true);
});

test("keeps legacy unsequenced events compatible and bounds request cursors", () => {
  const gate = createStreamSequenceGate(2);

  assert.equal(gate.accept({ request_id: "legacy" }), true);
  assert.equal(gate.accept({ request_id: "a", seq: 1 }), true);
  assert.equal(gate.accept({ request_id: "b", seq: 1 }), true);
  assert.equal(gate.accept({ request_id: "c", seq: 1 }), true);
  assert.equal(gate.size(), 2);
  assert.equal(gate.accept({ request_id: "a", seq: 1 }), true);
});
