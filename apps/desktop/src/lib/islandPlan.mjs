// Auto-focus 3-step window (ZCode pattern): keep the panel short while always
// showing the current step in context. <=6 steps => show all; else a 3-step
// window centered on the current step, with the rest collapsed into
// "completed" (before) and "waiting" (after) groups.
export function currentStepIndex(steps) {
  const doing = steps.findIndex((s) => s.status === "doing" || s.status === "in_progress");
  if (doing >= 0) return doing;
  const firstOpen = steps.findIndex((s) => s.status !== "done" && s.status !== "completed");
  return firstOpen >= 0 ? firstOpen : Math.max(0, steps.length - 1);
}

export function threeStepWindow(steps) {
  if (steps.length <= 6) return { before: [], window: steps, after: [] };
  const cur = currentStepIndex(steps);
  // Two-step clamp: seed a window starting one step before current, then re-anchor
  // `start` off the clamped `end` so the window is always exactly 3 wide and in-bounds
  // even when current is at the first or last index.
  let start = Math.max(0, cur - 1);
  let end = Math.min(steps.length, start + 3);
  start = Math.max(0, end - 3);
  return {
    before: steps.slice(0, start),
    window: steps.slice(start, end),
    after: steps.slice(end),
  };
}
