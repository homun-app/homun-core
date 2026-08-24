import { useMemo } from "react";
import {
  deriveChatTurnStatus,
  type ChatTurnState,
} from "../lib/chat-runtime/chatTurnStatus";
import type { KernelProjectionPresenterView } from "../lib/chat-runtime/kernelProjectionPresenter";
import type { ChatStreamStatus } from "./AssistantThinkingState";
import { useChatActiveTurnElapsed } from "./useChatActiveTurnElapsed";

interface UseChatTurnStatusOptions {
  runtimeViewModel: KernelProjectionPresenterView;
  streamStatus: ChatStreamStatus | null;
  conversationActivityCount: number;
  translate: (key: string, options?: Record<string, unknown>) => string;
}

export function useChatTurnStatus({
  runtimeViewModel,
  streamStatus,
  conversationActivityCount,
  translate,
}: UseChatTurnStatusOptions): ChatTurnState | null {
  const activeTurn = runtimeViewModel.activeTurn;
  const activeTurnKey = activeTurn?.turn_id ?? streamStatus?.requestId ?? null;
  const activeTurnElapsedSeconds = useChatActiveTurnElapsed({
    activeTurnKey,
    hasActiveTurn: runtimeViewModel.turnUiState.hasActiveTurn,
    projectedUpdatedAt: activeTurn?.updated_at,
  });

  return useMemo(() => deriveChatTurnStatus({
    turnUiState: runtimeViewModel.turnUiState,
    streamStatus,
    labels: {
      waitingForYou: translate("chat.waitingForYou", { defaultValue: "Waiting for you" }),
      stillWorking: translate("chat.stillWorking"),
    },
    elapsedSeconds: activeTurnElapsedSeconds,
    attempt: activeTurn?.attempt,
    activityCount: conversationActivityCount,
    activeTurnBlockedReason: activeTurn?.blocked_reason,
  }), [
    activeTurn?.attempt,
    activeTurn?.blocked_reason,
    activeTurnElapsedSeconds,
    conversationActivityCount,
    runtimeViewModel.activeTurn,
    runtimeViewModel.turnUiState,
    streamStatus?.detail,
    streamStatus?.title,
    translate,
  ]);
}
