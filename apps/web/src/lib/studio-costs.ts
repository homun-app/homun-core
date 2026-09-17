import type { AssignedWork } from "../components/builder/StudioToday";
export function recordedCost(task: AssignedWork): number | null {
  if (task.simulation) return task.simulation.spent;
  return task.demoCost ?? null;
}
export function summarizeCosts(tasks: AssignedWork[]) {
  return tasks.reduce(
    (acc, t) => {
      const value = recordedCost(t);
      if (value === null) acc.unknown++;
      else acc.total += value;
      return acc;
    },
    { total: 0, unknown: 0 },
  );
}
export function remainingBudget(task: AssignedWork): number | null {
  const cost = recordedCost(task);
  return task.costLimit === undefined || cost === null ? null : Math.max(0, task.costLimit - cost);
}
