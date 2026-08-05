import { useCallback, useEffect, useMemo, useState } from "react";
import {
  coreBridge,
  type CoreComputerSessionSnapshot,
} from "../lib/coreBridge";
import {
  createLoadingComputerSession,
  createUnavailableComputerSession,
  mapCoreComputerSession,
} from "../lib/localComputerViewModel";
import {
  describeBridgeError,
  isUserVisibleComputerEvent,
} from "../lib/chatViewMessages";
import type {
  ComputerSession,
  ComputerSurfaceKind,
} from "../types";

interface UseChatComputerSessionOptions {
  computerSessionId: string;
  unavailableMessage: string;
}

export function useChatComputerSession({
  computerSessionId,
  unavailableMessage,
}: UseChatComputerSessionOptions) {
  const [computerSession, setComputerSession] = useState<ComputerSession>(() =>
    createLoadingComputerSession(computerSessionId),
  );
  const [activeSurface, setActiveSurface] = useState<ComputerSurfaceKind>(
    computerSession.activeSurface,
  );
  const [computerControlBusy, setComputerControlBusy] = useState(false);
  const [computerControlError, setComputerControlError] = useState<string | null>(null);
  const [computerLiveStatus, setComputerLiveStatus] = useState<{
    active: boolean;
    activity: string | null;
  }>({ active: false, activity: null });
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);

  const visibleComputerSession = useMemo(
    () => ({
      ...computerSession,
      timeline: computerSession.timeline.filter(isUserVisibleComputerEvent),
    }),
    [computerSession],
  );

  const runComputerControl = useCallback(
    async (action: (sessionId: string) => Promise<CoreComputerSessionSnapshot>) => {
      setComputerControlBusy(true);
      setComputerControlError(null);
      try {
        const snapshot = await action(computerSessionId);
        setComputerSession(mapCoreComputerSession(snapshot));
      } catch (error) {
        setComputerControlError(describeBridgeError(error));
      } finally {
        setComputerControlBusy(false);
      }
    },
    [computerSessionId],
  );

  const applyComputerSessionSnapshot = useCallback((snapshot: CoreComputerSessionSnapshot) => {
    setComputerSession(mapCoreComputerSession(snapshot));
  }, []);

  const pauseComputer = useCallback(() => {
    void runComputerControl(coreBridge.pauseLocalComputerSession);
  }, [runComputerControl]);

  const resumeComputer = useCallback(() => {
    void runComputerControl(coreBridge.resumeLocalComputerSession);
  }, [runComputerControl]);

  const takeoverComputer = useCallback(() => {
    void runComputerControl(coreBridge.requestLocalComputerTakeover);
  }, [runComputerControl]);

  useEffect(() => {
    let cancelled = false;
    setComputerSession(createLoadingComputerSession(computerSessionId));
    setPreviewDataUrl(null);

    async function loadLocalComputerSession() {
      try {
        const snapshot = await coreBridge.localComputerSession(computerSessionId);
        if (cancelled) return;
        setComputerSession(
          snapshot
            ? mapCoreComputerSession(snapshot)
            : createUnavailableComputerSession(
                computerSessionId,
                unavailableMessage,
              ),
        );
      } catch (error) {
        if (cancelled) return;
        setComputerSession(
          createUnavailableComputerSession(
            computerSessionId,
            describeBridgeError(error),
          ),
        );
      }
    }

    void loadLocalComputerSession();
    const interval = window.setInterval(loadLocalComputerSession, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [computerSessionId, unavailableMessage]);

  useEffect(() => {
    let cancelled = false;
    const artifactId = computerSession.previewArtifactId;
    if (!artifactId || computerSession.source !== "core") {
      setPreviewDataUrl(null);
      return () => {
        cancelled = true;
      };
    }
    const previewArtifactId = artifactId;

    async function loadPreview() {
      try {
        const preview = await coreBridge.localComputerArtifactPreview(
          computerSession.id,
          previewArtifactId,
        );
        if (!cancelled) {
          setPreviewDataUrl(preview?.data_url ?? null);
        }
      } catch {
        if (!cancelled) {
          setPreviewDataUrl(null);
        }
      }
    }

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [computerSession.id, computerSession.previewArtifactId, computerSession.source]);

  useEffect(() => {
    if (
      !computerSession.surfaces.some((surface) => surface.id === activeSurface)
    ) {
      setActiveSurface(computerSession.activeSurface);
    }
  }, [activeSurface, computerSession.activeSurface, computerSession.surfaces]);

  return {
    activeSurface,
    applyComputerSessionSnapshot,
    computerControlBusy,
    computerControlError,
    computerLiveStatus,
    computerSession,
    pauseComputer,
    previewDataUrl,
    resumeComputer,
    setActiveSurface,
    setComputerLiveStatus,
    takeoverComputer,
    visibleComputerSession,
  };
}
