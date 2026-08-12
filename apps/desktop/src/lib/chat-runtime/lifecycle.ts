export interface ActiveTurnProjectionLike {
  turn_id: string;
  status: string;
  updated_at?: number;
  attempt?: number;
  max_attempts?: number;
  last_event_seq?: number;
  not_before?: number | null;
  blocked_reason?: string | null;
}

export interface TurnLifecycleInput {
  promptSubmitting: boolean;
  streamingAssistantId: string | null;
  projectedActiveTurn: ActiveTurnProjectionLike | null;
  projectedTurnStatus: string | null;
  projectionLoaded: boolean;
  threadTailAwaitsHitl: boolean;
}

export interface TurnLifecycleView {
  isStreaming: boolean;
  threadTailAwaitsHitl: boolean;
  turnAwaitingUser: boolean;
  terminalTurnAtRest: boolean;
  hasActiveTurn: boolean;
  workInProgress: boolean;
  canStop: boolean;
}

export const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "finalizing",
  "failed",
  "cancelled",
  "expired",
]);

const NON_WORK_ACTIVE_STATUSES = new Set([
  "parked",
]);

export function deriveTurnLifecycle(input: TurnLifecycleInput): TurnLifecycleView {
  const isStreaming = Boolean(input.promptSubmitting || input.streamingAssistantId);
  const threadTailAwaitsHitl = !input.projectionLoaded && Boolean(input.threadTailAwaitsHitl);
  const activeStatus = input.projectedActiveTurn?.status ?? null;
  const turnAwaitingUser = activeStatus === "waiting_user_approval" || threadTailAwaitsHitl;
  const activeButNotModelWork = activeStatus !== null && NON_WORK_ACTIVE_STATUSES.has(activeStatus);
  const terminalTurnAtRest = Boolean(
    input.projectionLoaded
      && !input.projectedActiveTurn
      && input.projectedTurnStatus !== null
      && TERMINAL_TURN_STATUSES.has(input.projectedTurnStatus),
  );
  const hasActiveTurn = Boolean(isStreaming || input.projectedActiveTurn || threadTailAwaitsHitl);
  const workInProgress = Boolean(
    isStreaming
      || (input.projectedActiveTurn && !turnAwaitingUser && !activeButNotModelWork),
  );
  const canStop = Boolean(isStreaming || (input.projectedActiveTurn && !turnAwaitingUser));

  return {
    isStreaming,
    threadTailAwaitsHitl,
    turnAwaitingUser,
    terminalTurnAtRest,
    hasActiveTurn,
    workInProgress,
    canStop,
  };
}
