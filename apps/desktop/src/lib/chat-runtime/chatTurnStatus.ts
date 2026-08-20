// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./chatTurnStatus.mjs";

export interface ChatTurnState {
  phase: string;
  detail?: string;
  elapsedSeconds: number;
  attempt: number;
  activityCount: number;
}

export interface ChatTurnStatusInput {
  turnUiState: {
    hasActiveTurn: boolean;
    turnAwaitingUser: boolean;
  };
  streamStatus?: {
    title?: string | null;
    detail?: string | null;
  } | null;
  labels: {
    waitingForYou: string;
    stillWorking: string;
  };
  elapsedSeconds: number;
  attempt?: number | null;
  activityCount: number;
  activeTurnBlockedReason?: string | null;
}

export const deriveChatTurnStatus: (input: ChatTurnStatusInput) => ChatTurnState | null =
  implementation.deriveChatTurnStatus as (input: ChatTurnStatusInput) => ChatTurnState | null;
