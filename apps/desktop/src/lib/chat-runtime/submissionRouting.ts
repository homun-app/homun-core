// Node contract tests and the renderer share this dependency-free implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./submissionRouting.mjs";

import type { ComposerMode } from "./composerMode";
import type { ActiveTurnProjectionLike } from "./lifecycle";

export interface SubmissionRoutingInput {
  promptSubmitting: boolean;
  streamingAssistantId: string | null;
  projectedActiveTurn: ActiveTurnProjectionLike | null;
  projectedTurnStatus: string | null;
  projectionLoaded: boolean;
  composerMode?: string | null;
  /** HITL Free resolutions (Choice/Clarify) must never become mid-turn steering. */
  explicitForceNewTurn?: boolean;
}

export interface SubmissionRoutingView {
  mode: ComposerMode;
  disabled: boolean;
  workInProgress: boolean;
  forceNewTurn: boolean;
  routesToSteering: boolean;
}

export const routeComposerSubmission = implementation.routeComposerSubmission as (
  input: SubmissionRoutingInput,
) => SubmissionRoutingView;
