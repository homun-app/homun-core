import test from "node:test";
import assert from "node:assert/strict";

import { visibleEventParts, visibleMessageText } from "./chatVisibleContent.mjs";

test("reasoning is discarded from text and structured parts", () => {
  assert.equal(
    visibleMessageText("‹‹REASONING››segreto‹‹/REASONING››\nRisposta"),
    "Risposta",
  );
  assert.deepEqual(
    visibleEventParts([
      { type: "reasoning", text: "raw" },
      { type: "activity", text: "Uso il browser" },
    ]),
    [{ type: "activity", text: "Uso il browser" }],
  );
});

test("an unterminated reasoning block cannot leak while streaming", () => {
  assert.equal(visibleMessageText("Risposta stabile\n<think>bozza privata"), "Risposta stabile");
  assert.equal(visibleMessageText("<thinking>bozza privata"), "");
});
