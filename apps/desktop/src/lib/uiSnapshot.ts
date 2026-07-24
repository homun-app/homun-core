import type { MemoryArtifactView } from "./coreBridge";
import type { ChatMessage } from "../types";
// Re-export the single pure source so TS and node:test share one implementation.
// @ts-expect-error — .mjs sibling, resolved at build by Vite.
import { reconcileChatThreads as reconcileChatThreadsImpl } from "./uiSnapshot.mjs";

function sameJson(left: unknown, right: unknown) {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameChatMessage(left: ChatMessage, right: ChatMessage) {
  return left.id === right.id &&
    left.role === right.role &&
    left.text === right.text &&
    left.timestamp === right.timestamp &&
    left.metadata === right.metadata &&
    left.model === right.model &&
    left.feedback === right.feedback &&
    left.savedMemoryRef === right.savedMemoryRef &&
    left.linkedTaskId === right.linkedTaskId &&
    left.linkedAutomationRef === right.linkedAutomationRef &&
    sameJson(left.metrics, right.metrics) &&
    sameJson(left.attachments, right.attachments) &&
    sameJson(left.eventParts, right.eventParts);
}

function sameMemoryArtifact(left: MemoryArtifactView, right: MemoryArtifactView) {
  return left.reference === right.reference &&
    left.name === right.name &&
    left.title === right.title &&
    left.artifact_type === right.artifact_type &&
    left.source === right.source &&
    left.project_relative_path === right.project_relative_path &&
    left.project_path === right.project_path &&
    left.managed_path === right.managed_path &&
    left.size === right.size &&
    left.updated === right.updated &&
    left.thread === right.thread;
}

export function reconcileChatMessages(
  current: ChatMessage[] | undefined,
  incoming: ChatMessage[],
): ChatMessage[] {
  if (!current || current.length !== incoming.length) return incoming;
  return current.every((item, index) => sameChatMessage(item, incoming[index]))
    ? current
    : incoming;
}

/**
 * Identity-preserving reconciliation for the thread list, the sibling of
 * `reconcileChatMessages`. Returns `current` **by identity** when every thread is
 * unchanged, so the 2.5s operational poll stops re-rendering App/Sidebar/Shell/
 * ChatView on every tick; otherwise a new array that reuses the untouched thread
 * objects. Implementation in `uiSnapshot.mjs` (shared with `node --test`).
 */
export const reconcileChatThreads: <T extends { threadId: string }>(
  current: T[] | undefined,
  incoming: T[],
) => T[] = reconcileChatThreadsImpl;

export function reconcileMemoryArtifacts(
  current: MemoryArtifactView[],
  incoming: MemoryArtifactView[],
): MemoryArtifactView[] {
  if (current.length !== incoming.length) return incoming;
  return current.every((item, index) => sameMemoryArtifact(item, incoming[index]))
    ? current
    : incoming;
}
