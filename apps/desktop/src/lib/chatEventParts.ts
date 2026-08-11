import type { CoreChatStreamEvent } from "./coreBridge";
import type { TurnReplayStatus } from "./turnReplayState";
import type { ChatEventPart, ChatMessage } from "../types";

// Node contract tests and the renderer share this dependency-free implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./chatEventParts.mjs";

export const chatEventPartFromStream = implementation.chatEventPartFromStream as (
  event: CoreChatStreamEvent,
) => ChatEventPart | null;

export const normalizeChatEventParts = implementation.normalizeChatEventParts as (
  parts: unknown[] | undefined,
) => ChatEventPart[];

export const shouldDropStructuredMarkerDelta = implementation.shouldDropStructuredMarkerDelta as (
  delta: string,
) => boolean;

// UI-local until the durable activity projection lands in the generated client type.
// Missing backend fields stay absent; the view never invents retry/backoff metadata.
export interface ActiveTurnProjection {
  turn_id: string;
  last_event_seq: number;
  status: string;
  attempt: number;
  max_attempts: number;
  not_before: number | null;
  blocked_reason: string | null;
  updated_at: number;
}

export const replayStatusFromProjection = implementation.replayStatusFromProjection as (
  status: string,
) => TurnReplayStatus;

/** Legacy marker fallback only; kernel projection owns current-turn liveness once loaded. */
export const threadTailAwaitsUser = implementation.threadTailAwaitsUser as (
  messages: ChatMessage[],
) => boolean;
