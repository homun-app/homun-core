export function projectTaskQueueSnapshot({
  snapshot,
  mapTask,
  mapApproval,
  mapUncertainEffect,
}) {
  const nextTasks = [
    ...snapshot.active,
    ...snapshot.queued,
    ...snapshot.blocked,
    ...snapshot.recent_failures,
  ].map(mapTask);
  const uncertainEffectItems = (snapshot.uncertain_effects ?? []).map(
    mapUncertainEffect,
  );

  return {
    taskItems: nextTasks,
    approvelItems: snapshot.waiting_approvals.length
      ? snapshot.waiting_approvals.map(mapApproval)
      : [],
    uncertainEffectItems,
  };
}

export function projectEffectResolutionError(currentEffectResolutionError, uncertainEffectItems) {
  return currentEffectResolutionError &&
    uncertainEffectItems.some((effect) => effect.id === currentEffectResolutionError.receiptId)
    ? currentEffectResolutionError
    : null;
}
