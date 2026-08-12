import test from "node:test";
import assert from "node:assert/strict";
import { routeComposerSubmission } from "./submissionRouting.mjs";

function atRest(overrides = {}) {
  return {
    promptSubmitting: false,
    streamingAssistantId: null,
    projectedActiveTurn: null,
    projectedTurnStatus: null,
    projectionLoaded: false,
    threadTailAwaitsHitl: false,
    ...overrides,
  };
}

test("active model work routes composer input as steering", () => {
  const streaming = routeComposerSubmission(
    atRest({ streamingAssistantId: "assistant-1" }),
  );
  assert.equal(streaming.mode, "steering");
  assert.equal(streaming.forceNewTurn, false);
  assert.equal(streaming.routesToSteering, true);

  const projected = routeComposerSubmission(
    atRest({
      projectionLoaded: true,
      projectedActiveTurn: { turn_id: "turn-1", status: "running" },
    }),
  );
  assert.equal(projected.routesToSteering, true);
  assert.equal(projected.forceNewTurn, false);
});

test("terminal turn at rest starts a new turn instead of steering", () => {
  const result = routeComposerSubmission(
    atRest({ projectionLoaded: true, projectedTurnStatus: "completed" }),
  );
  assert.equal(result.mode, "new_turn");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("waiting user reply never becomes mid-turn steering", () => {
  const result = routeComposerSubmission(
    atRest({
      projectionLoaded: true,
      projectedActiveTurn: { turn_id: "turn-1", status: "waiting_user_approval" },
      projectedTurnStatus: "waiting_user_approval",
    }),
  );
  assert.equal(result.mode, "waiting_user_reply");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("kernel composer_mode routes active turns without local status inference", () => {
  const result = routeComposerSubmission(
    atRest({
      projectionLoaded: true,
      projectedActiveTurn: { turn_id: "turn-1", status: "running" },
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
      projectionLoaded: true,
      projectedActiveTurn: { turn_id: "turn-1", status: "waiting_user" },
      composerMode: "reply_to_user_wait",
    }),
  );
  assert.equal(result.mode, "waiting_user_reply");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("open HITL wait at the chat tail forces a new turn even while streaming", () => {
  const result = routeComposerSubmission(
    atRest({ streamingAssistantId: "assistant-1", threadTailAwaitsHitl: true }),
  );
  assert.equal(result.mode, "waiting_user_reply");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("loaded projection quarantines legacy HITL marker routing", () => {
  const result = routeComposerSubmission(
    atRest({
      projectionLoaded: true,
      projectedTurnStatus: "completed",
      threadTailAwaitsHitl: true,
    }),
  );
  assert.equal(result.mode, "new_turn");
  assert.equal(result.forceNewTurn, true);
  assert.equal(result.routesToSteering, false);
});

test("explicit HITL Free resolution overrides the steering gate on active work", () => {
  const result = routeComposerSubmission(
    atRest({ streamingAssistantId: "assistant-1", explicitForceNewTurn: true }),
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
