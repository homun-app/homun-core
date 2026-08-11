import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchThreadActivity,
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
import { deriveConversationPlan } from "../lib/chat-runtime/browserActivityLifecycle";
import type { ChatMessage } from "../types";
import {
  latestActivitySteps,
  latestPlanMarkdown,
  parsePlanGoal,
  parsePlanSteps,
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
  translate: (key: string) => string;
  turnReplayRef: { current: TurnReplayState | null };
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
  translate,
  turnReplayRef,
}: UseChatActivityProjectionOptions) {
  const [projectedActivity, setProjectedActivity] = useState<string[]>([]);
  const [projectedPlan, setProjectedPlan] = useState<string | null>(null);
  const [projectedTurnStatus, setProjectedTurnStatus] = useState<string | null>(null);
  const [projectedSubagents, setProjectedSubagents] = useState<SubagentInfo[]>([]);
  const [projectedActiveTurn, setProjectedActiveTurn] =
    useState<ActiveTurnProjection | null>(null);
  const [projectionLoaded, setProjectionLoaded] = useState(false);

  // Durable projection owns the at-rest view of activity/plan. During streaming,
  // layer only live current-turn events on top of prior projected activity so a
  // new plan-less turn never keeps showing the previous turn's plan.
  const persistedPlan = useMemo(() => latestPlanMarkdown(messages), [messages]);
  const persistedActivity = useMemo(() => latestActivitySteps(messages), [messages]);

  const conversationPlan = deriveConversationPlan({
    isStreaming,
    livePlanMarkdown,
    projectionLoaded,
    projectedPlan,
    persistedPlan,
    projectedActiveTurnId: projectedActiveTurn?.turn_id ?? null,
    streamOwnerTurnId: streamOwnerTurnRef.current,
  });

  const rawConversationActivity = isStreaming
    ? [...projectedActivity, ...liveActivitySteps]
    : projectionLoaded
      ? projectedActivity
      : persistedActivity;

  const rawLatestActivity = rawConversationActivity[rawConversationActivity.length - 1] ?? "";
  const browserBudgetReason = rawLatestActivity.startsWith("browser_budget_exceeded:")
    ? rawLatestActivity.slice("browser_budget_exceeded:".length)
    : null;
  const browserBudgetMessage = browserBudgetReason === "wall_clock"
    ? translate("chat.browserBudget.wallClock")
    : browserBudgetReason === "failed_navigations"
      ? translate("chat.browserBudget.failedNavigations")
      : browserBudgetReason === "no_progress"
        ? translate("chat.browserBudget.noProgress")
        : browserBudgetReason
          ? translate("chat.browserBudget.default")
          : null;
  const conversationActivity = rawConversationActivity.map((step) =>
    step.startsWith("browser_budget_exceeded:")
      ? step.endsWith(":wall_clock")
        ? translate("chat.browserBudget.wallClock")
        : step.endsWith(":failed_navigations")
          ? translate("chat.browserBudget.failedNavigations")
          : step.endsWith(":no_progress")
            ? translate("chat.browserBudget.noProgress")
            : translate("chat.browserBudget.default")
      : step,
  );
  const browserBudgetAssistantId = browserBudgetReason
    ? [...threadMessages].reverse().find((message) => message.role === "assistant")?.id ?? null
    : null;

  const workspacePlanSteps = useMemo(() => {
    const steps = conversationPlan ? parsePlanSteps(conversationPlan) : [];
    if (!isStreaming && projectedTurnStatus === "completed") {
      return steps.map((step) =>
        step.status === "doing" ? { ...step, status: "done" as const } : step,
      );
    }
    return steps;
  }, [conversationPlan, isStreaming, projectedTurnStatus]);

  // Goal line (`**Goal**: ...`) prepended by the kernel to plan markdown.
  const workspacePlanGoal = useMemo(
    () => (conversationPlan ? parsePlanGoal(conversationPlan) : null),
    [conversationPlan],
  );

  const clearProjectedActiveTurn = useCallback(() => {
    setProjectedActiveTurn(null);
  }, []);

  const markProjectedTurnStatus = useCallback((status: string) => {
    setProjectedTurnStatus(status);
  }, []);

  useEffect(() => {
    setProjectedActivity([]);
    setProjectedPlan(null);
    setProjectedTurnStatus(null);
    setProjectedSubagents([]);
    setProjectedActiveTurn(null);
    turnReplayRef.current = null;
    streamOwnerTurnRef.current = null;
    setProjectionLoaded(false);
  }, [streamOwnerTurnRef, threadId, turnReplayRef]);

  // Load at rest only: mid-stream fetches can double-count the active turn
  // against live event updates. The marker fallback covers older persisted
  // messages and transient projection failures.
  useEffect(() => {
    if (isStreaming) return;
    let cancelled = false;
    fetchThreadActivity(threadId)
      .then((projection) => {
        if (cancelled) return;
        setProjectedActivity(projection.activity);
        setProjectedPlan(projection.plan_markdown);
        setProjectedTurnStatus(projection.latest_turn_status);
        setProjectedSubagents(projection.subagents ?? []);
        const activeTurn = (
          projection as typeof projection & { active_turn?: ActiveTurnProjection | null }
        ).active_turn ?? null;
        setProjectedActiveTurn(activeTurn);
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
        }
        setProjectionLoaded(true);
      })
      .catch(() => {
        /* projection unavailable -> island falls back to live + persisted markers */
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
    workspacePlanGoal,
    workspacePlanSteps,
  };
}
