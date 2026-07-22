// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./threadAttentionState.mjs";

export type ThreadAttentionStatus =
  | "idle"
  | "working"
  | "completed_unread"
  | "waiting_user"
  | "failed";

export interface ThreadAttentionState {
  selectedThreadId: string;
  byThread: Record<string, ThreadAttentionStatus>;
  terminalEventIds: Record<string, number>;
  seenTerminalEventIds: Record<string, number>;
}

export interface ThreadAttentionSignal {
  threadId: string;
  status: string;
  terminalEventId?: number | null;
}

export interface ThreadAttentionSnapshot extends ThreadAttentionSignal {
  lastSeenTerminalEventId: number;
}

export const createThreadAttentionState = implementation.createThreadAttentionState as (
  selectedThreadId?: string,
) => ThreadAttentionState;

export const applyThreadSignal = implementation.applyThreadSignal as (
  state: ThreadAttentionState,
  signal: ThreadAttentionSignal,
) => ThreadAttentionState;

export const hydrateThreadAttentionState = implementation.hydrateThreadAttentionState as (
  state: ThreadAttentionState,
  rows: ThreadAttentionSnapshot[],
) => ThreadAttentionState;

export const selectThread = implementation.selectThread as (
  state: ThreadAttentionState,
  threadId: string,
) => ThreadAttentionState;
