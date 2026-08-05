import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types";

interface UseChatConversationScrollOptions {
  threadId: string;
  threadMessages: ChatMessage[];
  streamingAssistantId: string | null;
}

export function useChatConversationScroll({
  threadId,
  threadMessages,
  streamingAssistantId,
}: UseChatConversationScrollOptions) {
  const conversationRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const streamingUserPinnedRef = useRef(false);
  const streamingFrameRef = useRef<number | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const scrollConversationToBottom = useCallback((behavior: ScrollBehavior) => {
    const node = conversationRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  }, []);

  const conversationBottomDistance = useCallback(() => {
    const node = conversationRef.current;
    if (!node) return 0;
    return node.scrollHeight - node.scrollTop - node.clientHeight;
  }, []);

  const shouldAutoScrollConversation = useCallback(
    () => streamingUserPinnedRef.current || shouldStickToBottomRef.current,
    [],
  );

  const scrollConversationToBottomIfPinned = useCallback(
    (behavior: ScrollBehavior) => {
      if (!shouldAutoScrollConversation()) return;
      scrollConversationToBottom(behavior);
    },
    [scrollConversationToBottom, shouldAutoScrollConversation],
  );

  const cancelScheduledStreamingFrame = useCallback(() => {
    if (streamingFrameRef.current !== null) {
      window.cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
  }, []);

  const afterStreamingFramePaint = useCallback(() => {
    // Always instant: CSS "auto" can resolve to smooth and fight frame-by-frame streaming.
    scrollConversationToBottomIfPinned("instant");
  }, [scrollConversationToBottomIfPinned]);

  const markStreamingPinnedFromCurrentPosition = useCallback(() => {
    streamingUserPinnedRef.current = conversationBottomDistance() < 220;
  }, [conversationBottomDistance]);

  const clearStreamingPin = useCallback(() => {
    streamingUserPinnedRef.current = false;
  }, []);

  const forceStreamingPin = useCallback(() => {
    streamingUserPinnedRef.current = true;
  }, []);

  const requestStreamingFrame = useCallback(
    (callback: () => void) => {
      if (streamingFrameRef.current !== null) return;
      streamingFrameRef.current = window.requestAnimationFrame(callback);
    },
    [],
  );

  const clearStreamingFrame = useCallback(() => {
    streamingFrameRef.current = null;
  }, []);

  const jumpToBottom = useCallback(() => {
    shouldStickToBottomRef.current = true;
    scrollConversationToBottom("smooth");
  }, [scrollConversationToBottom]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    streamingUserPinnedRef.current = false;
    window.setTimeout(() => scrollConversationToBottom("instant"), 0);
  }, [scrollConversationToBottom, threadId]);

  useEffect(() => {
    const node = conversationRef.current;
    if (!node) return undefined;
    const scrollNode = node;

    function updateStickToBottom() {
      const bottomDistance = conversationBottomDistance();
      shouldStickToBottomRef.current = bottomDistance < 140;
      if (streamingUserPinnedRef.current && bottomDistance > 160) {
        streamingUserPinnedRef.current = false;
      }
      setShowJumpToBottom(bottomDistance > 260);
    }

    updateStickToBottom();
    scrollNode.addEventListener("scroll", updateStickToBottom, { passive: true });
    return () => scrollNode.removeEventListener("scroll", updateStickToBottom);
  }, [conversationBottomDistance]);

  useEffect(() => {
    const handleResize = () => scrollConversationToBottomIfPinned("instant");
    const behavior: ScrollBehavior = streamingAssistantId ? "instant" : "smooth";

    const frame = window.requestAnimationFrame(() =>
      scrollConversationToBottomIfPinned(behavior),
    );
    const timeout = streamingAssistantId
      ? undefined
      : window.setTimeout(() => scrollConversationToBottomIfPinned("smooth"), 120);
    window.addEventListener("resize", handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
      window.removeEventListener("resize", handleResize);
    };
  }, [scrollConversationToBottomIfPinned, streamingAssistantId, threadMessages]);

  return {
    afterStreamingFramePaint,
    cancelScheduledStreamingFrame,
    clearStreamingFrame,
    clearStreamingPin,
    conversationRef,
    forceStreamingPin,
    jumpToBottom,
    markStreamingPinnedFromCurrentPosition,
    requestStreamingFrame,
    scrollConversationToBottomIfPinned,
    showJumpToBottom,
  };
}
