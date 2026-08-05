import { useEffect, useState } from "react";
import { coreBridge } from "./coreBridge";

export function useBackgroundStreams(): {
  backgroundStreamIds: Set<string>;
  streamingThreadId: string | null;
  setStreamingThreadId: (threadId: string | null) => void;
} {
  const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);
  const [backgroundStreamIds, setBackgroundStreamIds] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    const pollActiveStreams = () =>
      void coreBridge
        .activeStreams()
        .then((ids) => setBackgroundStreamIds(new Set(ids)));
    pollActiveStreams();
    const interval = window.setInterval(pollActiveStreams, 4_000);
    return () => window.clearInterval(interval);
  }, []);

  return {
    backgroundStreamIds,
    streamingThreadId,
    setStreamingThreadId,
  };
}
