import { useEffect, useRef } from "react";

export function useOperationalReadModelPoller({
  activeThreadId,
  refreshRuntimeReadModels,
  refreshChatReadModels,
}: {
  activeThreadId: string;
  refreshRuntimeReadModels: () => Promise<void>;
  refreshChatReadModels: (preferredThreadId?: string) => Promise<void>;
}) {
  const refreshRuntimeReadModelsRef = useRef(refreshRuntimeReadModels);
  const refreshChatReadModelsRef = useRef(refreshChatReadModels);

  useEffect(() => {
    refreshRuntimeReadModelsRef.current = refreshRuntimeReadModels;
    refreshChatReadModelsRef.current = refreshChatReadModels;
  }, [refreshRuntimeReadModels, refreshChatReadModels]);

  useEffect(() => {
    let cancelled = false;

    async function refreshOperationalReadModels() {
      if (!activeThreadId) return;
      try {
        await refreshRuntimeReadModelsRef.current();
        if (!cancelled) {
          await refreshChatReadModelsRef.current(activeThreadId);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn("operational_read_models_poll unavailable", error);
        }
      }
    }

    const interval = window.setInterval(refreshOperationalReadModels, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeThreadId]);
}
