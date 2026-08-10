import { useMemo } from "react";
import { useChatSteeringQueue } from "./useChatSteeringQueue";
import { visiblePendingSteeringRows } from "../lib/chat-runtime/steering";
import { filterActiveApprovels } from "../lib/chat-runtime/approvalFlow";
import type { ApprovelItem } from "../types";

export interface UseChatApprovalFlowParams {
  threadId: string;
  isMountedRef: { current: boolean };
  onThreadChanged: () => void | Promise<void>;
  setPromptError: (message: string | null) => void;
  approvals: ApprovelItem[];
  computerSessionId: string;
  terminalTurnAtRest: boolean;
  activeTurnId: string | null;
}

/**
 * Owns the approval / steering flow: the pending-steering queue (via
 * useChatSteeringQueue), the per-turn visibility filter for steering rows,
 * and the active-session approval filter.
 *
 * Streaming functions (submitPrompt, submitComposerPrompt, stopActiveTurn)
 * stay in ChatView — they call `refreshPendingSteering` and
 * `applyPendingSteeringChange` at runtime, which are safe to reference
 * because the hook has already returned by the time those functions run.
 */
export function useChatApprovalFlow({
  threadId,
  isMountedRef,
  onThreadChanged,
  setPromptError,
  approvals,
  computerSessionId,
  terminalTurnAtRest,
  activeTurnId,
}: UseChatApprovalFlowParams) {
  const {
    pendingSteering,
    applyPendingSteeringChange,
    deletePendingSteering,
    editPendingSteering,
    refreshPendingSteering,
    sendPendingSteeringNow,
  } = useChatSteeringQueue({
    isMountedRef,
    onThreadChanged,
    setPromptError,
    threadId,
  });

  const visiblePendingSteeringRowsForTurn = useMemo(
    () =>
      visiblePendingSteeringRows(pendingSteering.rows, {
        terminalTurnAtRest,
        activeTurnId,
      }),
    [pendingSteering.rows, activeTurnId, terminalTurnAtRest],
  );

  const activeApprovels = useMemo(
    () => filterActiveApprovels(approvals, computerSessionId),
    [approvals, computerSessionId],
  );

  return {
    pendingSteering,
    applyPendingSteeringChange,
    deletePendingSteering,
    editPendingSteering,
    refreshPendingSteering,
    sendPendingSteeringNow,
    visiblePendingSteeringRowsForTurn,
    activeApprovels,
  };
}
