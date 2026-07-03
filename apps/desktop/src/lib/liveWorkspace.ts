import type { ChatEventPart } from "../types";

/**
 * Live working-island state sourced from the SPARSE structured stream events
 * (`plan_update` / `activity`), NOT from the per-frame text deltas.
 *
 * WHY this shape: plan/activity events arrive a handful of times per turn (on
 * `update_plan` / `step_advance` / tool action), while text deltas arrive at
 * ~60fps. Deriving the island from these sparse events costs ~nothing per turn,
 * so it stays live WITHOUT the per-frame churn ADR 0022 C2 avoided by binding the
 * island to persisted messages. See spec 2026-07-03-working-island-live-sync.
 */
export interface LiveWorkspaceState {
  /** Latest COMPLETE plan markdown (from the last non-empty `plan_update`); null until one arrives. */
  plan: string | null;
  /** Activity step labels accumulated from `activity` events, in arrival order. */
  activity: string[];
}

export const EMPTY_LIVE_WORKSPACE: LiveWorkspaceState = { plan: null, activity: [] };

/**
 * Fold one stream event part into the live island state (pure).
 * - `plan_update`: the markdown is the full current plan → replace. A blank
 *   markdown keeps the prior plan, mirroring `latestPlanMarkdown` returning null
 *   for empty content (so `livePlan ?? persistedPlan` never shows an empty plan).
 * - `activity`: the text is one ‹‹ACT›› body → append, trimmed, dropping blanks
 *   (parity with `parseActivitySteps`).
 * - any other type: no-op (returns the SAME reference so callers can skip re-render).
 */
export function applyLiveEvent(
  state: LiveWorkspaceState,
  part: ChatEventPart,
): LiveWorkspaceState {
  if (part.type === "plan_update") {
    if (!part.markdown || part.markdown.trim().length === 0) return state;
    return { ...state, plan: part.markdown };
  }
  if (part.type === "activity") {
    const step = part.text.trim();
    if (step.length === 0) return state;
    return { ...state, activity: [...state.activity, step] };
  }
  return state;
}
