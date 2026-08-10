/**
 * Derives display metadata for a single plan step in the workspace island.
 *
 * The workspace activity panel renders each plan step as a list item whose
 * visual affordances depend on the step's status:
 *   - doing  → bold title + pulsing brand dot (the currently executing step)
 *   - done   → checkmark glyph in a green dot + muted/strikethrough title
 *   - blocked→ exclamation in a danger dot + danger-coloured title
 *   - todo   → plain faint-outlined dot, normal title
 *
 * This helper is a pure function: it maps a plan step to the class names,
 * icon glyph, and animation flag the renderer needs. It does NOT touch the DOM.
 *
 * @param {{ status?: string, title?: string, detail?: string, done_criterion?: string | null }} step
 * @returns {{
 *   status: string,
 *   itemClassName: string,
 *   titleClassName: string,
 *   icon: string,
 *   iconLabel: string,
 *   animate: boolean,
 *   showDoneCriterion: boolean,
 * }}
 */
export function derivePlanStepDisplay(step) {
  const status = step?.status ?? "todo";
  const base = {
    status,
    itemClassName: `status-${status}`,
    titleClassName: "plan-step-title",
    icon: "",
    iconLabel: "",
    animate: false,
    showDoneCriterion: true,
  };

  switch (status) {
    case "doing":
      return {
        ...base,
        titleClassName: "plan-step-title plan-step-title--doing",
        iconLabel: "In progress",
        animate: true,
      };
    case "done":
      return {
        ...base,
        titleClassName: "plan-step-title plan-step-title--done",
        icon: "\u2713", // ✓
        iconLabel: "Completed",
      };
    case "blocked":
      return {
        ...base,
        titleClassName: "plan-step-title plan-step-title--blocked",
        icon: "!",
        iconLabel: "Blocked",
      };
    default:
      return {
        ...base,
        status: "todo",
        itemClassName: "status-todo",
        iconLabel: "Pending",
      };
  }
}

/**
 * Returns the done-criterion sub-text for a plan step, or null when absent.
 *
 * Prefers an explicit `done_criterion` field; falls back to `detail`
 * (the descriptive text carried by the plan markdown). The Rust plan
 * markdown emits "—" as a placeholder when detail is empty — that is hidden
 * so the sub-text line does not render for steps with no real criterion.
 *
 * @param {{ detail?: string, done_criterion?: string | null }} step
 * @returns {string | null}
 */
export function getDoneCriterionText(step) {
  const raw = step?.done_criterion ?? step?.detail ?? "";
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text === "\u2014" || text === "--") return null;
  return text;
}
