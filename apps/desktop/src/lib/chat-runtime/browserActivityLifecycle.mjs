/**
 * Derive the browser status object for workspace sections from the live
 * computer session state. Pure function — no React, no side-effects.
 *
 * `active`      — the gateway reports the browser session as running.
 * `snapshotVerified` — a preview artifact has been loaded (non-null data URL).
 * `failed`      — the last control action returned an error.
 */
export function deriveBrowserStatus(
  computerLiveStatus,
  previewDataUrl,
  computerControlError,
) {
  return {
    active: computerLiveStatus.active,
    snapshotVerified: Boolean(previewDataUrl),
    failed: computerControlError !== null,
  };
}

export function deriveConversationPlan({
  isStreaming,
  livePlanMarkdown,
  projectionLoaded,
  projectedPlan,
  persistedPlan,
  projectedActiveTurnId,
  streamOwnerTurnId,
}) {
  if (!isStreaming) {
    return projectionLoaded ? projectedPlan : persistedPlan;
  }
  if (livePlanMarkdown) {
    return livePlanMarkdown;
  }
  if (
    projectionLoaded
    && projectedPlan
    && projectedActiveTurnId
    && streamOwnerTurnId
    && projectedActiveTurnId === streamOwnerTurnId
  ) {
    return projectedPlan;
  }
  return null;
}
