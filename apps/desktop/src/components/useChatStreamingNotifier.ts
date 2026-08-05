import { useCallback, useEffect, useRef } from "react";

export function useChatStreamingNotifier(
  onStreamingChange?: (busy: boolean) => void,
) {
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const onStreamingChangeRef = useRef(onStreamingChange);
  onStreamingChangeRef.current = onStreamingChange;
  const notifyStreaming = useCallback((busy: boolean) => {
    if (!isMountedRef.current && busy) return;
    onStreamingChangeRef.current?.(busy);
  }, []);

  useEffect(() => {
    return () => {
      notifyStreaming(false);
    };
  }, [notifyStreaming]);

  return {
    isMountedRef,
    notifyStreaming,
  };
}
