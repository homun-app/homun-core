import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTurnLifecycle,
  TERMINAL_TURN_STATUSES,
} from "./lifecycle.mjs";

test("terminal projected turn at rest clears active work", () => {
  const result = deriveTurnLifecycle({
    promptSubmitting: false,
    streamingAssistantId: null,
    projectedActiveTurn: null,
    projectedTurnStatus: "completed",
    projectionLoaded: true,
    threadTailAwaitsHitl: false,
  });

  assert.equal(result.terminalTurnAtRest, true);
  assert.equal(result.hasActiveTurn, false);
  assert.equal(result.workInProgress, false);
  assert.equal(result.turnAwaitingUser, false);
  assert.equal(result.canStop, false);
});

test("waiting user is active but not model work", () => {
  const result = deriveTurnLifecycle({
    promptSubmitting: false,
    streamingAssistantId: null,
    projectedActiveTurn: {
      turn_id: "turn_waiting",
      status: "waiting_user_approval",
      updated_at: 10,
      attempt: 1,
      max_attempts: 1,
      last_event_seq: 4,
      not_before: null,
      blocked_reason: null,
    },
    projectedTurnStatus: "waiting_user_approval",
    projectionLoaded: true,
    threadTailAwaitsHitl: false,
  });

  assert.equal(result.hasActiveTurn, true);
  assert.equal(result.workInProgress, false);
  assert.equal(result.turnAwaitingUser, true);
  assert.equal(result.canStop, false);
});

test("streaming local state is work even before projection arrives", () => {
  const result = deriveTurnLifecycle({
    promptSubmitting: true,
    streamingAssistantId: null,
    projectedActiveTurn: null,
    projectedTurnStatus: null,
    projectionLoaded: false,
    threadTailAwaitsHitl: false,
  });

  assert.equal(result.hasActiveTurn, true);
  assert.equal(result.workInProgress, true);
  assert.equal(result.terminalTurnAtRest, false);
  assert.equal(result.canStop, true);
});

test("terminal status set is explicit", () => {
  assert.deepEqual([...TERMINAL_TURN_STATUSES].sort(), [
    "cancelled",
    "completed",
    "expired",
    "failed",
  ]);
});
