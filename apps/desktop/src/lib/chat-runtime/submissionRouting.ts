// Node contract tests and the renderer share this dependency-free implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./submissionRouting.mjs";

import type { KernelProjectionPresenterView } from "./kernelProjectionPresenter";

export type ComposerMode = "new_turn" | "steering" | "waiting_user_reply" | "disabled";

export interface SubmissionRoutingInput {
  promptSubmitting: boolean;
  turnUiState: KernelProjectionPresenterView["turnUiState"];
  composerMode: string;
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
