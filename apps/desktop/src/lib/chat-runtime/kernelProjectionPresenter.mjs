import { parsePlanGoal } from "./planGoal.mjs";
import { parsePlanSteps, projectPlanSteps } from "./planSteps.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const BROWSER_ACTIVE_STATES = new Set(["active", "waiting_user", "unknown"]);

function projectionPlan(input, projection, streamMatchesProjection) {
  if (input.isStreaming && input.livePlanMarkdown) {
    return input.livePlanMarkdown;
  }
  if (projection) {
    if (!input.isStreaming || streamMatchesProjection) {
      return projection.plan?.markdown ?? null;
    }
    return null;
  }
  return null;
}

function projectionActivity(input, projection, streamMatchesProjection) {
  const durableActivity = projection
    ? (projection.activity ?? []).map((row) => row.text).filter(Boolean)
    : [];
  if (input.isStreaming && (!projection || streamMatchesProjection)) {
    return [...durableActivity, ...(input.liveActivitySteps ?? [])];
  }
  return durableActivity;
}

function workspacePlanSteps(projection, conversationPlan) {
  if (projection) return projectPlanSteps(projection);
  return parsePlanSteps(conversationPlan);
}

function workspacePlanGoal(projection, conversationPlan) {
  return projection?.plan?.goal ?? parsePlanGoal(conversationPlan);
}

function attentionItems(projection) {
  if (!projection) return [];
  const approvals = (projection.attention?.approvals ?? []).map((approval) => ({
    kind: "approval",
    id: approval.approval_id,
    action: approval.action,
    riskLevel: approval.risk_level,
  }));
  const uncertainEffects = (projection.attention?.uncertain_effects ?? [])
    .filter((effect) => effect.effect_class !== "read")
    .map((effect) => ({
      kind: "uncertain_effect",
      id: effect.receipt_ref,
      operation: effect.operation,
      effectClass: effect.effect_class,
    }));
  return [...approvals, ...uncertainEffects];
}

function browserStatus(projection) {
  const browser = projection?.browser ?? {};
  const state = browser.state ?? "idle";
  return {
    active: BROWSER_ACTIVE_STATES.has(state),
    done: state === "done",
    failed: state === "failed",
    state,
    snapshotVerified: Boolean(browser.snapshot_verified),
    failureReason: browser.failure_reason ?? null,
    latestProgress: browser.latest_progress ?? null,
  };
}

function capabilityRuntime(projection) {
  const runtime = projection?.capability_runtime ?? {};
  return {
    loadedTools: runtime.loaded_tools ?? [],
    armedSensitiveDomains: runtime.armed_sensitive_domains ?? [],
    pendingCapability: runtime.pending_capability ?? null,
    blockedCapabilities: runtime.blocked_capabilities ?? [],
  };
}

export function projectKernelThreadView(input) {
  const projection = input.projectionLoaded ? input.projection : null;
  const activeTurnId = projection?.turn?.active_turn_id ?? null;
  const streamMatchesProjection = Boolean(
    input.isStreaming
      && activeTurnId
      && input.streamOwnerTurnId
      && activeTurnId === input.streamOwnerTurnId,
  );
  const items = attentionItems(projection);
  const turnStatus = projection?.turn?.status ?? "idle";
  const turnAwaitingUser = turnStatus === "waiting_user" || items.length > 0;
  const terminalTurnAtRest = Boolean(
    projection
      && !input.isStreaming
      && !activeTurnId
      && TERMINAL_STATUSES.has(turnStatus),
  );
  const hasActiveTurn = Boolean(input.isStreaming || activeTurnId || turnAwaitingUser);
  const workInProgress = Boolean(
    input.isStreaming
      || (activeTurnId && !turnAwaitingUser && !TERMINAL_STATUSES.has(turnStatus)),
  );

  const conversationPlan = projectionPlan(input, projection, streamMatchesProjection);

  return {
    conversationPlan,
    conversationActivity: projectionActivity(input, projection, streamMatchesProjection),
    workspacePlanSteps: workspacePlanSteps(projection, conversationPlan),
    workspacePlanGoal: workspacePlanGoal(projection, conversationPlan),
    turnUiState: {
      isStreaming: Boolean(input.isStreaming),
      hasActiveTurn,
      workInProgress,
      canStop: Boolean(projection?.actions?.can_stop),
      terminalTurnAtRest,
      turnAwaitingUser,
    },
    composerMode: projection?.actions?.composer_mode ?? "new_turn",
    attentionItems: items,
    browserStatus: browserStatus(projection),
    capabilityRuntime: capabilityRuntime(projection),
  };
}
