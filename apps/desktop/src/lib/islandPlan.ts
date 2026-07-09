export type IslandPlanStatus = "todo" | "doing" | "done" | "blocked" | "in_progress" | "completed";
export interface IslandPlanStep { title: string; status: IslandPlanStatus }
export interface PlanWindow { before: IslandPlanStep[]; window: IslandPlanStep[]; after: IslandPlanStep[] }
// Re-export the single pure source so TS and node:test share one implementation.
// @ts-expect-error — .mjs sibling, resolved at build by Vite.
export { threeStepWindow, currentStepIndex } from "./islandPlan.mjs";
