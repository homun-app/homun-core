import test from "node:test";
import assert from "node:assert/strict";
import { routeComposerSubmission } from "./submissionRouting.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function atRest(overrides = {}) {
  return {
    promptSubmitting: false,
    streamingAssistantId: null,
    turnUiState: {
      isStreaming: false,
      turnAwaitingUser: false,
      terminalTurnAtRest: false,
      hasActiveTurn: false,
      workInProgress: false,
    },
    composerMode: "new_turn",
    ...overrides,
  };
}

test("submission routing consumes presenter turn state instead of raw projection status", () => {
  const result = routeComposerSubmission(
    atRest({
      turnUiState: {
        isStreaming: false,
        turnAwaitingUser: false,
        terminalTurnAtRest: false,
        hasActiveTurn: true,
        workInProgress: true,
      },
      composerMode: "steer_active_turn",
    }),
  );

  assert.equal(result.mode, "steering");
  assert.equal(result.forceNewTurn, false);
  assert.equal(result.routesToSteering, true);
});

test("submission routing does not own a fallback composer-mode derivation", () => {
  const source = readFileSync(fileURLToPath(new URL("./submissionRouting.mjs", import.meta.url)), "utf8");

  assert.doesNotMatch(source, /deriveComposerMode/);
  assert.doesNotMatch(source, /projectionLoaded/);
});

test("active model work routes composer input as steering", () => {
  const streaming = routeComposerSubmission(
    atRest({
      turnUiState: {
        isStreaming: true,
        turnAwaitingUser: false,
        terminalTurnAtRest: false,
        hasActiveTurn: true,
        workInProgress: true,
      },
      composerMode: "steer_active_turn",
    }),
  );
  assert.equal(streaming.mode, "steering");
  assert.equal(streaming.forceNewTurn, false);
  assert.equal(streaming.routesToSteering, true);

  const projected = routeComposerSubmission(
    atRest({
      turnUiState: {
        isStreaming: false,
        turnAwaitingUser: false,
        terminalTurnAtRest: false,
        hasActiveTurn: true,
        workInProgress: true,
      },
      composerMode: "steer_active_turn",
    }),
  );
  assert.equal(projected.routesToSteering, true);
  assert.equal(projected.forceNewTurn, false);
});

test("terminal turn at rest starts a new turn instead of steering", () => {
  const result = routeComposerSubmission(
    atRest({
      turnUiState: {
        isStreaming: false,
        turnAwaitingUser: false,
        terminalTurnAtRest: true,
        hasActiveTurn: false,
        workInProgress: false,
      },
      composerMode: "new_turn",
    }),
  );
  assert.equal(result.mode, "new_turn");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("waiting user reply never becomes mid-turn steering", () => {
  const result = routeComposerSubmission(
    atRest({
      turnUiState: {
        isStreaming: false,
        turnAwaitingUser: true,
        terminalTurnAtRest: false,
        hasActiveTurn: true,
        workInProgress: false,
      },
      composerMode: "reply_to_user_wait",
    }),
  );
  assert.equal(result.mode, "waiting_user_reply");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("kernel composer_mode routes active turns without local status inference", () => {
  const result = routeComposerSubmission(
    atRest({
      turnUiState: {
        isStreaming: false,
        turnAwaitingUser: false,
        terminalTurnAtRest: false,
        hasActiveTurn: true,
        workInProgress: true,
      },
      composerMode: "steer_active_turn",
    }),
  );
  assert.equal(result.mode, "steering");
  assert.equal(result.forceNewTurn, false);
  assert.equal(result.routesToSteering, true);
});

test("kernel composer_mode routes user waits as new-turn replies", () => {
  const result = routeComposerSubmission(
    atRest({
      turnUiState: {
        isStreaming: false,
        turnAwaitingUser: true,
        terminalTurnAtRest: false,
        hasActiveTurn: true,
        workInProgress: false,
      },
      composerMode: "reply_to_user_wait",
    }),
  );
  assert.equal(result.mode, "waiting_user_reply");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("open HITL wait marker at the chat tail is display-only for submission routing", () => {
  const result = routeComposerSubmission(atRest());
  assert.equal(result.mode, "new_turn");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("loaded projection quarantines legacy HITL marker routing", () => {
  const result = routeComposerSubmission(
    atRest({
      turnUiState: {
        isStreaming: false,
        turnAwaitingUser: false,
        terminalTurnAtRest: true,
        hasActiveTurn: false,
        workInProgress: false,
      },
      composerMode: "new_turn",
    }),
  );
  assert.equal(result.mode, "new_turn");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("explicit HITL Free resolution overrides the steering gate on active work", () => {
  const result = routeComposerSubmission(
    atRest({
      turnUiState: {
        isStreaming: true,
        turnAwaitingUser: false,
        terminalTurnAtRest: false,
        hasActiveTurn: true,
        workInProgress: true,
      },
      composerMode: "steer_active_turn",
      explicitForceNewTurn: true,
    }),
  );
  assert.equal(result.workInProgress, true);
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("submission in progress disables the composer without forcing a turn", () => {
  const result = routeComposerSubmission(atRest({ promptSubmitting: true }));
  assert.equal(result.mode, "disabled");
  assert.equal(result.disabled, true);
  assert.equal(result.forceNewTurn, false);
});

test("idle thread without projection evidence starts a new turn", () => {
  const result = routeComposerSubmission(atRest());
  assert.equal(result.mode, "new_turn");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});
