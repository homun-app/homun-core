import { useState } from "react";
import { useChatComputerSession } from "./useChatComputerSession";
import { useChatActivityProjection } from "./useChatActivityProjection";
import type { TurnReplayState } from "../lib/turnReplayState";
import type { ChatMessage } from "../types";

export interface UseChatBrowserActivityLifecycleParams {
  computerSessionId: string;
  threadId: string;
  messages: ChatMessage[];
  threadMessages: ChatMessage[];
  islandRefreshNonce?: number;
  activeStreamInProgress: boolean;
  liveActivitySteps: string[];
  livePlanMarkdown: string | null;
  activeTurnIdRef: { current: string | null };
  streamOwnerTurnRef: { current: string | null };
  turnReplayRef: { current: TurnReplayState | null };
  translate: (key: string) => string;
}

/**
 * Owns the browser / computer session state and the activity projection
 * pipeline. Combines `useChatComputerSession` (live browser surface, preview,
 * control actions) with `useChatActivityProjection` (persisted + live activity
 * steps, plan, subagents) and the `activityNonce` used to auto-open the
 * activity island.
 *
 * Streaming functions (submitPrompt, resumeActiveStream, …) stay in ChatView —
 * they call `applyComputerSessionSnapshot`, `clearProjectedActiveTurn` and
 * `markProjectedTurnStatus` at runtime, which are safe to reference because
 * the hook has already returned by the time those functions run.
 */
export function useChatBrowserActivityLifecycle({
  computerSessionId,
  threadId,
  messages,
  threadMessages,
  islandRefreshNonce,
  activeStreamInProgress,
  liveActivitySteps,
  livePlanMarkdown,
  activeTurnIdRef,
  streamOwnerTurnRef,
  turnReplayRef,
  translate,
}: UseChatBrowserActivityLifecycleParams) {
  // ── Computer session ──────────────────────────────────────────────────────
  const {
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
  } = useChatComputerSession({
    computerSessionId,
    unavailableMessage: translate("chat.noComputerSessionFound"),
  });

  // ── Activity nonce ────────────────────────────────────────────────────────
  // Bumped when the user asks for the activity list; the adaptive island opens
  // that exact section.
  const [activityNonce, setActivityNonce] = useState(0);
  const bumpActivityNonce = () => setActivityNonce((n) => n + 1);

  // ── Activity projection ───────────────────────────────────────────────────
  const {
    browserBudgetAssistantId,
    browserBudgetMessage,
    clearProjectedActiveTurn,
    conversationActivity,
    conversationPlan,
    markProjectedTurnStatus,
    projectedActiveTurn,
    projectedSubagents,
    projectedTurnStatus,
    projectionLoaded,
    workspacePlanGoal,
    workspacePlanSteps,
  } = useChatActivityProjection({
    activeTurnIdRef,
    islandRefreshNonce,
    isStreaming: activeStreamInProgress,
    liveActivitySteps,
    livePlanMarkdown,
    messages,
    streamOwnerTurnRef,
    threadId,
    threadMessages,
    translate,
    turnReplayRef,
  });

  return {
    // Computer session
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
    // Activity nonce
    activityNonce,
    bumpActivityNonce,
    // Activity projection
    browserBudgetAssistantId,
    browserBudgetMessage,
    clearProjectedActiveTurn,
    conversationActivity,
    conversationPlan,
    markProjectedTurnStatus,
    projectedActiveTurn,
    projectedSubagents,
    projectedTurnStatus,
    projectionLoaded,
    workspacePlanGoal,
    workspacePlanSteps,
  };
}
