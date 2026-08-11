import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchKernelThreadProjection,
  type KernelThreadProjection,
  type SubagentInfo,
} from "../lib/chatApi";
import {
  createTurnReplayState,
  type TurnReplayState,
} from "../lib/turnReplayState";
import {
  replayStatusFromProjection,
  type ActiveTurnProjection,
} from "../lib/chatEventParts";
import {
  projectKernelThreadView,
  type KernelProjectionPresenterView,
} from "../lib/chat-runtime/kernelProjectionPresenter";
import type { ChatMessage } from "../types";
import {
  latestActivitySteps,
  latestPlanMarkdown,
  parsePlanGoal,
  parsePlanSteps,
  type PlanStep,
} from "./ChatPayloadParsers";

interface UseChatActivityProjectionOptions {
  activeTurnIdRef: { current: string | null };
  islandRefreshNonce?: number;
  isStreaming: boolean;
  liveActivitySteps: string[];
  livePlanMarkdown: string | null;
  messages: ChatMessage[];
  streamOwnerTurnRef: { current: string | null };
  threadId: string;
  threadMessages: ChatMessage[];
  threadTailAwaitsHitl: boolean;
  translate: (key: string) => string;
  turnReplayRef: { current: TurnReplayState | null };
}

const TERMINAL_KERNEL_STATUSES = new Set(["completed", "failed", "cancelled", "finalizing"]);

function legacyMarkerProjection(messages: ChatMessage[]) {
  return {
    plan: latestPlanMarkdown(messages),
    activity: latestActivitySteps(messages),
  };
}

function emptyKernelProjection(threadId: string): KernelThreadProjection {
  return {
    thread_id: threadId,
    revision: 0,
    turn: {
      active_turn_id: null,
      status: "idle",
      last_event_seq: 0,
      terminal_reason: null,
      failure_text: null,
      updated_at: 0,
    },
    plan: null,
    activity: [],
    subagents: [],
    browser: {
      state: "idle",
      target_id: null,
      latest_progress: null,
      failure_reason: null,
      snapshot_verified: false,
    },
    capability_runtime: {
      loaded_tools: [],
      armed_sensitive_domains: [],
      pending_capability: null,
      blocked_capabilities: [],
    },
    attention: {
      awaiting_user: false,
      approvals: [],
      uncertain_effects: [],
    },
    actions: {
      can_stop: false,
      composer_mode: "new_turn",
    },
  };
}

function activeTurnFromKernelProjection(
  projection: KernelThreadProjection | null,
): ActiveTurnProjection | null {
  const activeTurnId = projection?.turn.active_turn_id ?? null;
  if (!projection || !activeTurnId) return null;
  return {
    turn_id: activeTurnId,
    last_event_seq: projection.turn.last_event_seq,
    status: projection.turn.status,
    attempt: 1,
    max_attempts: 1,
    not_before: null,
    blocked_reason: projection.turn.failure_text,
    updated_at: projection.turn.updated_at,
  };
}

function normalizeKernelPlanStatus(status: string): PlanStep["status"] {
  if (status === "doing" || status === "done" || status === "blocked") return status;
  return "todo";
}

function kernelPlanStepsToUiSteps(projection: KernelThreadProjection | null): PlanStep[] {
  return (projection?.plan?.steps ?? []).map((step) => ({
    id: step.id,
    title: step.title,
    status: normalizeKernelPlanStatus(step.status),
    detail: step.detail ?? "",
  }));
}

function browserFailureMessage(failureReason: string | null, translate: (key: string) => string) {
  return failureReason === "wall_clock"
    ? translate("chat.browserBudget.wallClock")
    : failureReason === "failed_navigations"
      ? translate("chat.browserBudget.failedNavigations")
      : failureReason === "no_progress"
        ? translate("chat.browserBudget.noProgress")
        : failureReason
          ? translate("chat.browserBudget.default")
          : null;
}

