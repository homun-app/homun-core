import { useCallback, useEffect, useRef, useState } from "react";
import { coreBridge, type RuntimeContextResponse } from "./coreBridge";

interface UseRuntimeContextOptions {
  threadId: string;
  runtimeContextRevision: number;
}

export function useRuntimeContext({
  threadId,
  runtimeContextRevision,
}: UseRuntimeContextOptions) {
  const [runtimeContext, setRuntimeContext] = useState<RuntimeContextResponse | null>(null);
  const [runtimeContextLoading, setRuntimeContextLoading] = useState(true);
  const [runtimeContextError, setRuntimeContextError] = useState(false);
  const runtimeContextRequestRef = useRef(0);

  const refreshRuntimeContext = useCallback(() => {
    const requestId = runtimeContextRequestRef.current + 1;
    runtimeContextRequestRef.current = requestId;
    setRuntimeContext(null);
    setRuntimeContextLoading(true);
    setRuntimeContextError(false);
    return coreBridge.runtimeContext(threadId)
      .then((context) => {
        if (runtimeContextRequestRef.current === requestId) setRuntimeContext(context);
      })
      .catch(() => {
        if (runtimeContextRequestRef.current === requestId) {
          setRuntimeContext(null);
          setRuntimeContextError(true);
        }
      })
      .finally(() => {
        if (runtimeContextRequestRef.current === requestId) setRuntimeContextLoading(false);
      });
  }, [threadId]);

  useEffect(() => {
    void refreshRuntimeContext();
    return () => {
      runtimeContextRequestRef.current += 1;
    };
  }, [refreshRuntimeContext, runtimeContextRevision]);

  return {
    runtimeContext,
    runtimeContextLoading,
    runtimeContextError,
    refreshRuntimeContext,
  };
}
