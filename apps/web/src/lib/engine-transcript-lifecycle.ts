/**
 * Pure policy for durable-transcript reloads (Fonte=motore).
 *
 * Guarantees encoded here and asserted by tests:
 * - A works-inventory refresh (same work, same conversation, no explicit
 *   reload) must NOT trigger a transcript load: reading is never interrupted
 *   and completion polling cannot loop.
 * - An explicit reload of the SAME work keeps the previous content visible
 *   while the fresh transcript is fetched.
 * - Switching work clears cached content first: permissions may differ and
 *   previously visible messages must not leak across works.
 */
import type { ConversationMessage } from "@/components/builder/conversation-types";

export type TranscriptView = {
  activeId: string | null;
  conversationId?: string | undefined;
  reloadSeq: number;
};

export type TranscriptLoadPlan = {
  load: boolean;
  /** Drop previously cached messages before loading (work switch). */
  clearFirst: boolean;
  /** Keep the previous transcript rendered while reloading (explicit reload). */
  keepDuringLoad: boolean;
};

const IDLE_PLAN: TranscriptLoadPlan = { load: false, clearFirst: false, keepDuringLoad: false };

export function planTranscriptLoad(prev: TranscriptView, next: TranscriptView): TranscriptLoadPlan {
  if (next.activeId === null || next.conversationId === undefined) return IDLE_PLAN;
  const switched =
    prev.activeId !== next.activeId || prev.conversationId !== next.conversationId;
  if (switched) return { load: true, clearFirst: true, keepDuringLoad: false };
  if (next.reloadSeq !== prev.reloadSeq)
    return { load: true, clearFirst: false, keepDuringLoad: true };
  return IDLE_PLAN;
}

/**
 * The transcript is authoritative once loaded; the local overlay can be
 * dropped unless a streamed turn is still in flight.
 */
export function canDropOverlay(overlay: ConversationMessage[] | undefined): boolean {
  return !(overlay ?? []).some((message) => message.partial);
}
