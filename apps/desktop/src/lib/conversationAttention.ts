import type { ApprovelItem, ChatThread, UncertainEffectItem } from "../types";
import type { ThreadAttentionStatus } from "./threadAttentionState";

// Keep the projection executable in Node's lightweight contract tests while
// exposing strict types to the desktop application.
// @ts-expect-error The implementation is intentionally a dependency-free ESM module.
import * as implementation from "./conversationAttention.mjs";

export const attentionRequiredThreadIds = implementation.attentionRequiredThreadIds as (
  threads: ChatThread[],
  approvals: ApprovelItem[],
  uncertainEffects: UncertainEffectItem[],
) => Set<string>;

export const mergeConversationAttention = implementation.mergeConversationAttention as (
  base: Record<string, ThreadAttentionStatus>,
  attentionRequired: Set<string>,
) => Record<string, ThreadAttentionStatus>;

export const requiresAttention = implementation.requiresAttention as (
  status: ThreadAttentionStatus,
) => boolean;
