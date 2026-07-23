// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./turnStreamRecovery.mjs";
import type { SequencedTurnEvent, TurnReplayState } from "./turnReplayState";

export interface TurnStreamConnection {
  turnId: string;
  since: number;
  onEvent: (event: SequencedTurnEvent) => void;
}

export interface TurnStreamRecoveryOptions {
  turnId: string;
  connect: (connection: TurnStreamConnection) => Promise<void>;
  getStatus: (turnId: string) => Promise<{ status: string }>;
  onEvent?: (event: SequencedTurnEvent, state: TurnReplayState) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  maxReconnects?: number;
  reconnectDelays?: number[];
  initialState?: TurnReplayState;
}

export const TurnStreamRecoveryError = implementation.TurnStreamRecoveryError as {
  new(message: string, code?: string, cause?: unknown): Error & { code: string };
};

export const recoverTurnStream = implementation.recoverTurnStream as (
  options: TurnStreamRecoveryOptions,
) => Promise<TurnReplayState>;
