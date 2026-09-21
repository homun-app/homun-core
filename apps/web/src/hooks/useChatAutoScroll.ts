/**
 * Applies the chat auto-scroll policy to the conversation history container:
 * follow the newest content only while the reader is anchored to the bottom.
 * Follows are instant on purpose — a smooth follow re-triggered by streaming
 * tokens restarts the animation each time and reads as a jump.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { ConversationMessage } from "@/components/builder/conversation-types";
import {
  INITIAL_SCROLL_ANCHOR,
  isPinnedToBottom,
  nextScrollAnchor,
} from "@/lib/chat-autoscroll-policy";

export function useChatAutoScroll(
  ref: RefObject<HTMLDivElement | null>,
  options: {
    activeId: string | null;
    messages: ConversationMessage[];
  },
): void {
  const { activeId, messages } = options;
  const anchor = useRef(INITIAL_SCROLL_ANCHOR);
  const last = messages.at(-1);
  // Length + tail-growth signature: streaming updates text without new rows.
  const signature = `${messages.length}:${last?.text.length ?? 0}`;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onScroll = () => {
      anchor.current = { ...anchor.current, pinned: isPinnedToBottom(element) };
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [ref]);

  useEffect(() => {
    const element = ref.current;
    const result = nextScrollAnchor(anchor.current, { kind: "work" });
    anchor.current = result.state;
    if (element && result.action === "jump") {
      element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    }
  }, [activeId, ref]);

  useEffect(() => {
    const element = ref.current;
    if (!element || signature === "0:0") return;
    const result = nextScrollAnchor(anchor.current, {
      kind: "content",
      pinned: anchor.current.pinned,
      lastIsOwn: last?.who === "you",
    });
    anchor.current = result.state;
    if (result.action === "none") return;
    const frame = requestAnimationFrame(() => {
      element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
    // Signature is derived from messages; messages itself is intentionally not
    // a dependency: same-signature re-renders must not scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, activeId]);
}
