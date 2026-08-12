// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./turnStateMachine.mjs";

import type { ChatStreamStatus } from "../../components/AssistantThinkingState";

/** Turn IDs always take the form `turn_{requestId}`. */
export const createLocalTurnId = implementation.createLocalTurnId as (
  requestId: string,
) => string;

/** Generate a unique request ID with a descriptive prefix. */
export const createRequestId = implementation.createRequestId as (
  prefix: string,
) => string;

/**
 * State-setter callback: clear the stream status if it belongs to the
 * given request, otherwise preserve the current value.
 */
export const clearStreamStatusForRequest = implementation.clearStreamStatusForRequest as (
  current: ChatStreamStatus | null,
  requestId: string,
) => ChatStreamStatus | null;

/** WS turn-event statuses that mark a turn as terminal. */
export const isTerminalWsTurnStatus = implementation.isTerminalWsTurnStatus as (
  status: string,
) => boolean;

/**
 * Guard for resume/background-turn effects: the turn state machine must
 * be idle before a background or resume stream can take ownership.
 */
export const isTurnIdle = implementation.isTurnIdle as (
  promptSubmitting: boolean,
  streamingAssistantId: string | null,
) => boolean;

/** Strip the `turn_` prefix from a background turn ID. */
export const requestIdFromTurnId = implementation.requestIdFromTurnId as (
  turnId: string,
) => string;
