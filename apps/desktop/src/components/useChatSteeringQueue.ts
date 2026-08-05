import { useCallback, useEffect, useState } from "react";
import {
  deleteSteering,
  fetchThreadSteering,
  sendSteeringNow,
  SteeringConflictError,
  updateSteering,
  type TurnSteeringRecord,
} from "../lib/chatApi";
import {
  applySteeringChange,
  createSteeringQueueState,
  reconcileSteering,
} from "../lib/chatSteeringState";
import { steeringPromptWithEdit } from "../lib/chatSteeringPrompt";
import { describeBridgeError } from "../lib/chatViewMessages";
import { wsSubscription } from "../lib/wsSubscription";

interface UseChatSteeringQueueOptions {
  isMountedRef: { current: boolean };
  onThreadChanged: () => void | Promise<void>;
  setPromptError: (message: string | null) => void;
  threadId: string;
}

export function useChatSteeringQueue({
  isMountedRef,
  onThreadChanged,
  setPromptError,
  threadId,
}: UseChatSteeringQueueOptions) {
  const [pendingSteering, setPendingSteering] = useState(() => createSteeringQueueState());

  const applyPendingSteeringChange = useCallback((record: TurnSteeringRecord) => {
    setPendingSteering((current) => applySteeringChange(current, record));
  }, []);

  const refreshPendingSteering = useCallback(async () => {
    const rows = await fetchThreadSteering(threadId);
    if (!isMountedRef.current) return;
    setPendingSteering((current) => reconcileSteering(current, rows));
  }, [isMountedRef, threadId]);

  useEffect(() => {
    setPendingSteering(createSteeringQueueState());
    void refreshPendingSteering().catch(() => {
      /* Queue remains empty until the endpoint is available or an event retries hydration. */
    });
  }, [refreshPendingSteering]);

  useEffect(() => {
    const unsubscribe = wsSubscription.subscribe((message) => {
      const event = message.type === "app.event"
        ? message.event as Record<string, unknown> | undefined
        : message;
      if (event?.type !== "thread.steering_changed") return;
      if (event.thread_id !== threadId) return;
      void refreshPendingSteering().catch(() => undefined);
    });
    return unsubscribe;
  }, [refreshPendingSteering, threadId]);

  const editPendingSteering = useCallback(
    async (
      row: TurnSteeringRecord,
      visiblePrompt: string,
      expectedRevision: number,
    ) => {
      try {
        const updated = await updateSteering(row.steering_id, {
          expected_revision: expectedRevision,
          prompt: steeringPromptWithEdit(row, visiblePrompt),
          visible_prompt: visiblePrompt,
          images: row.images,
          attachments: row.attachments,
          mode: row.mode,
          model: row.model,
        });
        applyPendingSteeringChange(updated);
        setPromptError(null);
      } catch (error) {
        if (error instanceof SteeringConflictError) {
          applyPendingSteeringChange(error.steering);
        }
        setPromptError(describeBridgeError(error));
        throw error;
      }
    },
    [applyPendingSteeringChange, setPromptError],
  );

  const deletePendingSteering = useCallback(
    async (row: TurnSteeringRecord, expectedRevision: number) => {
      try {
        const deleted = await deleteSteering(row.steering_id, expectedRevision);
        applyPendingSteeringChange(deleted);
        setPromptError(null);
      } catch (error) {
        if (error instanceof SteeringConflictError) {
          applyPendingSteeringChange(error.steering);
        }
        setPromptError(describeBridgeError(error));
        throw error;
      }
    },
    [applyPendingSteeringChange, setPromptError],
  );

  const sendPendingSteeringNow = useCallback(
    async (row: TurnSteeringRecord, expectedRevision: number) => {
      try {
        await sendSteeringNow(row.steering_id, expectedRevision);
        await refreshPendingSteering();
        setPromptError(null);
        await onThreadChanged();
      } catch (error) {
        if (error instanceof SteeringConflictError) {
          applyPendingSteeringChange(error.steering);
        }
        setPromptError(describeBridgeError(error));
        throw error;
      }
    },
    [applyPendingSteeringChange, onThreadChanged, refreshPendingSteering, setPromptError],
  );

  return {
    pendingSteering,
    applyPendingSteeringChange,
    deletePendingSteering,
    editPendingSteering,
    refreshPendingSteering,
    sendPendingSteeringNow,
  };
}
