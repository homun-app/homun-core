export function deriveChatTurnStatus(input) {
  if (!input.turnUiState?.hasActiveTurn) return null;

  const turnAwaitingUser = Boolean(input.turnUiState.turnAwaitingUser);
  const streamStatus = input.streamStatus ?? {};
  const phase = turnAwaitingUser
    ? input.labels.waitingForYou
    : streamStatus.title || input.labels.stillWorking;
  const detail = turnAwaitingUser
    ? streamStatus.detail || undefined
    : streamStatus.detail || input.activeTurnBlockedReason || undefined;

  return {
    phase,
    detail,
    elapsedSeconds: input.elapsedSeconds,
    attempt: input.attempt ?? 1,
    activityCount: input.activityCount,
  };
}
