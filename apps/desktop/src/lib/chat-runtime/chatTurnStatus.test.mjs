import assert from "node:assert/strict";
import test from "node:test";

import { deriveChatTurnStatus } from "./chatTurnStatus.mjs";

const labels = {
  waitingForYou: "Waiting for you",
  stillWorking: "Still working",
};

const baseTurnUiState = {
  hasActiveTurn: true,
  turnAwaitingUser: false,
};

test("active turn status is absent when the kernel presenter has no active turn", () => {
  const status = deriveChatTurnStatus({
    turnUiState: { ...baseTurnUiState, hasActiveTurn: false },
    labels,
    elapsedSeconds: 12,
    attempt: 2,
    activityCount: 3,
  });

  assert.equal(status, null);
});

test("waiting user state is projected from kernel liveness instead of stream title", () => {
  const status = deriveChatTurnStatus({
    turnUiState: { ...baseTurnUiState, turnAwaitingUser: true },
    streamStatus: {
      title: "Assistant is thinking",
      detail: "approval needed",
    },
    labels,
    elapsedSeconds: 65,
    attempt: 1,
    activityCount: 4,
    activeTurnBlockedReason: "parked_waiting_for_model",
  });

  assert.deepEqual(status, {
    phase: "Waiting for you",
    detail: "approval needed",
    elapsedSeconds: 65,
    attempt: 1,
    activityCount: 4,
  });
});

test("active model work uses stream title and blocked reason fallback", () => {
  const status = deriveChatTurnStatus({
    turnUiState: baseTurnUiState,
    streamStatus: {
      title: null,
      detail: null,
    },
    labels,
    elapsedSeconds: 8,
    attempt: null,
    activityCount: 0,
    activeTurnBlockedReason: "waiting_for_provider",
  });

  assert.deepEqual(status, {
    phase: "Still working",
    detail: "waiting_for_provider",
    elapsedSeconds: 8,
    attempt: 1,
    activityCount: 0,
  });
});
