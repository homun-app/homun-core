// Pure plan-markdown goal parsing shared by Node tests and the renderer.
// The kernel prepends a `**Goal**: <text>` line to plan_update markdown when
// the plan carries a goal; everything else in the markdown stays unchanged.
const PLAN_GOAL_RE = /^\*\*Goal\*\*:\s*(.+)$/m;

export function parsePlanGoal(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) return null;
  const match = markdown.match(PLAN_GOAL_RE);
  if (!match) return null;
  const goal = match[1].trim();
  return goal.length > 0 ? goal : null;
}
