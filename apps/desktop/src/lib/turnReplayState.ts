// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./turnReplayState.mjs";

export type TurnReplayStatus = "running" | "retrying" | "completed" | "failed" | "cancelled";

export interface TurnReplayState {
  turnId: string;
  lastSeq: number;
  status: TurnReplayStatus;
  text: string;
}

export interface SequencedTurnEvent {
  turn_id: string;
  seq: number;
  kind: string;
  payload?: Record<string, unknown>;
}

export const createTurnReplayState = implementation.createTurnReplayState as (
  turnId: string,
  snapshot?: Partial<Pick<TurnReplayState, "lastSeq" | "status" | "text">>,
) => TurnReplayState;

export const applyTurnEvent = implementation.applyTurnEvent as (
  state: TurnReplayState,
  event: SequencedTurnEvent,
) => TurnReplayState;
