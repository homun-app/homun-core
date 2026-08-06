import { useCallback, useRef, useState } from "react";

interface UseChatStreamLifecycleOptions {
  cancelScheduledStreamingFrame: () => void;
}

export function useChatStreamLifecycle({
  cancelScheduledStreamingFrame,
}: UseChatStreamLifecycleOptions) {
  const [streamHasVisibleText, setStreamHasVisibleText] = useState(false);
  const cancelStreamingRequestRef = useRef<(() => void) | null>(null);
  const cancelledStreamIdsRef = useRef<Set<string>>(new Set());

  const resetStreamingState = useCallback((initialText = "") => {
    setStreamHasVisibleText(Boolean(initialText));
    cancelScheduledStreamingFrame();
  }, [cancelScheduledStreamingFrame]);

  const markStreamHasVisibleText = useCallback(() => {
    setStreamHasVisibleText(true);
  }, []);

  const setActiveStreamingCancel = useCallback((cancel: () => void) => {
    cancelStreamingRequestRef.current = cancel;
  }, []);

  const clearActiveStreamingCancel = useCallback((cancel: () => void) => {
    if (cancelStreamingRequestRef.current === cancel) {
      cancelStreamingRequestRef.current = null;
    }
  }, []);

  const cancelActiveStreaming = useCallback(() => {
    cancelStreamingRequestRef.current?.();
  }, []);

  const hasActiveStreamingCancel = useCallback(
    () => Boolean(cancelStreamingRequestRef.current),
    [],
  );

  const markStreamCancelled = useCallback((requestId: string) => {
    cancelledStreamIdsRef.current.add(requestId);
  }, []);

  const clearStreamCancelled = useCallback((requestId: string) => {
    cancelledStreamIdsRef.current.delete(requestId);
  }, []);

  const isStreamCancelled = useCallback(
    (requestId: string) => cancelledStreamIdsRef.current.has(requestId),
    [],
  );

  return {
    cancelActiveStreaming,
    clearActiveStreamingCancel,
    clearStreamCancelled,
    hasActiveStreamingCancel,
    isStreamCancelled,
    markStreamCancelled,
    markStreamHasVisibleText,
    resetStreamingState,
    setActiveStreamingCancel,
    streamHasVisibleText,
  };
}
