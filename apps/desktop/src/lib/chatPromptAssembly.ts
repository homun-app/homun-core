// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./chatPromptAssembly.mjs";

export interface ComposerPromptDecoratorsInput {
  forcedSkillsId?: string;
  contextText?: string;
}

export interface ComposerPromptDecorators {
  skillPrefix: string;
  contextPrefix: string;
  augmented: boolean;
}

export interface PromptWithReplyContextInput {
  skillPrefix: string;
  contextPrefix: string;
  prompt: string;
  replyRoleLabel?: string;
  replyPreview?: string;
}

export interface AssistantFollowUpPromptInput {
  instruction: string;
  previousResponse: string;
}

export const CONTINUE_RESPONSE_PROMPT =
  implementation.CONTINUE_RESPONSE_PROMPT as string;

export const buildComposerPromptDecorators =
  implementation.buildComposerPromptDecorators as (
    input?: ComposerPromptDecoratorsInput,
  ) => ComposerPromptDecorators;

export const buildSteeringPrompt = implementation.buildSteeringPrompt as (
  input: PromptWithReplyContextInput,
) => string;

export const buildReplyContextPrompt = implementation.buildReplyContextPrompt as (
  input: Required<PromptWithReplyContextInput>,
) => string;

export const buildAssistantFollowUpPrompt =
  implementation.buildAssistantFollowUpPrompt as (
    input: AssistantFollowUpPromptInput,
  ) => string;
