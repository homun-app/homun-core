// Node contract tests and the renderer share this dependency-free implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./submissionRouting.mjs";

import type { ComposerMode } from "./composerMode";
import type { KernelProjectionPresenterView } from "./kernelProjectionPresenter";

export interface SubmissionRoutingInput {
  promptSubmitting: boolean;
  turnUiState: KernelProjectionPresenterView["turnUiState"];
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
