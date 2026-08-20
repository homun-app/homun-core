import { useMemo } from "react";
import {
  deriveChatTurnStatus,
  type ChatTurnState,
} from "../lib/chat-runtime/chatTurnStatus";
import type { KernelProjectionPresenterView } from "../lib/chat-runtime/kernelProjectionPresenter";
import type { ChatStreamStatus } from "./AssistantThinkingState";
import { useChatActiveTurnElapsed } from "./useChatActiveTurnElapsed";

interface ProjectedActiveTurn {
  turn_id?: string | null;
  updated_at?: number | null;
  attempt?: number | null;
  blocked_reason?: string | null;
}

interface UseChatTurnStatusOptions {
  runtimeViewModel: KernelProjectionPresenterView;
  streamStatus: ChatStreamStatus | null;
  projectedActiveTurn: ProjectedActiveTurn | null;
  conversationActivityCount: number;
  translate: (key: string, options?: Record<string, unknown>) => string;
}

export function useChatTurnStatus({
  runtimeViewModel,
  streamStatus,
  projectedActiveTurn,
  conversationActivityCount,
  translate,
}: UseChatTurnStatusOptions): ChatTurnState | null {
  const activeTurnKey = projectedActiveTurn?.turn_id ?? streamStatus?.requestId ?? null;
  const activeTurnElapsedSeconds = useChatActiveTurnElapsed({
    activeTurnKey,
    hasActiveTurn: runtimeViewModel.turnUiState.hasActiveTurn,
    projectedUpdatedAt: projectedActiveTurn?.updated_at,
  });

  return useMemo(() => deriveChatTurnStatus({
    turnUiState: runtimeViewModel.turnUiState,
    streamStatus,
    labels: {
      waitingForYou: translate("chat.waitingForYou", { defaultValue: "Waiting for you" }),
      stillWorking: translate("chat.stillWorking"),
    },
    elapsedSeconds: activeTurnElapsedSeconds,
    attempt: projectedActiveTurn?.attempt,
    activityCount: conversationActivityCount,
    activeTurnBlockedReason: projectedActiveTurn?.blocked_reason,
  }), [
    activeTurnElapsedSeconds,
    conversationActivityCount,
    projectedActiveTurn?.attempt,
    projectedActiveTurn?.blocked_reason,
    runtimeViewModel.turnUiState,
    streamStatus?.detail,
    streamStatus?.title,
    translate,
  ]);
}
