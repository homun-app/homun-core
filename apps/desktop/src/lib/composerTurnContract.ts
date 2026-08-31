// Node contract tests and the renderer share this dependency-free implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./composerTurnContract.mjs";
import type { RuntimeContextResponse } from "./coreBridge";

interface AssistantModelEvidence {
  role: string;
  model?: string | null;
}

export const selectedModelAfterSubmission = implementation.selectedModelAfterSubmission as (
  selectedModel: string | null,
  accepted: boolean,
) => string | null;

export const effectiveModelFromGateway = implementation.effectiveModelFromGateway as (
  value: string | null | undefined,
) => string | null;

export const modelLabelFromSelection = implementation.modelLabelFromSelection as (
  value: string | null | undefined,
) => string | null;

export const autoModelResolutionLabel = implementation.autoModelResolutionLabel as (
  runtimeContext: RuntimeContextResponse | null | undefined,
  autoLabel: string | null | undefined,
) => string;

export const composerModelButtonLabel = implementation.composerModelButtonLabel as (
  effectiveModelLabel: string | null | undefined,
  selectedNextModel: string | null | undefined,
  unavailableLabel: string | null | undefined,
  autoLabel?: string | null | undefined,
  runtimeContext?: RuntimeContextResponse | null | undefined,
) => string;

export const latestAssistantEffectiveModel = implementation.latestAssistantEffectiveModel as (
  messages: AssistantModelEvidence[],
) => string | null;
