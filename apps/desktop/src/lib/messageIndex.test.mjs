import assert from "node:assert/strict";
import test from "node:test";
import { buildBranchIndex, buildPreviousUserMessageIndex } from "./messageIndex.mjs";

test("maps every message to the user message before it in one pass", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "a2", role: "assistant" },
    { id: "u2", role: "user" },
    { id: "a3", role: "assistant" },
  ];
  const index = buildPreviousUserMessageIndex(messages);
  assert.equal(index.get("a1"), messages[0]);
  assert.equal(index.get("a2"), messages[0]);
  assert.equal(index.get("a3"), messages[3]);
});

test("a message with no preceding user message maps to null", () => {
  const index = buildPreviousUserMessageIndex([{ id: "a0", role: "assistant" }]);
  assert.equal(index.get("a0"), null);
});

test("branches are indexed by node id", () => {
  const branches = [
    { node_id: "n1", label: "A" },
    { node_id: "n2", label: "B" },
  ];
  const index = buildBranchIndex(branches);
  assert.equal(index.get("n2").label, "B");
  assert.equal(index.get("nope"), undefined);
});

// --- parity with the linear scan this index replaces -------------------------
// The three tests below pin the exact semantics of the former
// `findPreviousUserMessage(messages, id)` in ChatView: they are the cases where a
// naive index would silently change behaviour.

test("a user message maps to the user message BEFORE it, never to itself", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
  ];
  const index = buildPreviousUserMessageIndex(messages);
  assert.equal(index.get("u1"), null);
  assert.equal(index.get("u2"), messages[0]);
});

test("an unknown id is absent from the index", () => {
  const index = buildPreviousUserMessageIndex([{ id: "u1", role: "user" }]);
  assert.equal(index.get("ghost"), undefined);
  assert.equal(index.has("ghost"), false);
});

test("a duplicated id resolves like findIndex did: first occurrence wins", () => {
  const messages = [
    { id: "dup", role: "assistant" },
    { id: "u1", role: "user" },
    { id: "dup", role: "assistant" },
  ];
  const index = buildPreviousUserMessageIndex(messages);
  assert.equal(index.get("dup"), null);
});

test("a missing message list yields empty indexes instead of throwing", () => {
  assert.equal(buildPreviousUserMessageIndex(undefined).size, 0);
  assert.equal(buildBranchIndex(undefined).size, 0);
});
