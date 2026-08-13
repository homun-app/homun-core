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

export function deriveTurnLifecycle(input) {
  const isStreaming = Boolean(input.promptSubmitting || input.streamingAssistantId);
  const activeStatus = input.projectedActiveTurn?.status ?? null;
  const turnAwaitingUser = activeStatus === "waiting_user_approval";
  const activeButNotModelWork = activeStatus !== null && NON_WORK_ACTIVE_STATUSES.has(activeStatus);
  const terminalTurnAtRest = Boolean(
    input.projectionLoaded
      && !input.projectedActiveTurn
      && input.projectedTurnStatus !== null
      && TERMINAL_TURN_STATUSES.has(input.projectedTurnStatus),
  );
  const hasActiveTurn = Boolean(isStreaming || input.projectedActiveTurn);
  const workInProgress = Boolean(
    isStreaming
      || (input.projectedActiveTurn && !turnAwaitingUser && !activeButNotModelWork),
  );
  const canStop = Boolean(isStreaming || (input.projectedActiveTurn && !turnAwaitingUser));

  return {
    isStreaming,
    turnAwaitingUser,
    terminalTurnAtRest,
    hasActiveTurn,
    workInProgress,
    canStop,
  };
}