export function useChatActivityProjection({
  activeTurnIdRef,
  islandRefreshNonce,
  isStreaming,
  liveActivitySteps,
  livePlanMarkdown,
  messages,
  streamOwnerTurnRef,
  threadId,
  threadMessages,
  threadTailAwaitsHitl,
  translate,
  turnReplayRef,
}: UseChatActivityProjectionOptions) {
  const [kernelProjection, setKernelProjection] = useState<KernelThreadProjection | null>(null);
  const [projectionLoaded, setProjectionLoaded] = useState(false);

  const legacyProjection = useMemo(() => legacyMarkerProjection(messages), [messages]);
  const projectedActiveTurn = useMemo(
    () => activeTurnFromKernelProjection(kernelProjection),
    [kernelProjection],
  );
  const projectedTurnStatus = kernelProjection?.turn.status ?? null;
  const projectedSubagents: SubagentInfo[] = kernelProjection?.subagents ?? [];

  const projectedView = projectKernelThreadView({
    projection: kernelProjection,
    isStreaming,
    livePlanMarkdown,
    projectionLoaded,
    liveActivitySteps,
    persistedPlan: legacyProjection.plan,
    persistedActivity: legacyProjection.activity,
    streamOwnerTurnId: streamOwnerTurnRef.current,
    legacyThreadTailAwaitsHitl: threadTailAwaitsHitl,
  });
  const runtimeViewModel: KernelProjectionPresenterView = projectedView;

  const conversationPlan = projectedView.conversationPlan;
  const conversationActivity = projectedView.conversationActivity;
  const browserBudgetMessage = browserFailureMessage(
    projectedView.browserStatus.failureReason,
    translate,
  );
  const browserBudgetAssistantId = projectedView.browserStatus.failureReason
    ? [...threadMessages].reverse().find((message) => message.role === "assistant")?.id ?? null
    : null;

  const workspacePlanSteps = useMemo(() => {
    if (projectionLoaded) return kernelPlanStepsToUiSteps(kernelProjection);
    return conversationPlan ? parsePlanSteps(conversationPlan) : [];
  }, [conversationPlan, kernelProjection, projectionLoaded]);

  const workspacePlanGoal = useMemo(
    () => projectedView.workspacePlanGoal ?? (conversationPlan ? parsePlanGoal(conversationPlan) : null),
    [conversationPlan, projectedView.workspacePlanGoal],
  );

  const clearProjectedActiveTurn = useCallback(() => {
    activeTurnIdRef.current = null;
    setKernelProjection((current) => {
      if (!current) return current;
      return {
        ...current,
        turn: {
          ...current.turn,
          active_turn_id: null,
        },
        actions: {
          ...current.actions,
          can_stop: false,
        },
      };
    });
  }, [activeTurnIdRef]);

  const markProjectedTurnStatus = useCallback((status: string) => {
    setKernelProjection((current) => {
      const base = current ?? emptyKernelProjection(threadId);
      const terminal = TERMINAL_KERNEL_STATUSES.has(status);
      return {
        ...base,
        turn: {
          ...base.turn,
          active_turn_id: terminal ? null : base.turn.active_turn_id,
          status,
        },
        actions: {
          ...base.actions,
          can_stop: terminal ? false : base.actions.can_stop,
          composer_mode: terminal ? "new_turn" : base.actions.composer_mode,
        },
      };
    });
    setProjectionLoaded(true);
  }, [threadId]);

  useEffect(() => {
    setKernelProjection(null);
    turnReplayRef.current = null;
    streamOwnerTurnRef.current = null;
    setProjectionLoaded(false);
  }, [streamOwnerTurnRef, threadId, turnReplayRef]);

  useEffect(() => {
    if (isStreaming) return;
    let cancelled = false;
    fetchKernelThreadProjection(threadId)
      .then((projection) => {
        if (cancelled) return;
        setKernelProjection(projection);
        const activeTurn = activeTurnFromKernelProjection(projection);
        if (activeTurn) {
          activeTurnIdRef.current = activeTurn.turn_id;
          const currentReplay = turnReplayRef.current;
          if (
            currentReplay?.turnId !== activeTurn.turn_id
            || currentReplay.lastSeq < activeTurn.last_event_seq
          ) {
            turnReplayRef.current = createTurnReplayState(activeTurn.turn_id, {
              lastSeq: activeTurn.last_event_seq,
              status: replayStatusFromProjection(activeTurn.status),
              text: currentReplay?.turnId === activeTurn.turn_id ? currentReplay.text : "",
            });
          }
        } else {
          activeTurnIdRef.current = null;
        }
        setProjectionLoaded(true);
      })
      .catch(() => {
        /* kernel projection unavailable -> legacyMarkerProjection covers old persisted messages */
      });
    return () => {
      cancelled = true;
    };
  }, [activeTurnIdRef, islandRefreshNonce, isStreaming, threadId, turnReplayRef]);

  return {
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
    runtimeViewModel,
    workspacePlanGoal,
    workspacePlanSteps,
  };
}
