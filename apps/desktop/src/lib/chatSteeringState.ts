import type { TurnSteeringRecord, TurnSteeringStatus } from "./chatApi";

// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./chatSteeringState.mjs";

export interface SteeringQueueState {
  rows: TurnSteeringRecord[];
  revisions: Record<number, number>;
}

export const createSteeringQueueState = implementation.createSteeringQueueState as (
  rows?: TurnSteeringRecord[],
) => SteeringQueueState;

export const reconcileSteering = implementation.reconcileSteering as (
  state: SteeringQueueState,
  rows: TurnSteeringRecord[],
) => SteeringQueueState;

export const applySteeringChange = implementation.applySteeringChange as (
  state: SteeringQueueState,
  change: TurnSteeringRecord,
) => SteeringQueueState;

type SteeringStatusRecord = { status: TurnSteeringStatus };

export const canEdit = implementation.canEdit as (row: SteeringStatusRecord) => boolean;
export const canDelete = implementation.canDelete as (row: SteeringStatusRecord) => boolean;
export const canSendNow = implementation.canSendNow as (row: SteeringStatusRecord) => boolean;
