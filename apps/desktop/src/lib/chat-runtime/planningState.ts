// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./planningState.mjs";

export type PlanDisplayState = "planning" | "browsing" | "active" | "completed" | "idle";

export interface PlanningDisplayStateInput {
  workInProgress: boolean;
  planStepCount: number;
  /** Number of live activity steps (e.g. from the browse sub-agent).
   *  When > 0 and no plan exists, the UI shows "Browsing…" instead of "Planning…". */
  activityStepCount?: number;
}

export interface PlanningDisplayStateResult {
  showPlanningIndicator: boolean;
  showBrowsingIndicator: boolean;
  showPlan: boolean;
  planDisplayState: PlanDisplayState;
}

export const derivePlanningDisplayState = implementation.derivePlanningDisplayState as (
  input: PlanningDisplayStateInput,
) => PlanningDisplayStateResult;
