import { useCallback, useEffect, useState } from "react";
import type {
  CoreTaskQueueSnapshot,
  CoreUncertainEffectOutcome,
} from "./coreBridge";
import { coreBridge } from "./coreBridge";
import {
  mapCoreApprovel,
  mapCoreTask,
  mapCoreUncertainEffect,
} from "./appCoreMappers";
import {
  projectEffectResolutionError,
  projectTaskQueueSnapshot,
} from "./taskQueueProjection";
import type {
  ApprovelItem,
  TaskItem,
  UncertainEffectItem,
} from "../types";

export function useTaskQueueController({
  activeThreadId,
  refreshChatReadModels,
}: {
  activeThreadId: string;
  refreshChatReadModels: (preferredThreadId?: string) => Promise<void>;
}) {
  const [taskItems, setTaskItems] = useState<TaskItem[]>([]);
  const [approvalItems, setApprovelItems] = useState<ApprovelItem[]>([]);
  const [uncertainEffectItems, setUncertainEffectItems] = useState<
    UncertainEffectItem[]
  >([]);
  const [approvalBusyId, setApprovelBusyId] = useState<string | null>(null);
  const [effectResolutionBusyId, setEffectResolutionBusyId] = useState<string | null>(
    null,
  );
  const [effectResolutionError, setEffectResolutionError] = useState<{
    receiptId: string;
    message: string;
  } | null>(null);

  const applyTaskQueueSnapshot = useCallback((snapshot: CoreTaskQueueSnapshot) => {
    const projection = projectTaskQueueSnapshot({
      snapshot,
      mapTask: mapCoreTask,
      mapApproval: mapCoreApprovel,
      mapUncertainEffect: mapCoreUncertainEffect,
    });
    setTaskItems(projection.taskItems);
    setApprovelItems(projection.approvelItems);
    setUncertainEffectItems(projection.uncertainEffectItems);
    setEffectResolutionError((current) =>
      projectEffectResolutionError(current, projection.uncertainEffectItems),
    );
  }, []);

  const loadTaskQueue = useCallback(async () => {
    try {
      applyTaskQueueSnapshot(await coreBridge.taskQueue());
    } catch (error) {
      console.warn("task_queue_snapshot unavailable", error);
    }
  }, [applyTaskQueueSnapshot]);

  useEffect(() => {
    void loadTaskQueue();
    const interval = window.setInterval(() => {
      void loadTaskQueue();
    }, 4_000);
    return () => window.clearInterval(interval);
  }, [loadTaskQueue]);

  const refreshRuntimeReadModels = useCallback(async () => {
    await loadTaskQueue();
  }, [loadTaskQueue]);

  const handleApproveApprovel = useCallback(
    async (
      approvalId: string,
      options?: {
        scope?: "once" | "always";
        browser_visibility?: "auto" | "visible" | "headless";
      },
    ) => {
      setApprovelBusyId(approvalId);
      try {
        applyTaskQueueSnapshot(
          await coreBridge.approveApprovel(approvalId, options),
        );
        await refreshRuntimeReadModels();
        await refreshChatReadModels(activeThreadId);
      } catch (error) {
        console.warn("approval_approve unavailable", error);
      } finally {
        setApprovelBusyId(null);
      }
    },
    [
      activeThreadId,
      applyTaskQueueSnapshot,
      refreshChatReadModels,
      refreshRuntimeReadModels,
    ],
  );

  const handleRejectApprovel = useCallback(
    async (approvalId: string) => {
      setApprovelBusyId(approvalId);
      try {
        applyTaskQueueSnapshot(
          await coreBridge.rejectApprovel(
            approvalId,
            "Rejected by the user from the desktop UI.",
          ),
        );
      } catch (error) {
        console.warn("approval_reject unavailable", error);
      } finally {
        setApprovelBusyId(null);
      }
    },
    [applyTaskQueueSnapshot],
  );

  const handleResolveUncertainEffect = useCallback(
    async (
      effect: UncertainEffectItem,
      outcome: CoreUncertainEffectOutcome,
    ) => {
      setEffectResolutionBusyId(effect.id);
      setEffectResolutionError(null);
      try {
        await coreBridge.resolveUncertainEffect(effect.core, outcome);
        await loadTaskQueue();
        if (effect.threadId) {
          await refreshChatReadModels(effect.threadId);
        }
      } catch (error) {
        setEffectResolutionError({
          receiptId: effect.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setEffectResolutionBusyId(null);
      }
    },
    [loadTaskQueue, refreshChatReadModels],
  );

  return {
    taskItems,
    approvalItems,
    uncertainEffectItems,
    approvalBusyId,
    effectResolutionBusyId,
    effectResolutionError,
    refreshRuntimeReadModels,
    handleApproveApprovel,
    handleRejectApprovel,
    handleResolveUncertainEffect,
  };
}
