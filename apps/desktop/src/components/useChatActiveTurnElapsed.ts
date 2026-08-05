import { useEffect, useState } from "react";

interface UseChatActiveTurnElapsedOptions {
  activeTurnKey: string | null;
  hasActiveTurn: boolean;
  projectedUpdatedAt?: number | null;
}

export function useChatActiveTurnElapsed({
  activeTurnKey,
  hasActiveTurn,
  projectedUpdatedAt,
}: UseChatActiveTurnElapsedOptions) {
  const [activeTurnElapsedSeconds, setActiveTurnElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!hasActiveTurn) {
      setActiveTurnElapsedSeconds(0);
      return;
    }
    const startedAt = projectedUpdatedAt && projectedUpdatedAt > 0
      ? Math.min(Date.now(), projectedUpdatedAt * 1000)
      : Date.now();
    const updateElapsed = () => {
      setActiveTurnElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [activeTurnKey, hasActiveTurn, projectedUpdatedAt]);

  return activeTurnElapsedSeconds;
}
