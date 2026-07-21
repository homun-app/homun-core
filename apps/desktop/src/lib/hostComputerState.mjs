export const initialHostComputerState = Object.freeze({
  sequence: 0,
  sessionId: null,
  generation: 0,
  phase: "idle",
  app: null,
  window: null,
  artifactRef: null,
  pendingApproval: null,
  canResume: false,
  needsHydration: false,
  errorCode: null,
});

const phases = new Set([
  "idle", "observing", "awaiting_approval", "acting", "paused_by_user",
  "suspended", "done", "failed", "cancelled",
]);

export function reduceHostComputerEvent(state, event) {
  if (!event || typeof event !== "object" || !Number.isInteger(event.sequence)) return state;
  if (event.sequence <= state.sequence) return state;
  if (state.sequence > 0 && event.sequence !== state.sequence + 1) {
    return { ...state, needsHydration: true };
  }
  if (!phases.has(event.phase)) return state;
  const next = {
    ...state,
    sequence: event.sequence,
    sessionId: typeof event.session_id === "string" ? event.session_id : state.sessionId,
    phase: event.phase,
    needsHydration: false,
  };
  if (Number.isInteger(event.generation)) next.generation = event.generation;
  if (typeof event.app === "string") next.app = event.app.slice(0, 200);
  if (typeof event.window === "string") next.window = event.window.slice(0, 300);
  if (typeof event.artifact_ref === "string") next.artifactRef = event.artifact_ref;
  if (event.phase === "awaiting_approval") {
    next.pendingApproval = sanitizeApproval(event.approval);
  } else if (event.phase === "paused_by_user") {
    next.pendingApproval = null;
    next.canResume = true;
  } else {
    next.pendingApproval = null;
    next.canResume = false;
  }
  next.errorCode = typeof event.error_code === "string" ? event.error_code : null;
  return next;
}

function sanitizeApproval(value) {
  if (!value || typeof value !== "object") return null;
  const category = typeof value.category === "string" ? value.category : "action";
  const summary = typeof value.summary === "string" ? value.summary.slice(0, 500) : "";
  const actionDigest = typeof value.action_digest === "string" ? value.action_digest : "";
  return { category, summary, actionDigest };
}
