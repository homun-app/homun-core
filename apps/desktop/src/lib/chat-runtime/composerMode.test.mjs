import test from "node:test";
import assert from "node:assert/strict";
import { deriveComposerMode } from "./composerMode.mjs";

test("terminal turn starts a new turn instead of steering", () => {
  assert.deepEqual(deriveComposerMode({
    promptSubmitting: false,
    streamingAssistantId: null,
    turnAwaitingUser: false,
    terminalTurnAtRest: true,
    hasActiveTurn: false,
  }), { mode: "new_turn", disabled: false, forceNewTurn: true });
});

test("waiting user reply is not treated as generic steering", () => {
  assert.deepEqual(deriveComposerMode({
    promptSubmitting: false,
    streamingAssistantId: null,
    turnAwaitingUser: true,
    terminalTurnAtRest: false,
    hasActiveTurn: true,
  }), { mode: "waiting_user_reply", disabled: false, forceNewTurn: true });
});

test("active model work routes input as steering", () => {
  assert.deepEqual(deriveComposerMode({
    promptSubmitting: false,
    streamingAssistantId: "assistant-1",
    turnAwaitingUser: false,
    terminalTurnAtRest: false,
    hasActiveTurn: true,
  }), { mode: "steering", disabled: false, forceNewTurn: false });
});

test("local submit disables duplicate send", () => {
  assert.deepEqual(deriveComposerMode({
    promptSubmitting: true,
    streamingAssistantId: null,
    turnAwaitingUser: false,
    terminalTurnAtRest: false,
    hasActiveTurn: true,
  }), { mode: "disabled", disabled: true, forceNewTurn: false });
});
