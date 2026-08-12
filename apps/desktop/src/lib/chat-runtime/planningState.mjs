/**
 * Derives the planning-indicator display state from turn lifecycle signals.
 *
 * The workspace activity panel shows one of four mutually exclusive states
 * for the plan region:
 *   1. "Planning..." indicator  — turn is active, no plan emitted yet, no activity
 *   2. "Browsing..." indicator — turn is active, no plan, but activity steps exist
 *   3. Plan checklist           — plan steps are available
 *   4. Nothing                  — turn is idle and no plan exists
 *
 * The browse sub-agent emits `activity` events (not `plan_update` events),
 * so `planStepCount` stays 0 while `activityStepCount` grows.  Without the
 * browsing state the UI would show "Planning..." even though the agent is
 * actively browsing — misleading the user about what is happening.
 *
 * @param {{ workInProgress: boolean, planStepCount: number, activityStepCount?: number }} input
 * @returns {{
 *   showPlanningIndicator: boolean,
 *   showBrowsingIndicator: boolean,
 *   showPlan: boolean,
 *   planDisplayState: "planning" | "browsing" | "active" | "completed" | "idle",
 * }}
 */
export function derivePlanningDisplayState({ workInProgress, planStepCount, activityStepCount = 0 }) {
  const hasPlan = planStepCount > 0;
  const hasActivity = activityStepCount > 0;

  if (workInProgress && !hasPlan && !hasActivity) {
    return {
      showPlanningIndicator: true,
      showBrowsingIndicator: false,
      showPlan: false,
      planDisplayState: "planning",
    };
  }

  if (workInProgress && !hasPlan && hasActivity) {
    return {
      showPlanningIndicator: false,
      showBrowsingIndicator: true,
      showPlan: false,
      planDisplayState: "browsing",
    };
  }

  if (hasPlan && workInProgress) {
    return {
      showPlanningIndicator: false,
      showBrowsingIndicator: false,
      showPlan: true,
      planDisplayState: "active",
    };
  }

  if (hasPlan && !workInProgress) {
    return {
      showPlanningIndicator: false,
      showBrowsingIndicator: false,
      showPlan: true,
      planDisplayState: "completed",
    };
  }

  return {
    showPlanningIndicator: false,
    showBrowsingIndicator: false,
    showPlan: false,
    planDisplayState: "idle",
  };
}
