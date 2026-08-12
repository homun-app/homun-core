// Pure helpers for the chat turn state machine. No React, no side effects
// beyond Date.now()/Math.random() (used only for ID generation).

/** Turn IDs always take the form `turn_{requestId}`. */
export function createLocalTurnId(requestId) {
  return `turn_${requestId}`;
}

/** Generate a unique request ID with a descriptive prefix. */
export function createRequestId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * State-setter callback: clear the stream status if it belongs to the
 * given request, otherwise preserve the current value. Used in cancel,
 * error, and finally blocks to avoid clobbering a newer turn's status.
 */
export function clearStreamStatusForRequest(current, requestId) {
  return current?.requestId === requestId ? null : current;
}

/** WS turn-event statuses that mark a turn as terminal. */
const TERMINAL_WS_STATUSES = ["completed", "failed", "cancelled"];

export function isTerminalWsTurnStatus(status) {
  return TERMINAL_WS_STATUSES.includes(status);
}

/**
 * Guard for resume/background-turn effects: the turn state machine must
 * be idle (no local submit in flight, no active streaming) before a
 * background or resume stream can take ownership.
 */
export function isTurnIdle(promptSubmitting, streamingAssistantId) {
  return !promptSubmitting && !streamingAssistantId;
}

/**
 * Strip the `turn_` prefix from a background turn ID to recover the
 * underlying request ID used by the streaming bridge.
 */
export function requestIdFromTurnId(turnId) {
  return turnId.replace(/^turn_/, "");
}
