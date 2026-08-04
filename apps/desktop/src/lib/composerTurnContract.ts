// Node contract tests and the renderer share this dependency-free implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./composerTurnContract.mjs";

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

export const latestAssistantEffectiveModel = implementation.latestAssistantEffectiveModel as (
  messages: AssistantModelEvidence[],
) => string | null;
