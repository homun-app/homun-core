/** Plan step status as parsed from the ‹‹PLAN›› markdown checklist markers. */
export type PlanStepStatus = "todo" | "doing" | "done" | "blocked";

/**
 * The VISUAL indicator for a plan step. Distinct from raw status because a
 * `doing` step means two different things depending on whether the turn is still
 * running:
 * - while streaming → `running` (show a spinner: "the agent is on this step now").
 * - after the turn ended → `incomplete` (the step was LEFT open — honest signal
 *   that the work didn't finish, instead of an ambiguous empty checkbox that reads
 *   as "stuck"). This is the fix for a finalized turn looking like it's hanging.
 */
export type PlanStepIndicator = "done" | "running" | "incomplete" | "blocked" | "pending";

/** Pure mapping (status, streaming) → visual indicator. */
export function planStepIndicator(status: PlanStepStatus, streaming: boolean): PlanStepIndicator {
  if (status === "done") return "done";
  if (status === "blocked") return "blocked";
  if (status === "doing") return streaming ? "running" : "incomplete";
  return "pending"; // todo
}
