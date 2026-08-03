import test from "node:test";
import assert from "node:assert/strict";
import { deriveComposerMode } from "./composerMode.mjs";

test("terminal turn starts a new turn instead of steering", () => {
  assert.equal(
    deriveComposerMode({
      promptSubmitting: false,
      streamingAssistantId: null,
      turnAwaitingUser: false,
      terminalTurnAtRest: true,
      hasActiveTurn: false,
    }).mode,
    "new_turn",
  );
});

test("waiting user reply is not treated as generic steering", () => {
  assert.equal(
    deriveComposerMode({
      promptSubmitting: false,
      streamingAssistantId: null,
      turnAwaitingUser: true,
      terminalTurnAtRest: false,
      hasActiveTurn: true,
    }).mode,
    "waiting_user_reply",
  );
});

test("active model work routes input as steering", () => {
  assert.equal(
    deriveComposerMode({
      promptSubmitting: false,
      streamingAssistantId: "assistant-1",
      turnAwaitingUser: false,
      terminalTurnAtRest: false,
      hasActiveTurn: true,
    }).mode,
    "steering",
  );
});

test("local submit disables duplicate send", () => {
  assert.equal(
    deriveComposerMode({
      promptSubmitting: true,
      streamingAssistantId: null,
      turnAwaitingUser: false,
      terminalTurnAtRest: false,
      hasActiveTurn: true,
    }).disabled,
    true,
  );
});
