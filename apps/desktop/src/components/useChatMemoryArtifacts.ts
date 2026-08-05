import { useCallback, useEffect, useState } from "react";
import { coreBridge, type MemoryArtifactView } from "../lib/coreBridge";
import { reconcileMemoryArtifacts } from "../lib/uiSnapshot";
import type { ChatMessage } from "../types";

export function useChatMemoryArtifacts(threadId: string, messages: ChatMessage[]) {
  const [memoryArtifacts, setMemoryArtifacts] = useState<MemoryArtifactView[]>([]);
  const [memoryArtifactsLoaded, setMemoryArtifactsLoaded] = useState(false);
  const [memoryArtifactsLoadError, setMemoryArtifactsLoadError] = useState(false);
  const [memoryArtifactsReloadNonce, setMemoryArtifactsReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void coreBridge
      .memoryArtifacts(threadId)
      .then((items) => {
        if (!cancelled) {
          setMemoryArtifacts((current) => reconcileMemoryArtifacts(current, items));
          setMemoryArtifactsLoadError(false);
          setMemoryArtifactsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMemoryArtifactsLoadError(true);
          setMemoryArtifactsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [memoryArtifactsReloadNonce, messages, threadId]);

  const retryMemoryArtifacts = useCallback(() => {
    setMemoryArtifactsReloadNonce((value) => value + 1);
  }, []);

  return {
    memoryArtifacts,
    memoryArtifactsLoaded,
    memoryArtifactsLoadError,
    retryMemoryArtifacts,
  };
}
