import test from "node:test";
import assert from "node:assert/strict";
import { visibleAssistantText } from "./visibleContent.mjs";

test("persisted reasoning marker is removed from visible answer", () => {
  const input = "Prima. ‹‹REASONING››raw chain‹‹/REASONING›› Dopo.";
  assert.equal(visibleAssistantText(input), "Prima.  Dopo.");
});

test("closed think block is removed from visible answer", () => {
  const input = "Risposta <think>secret</think> finale";
  assert.equal(visibleAssistantText(input), "Risposta  finale");
});

test("unterminated think block is hidden while streaming", () => {
  const input = "Risposta visibile <think>secret still streaming";
  assert.equal(visibleAssistantText(input), "Risposta visibile");
});

test("weak model prose tool call is removed", () => {
  const input = "Prima <tool_call name=\"browse\">{\"q\":\"x\"}</tool_call> Dopo";
  assert.equal(visibleAssistantText(input), "Prima  Dopo");
});

test("unterminated weak model prose tool call is removed to end", () => {
  const input = "Prima <tool_call name=\"browse\">{\"q\":\"x\"}";
  assert.equal(visibleAssistantText(input), "Prima");
});
