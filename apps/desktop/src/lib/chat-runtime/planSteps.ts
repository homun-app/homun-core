// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./planSteps.mjs";

export type PlanStepStatus = "todo" | "doing" | "done" | "blocked";

export interface PlanStep {
  status: PlanStepStatus;
  title: string;
  detail: string;
  id?: string;
  done_criterion?: string;
}

export const normalizePlanStepStatus = implementation.normalizePlanStepStatus as (
  status: string,
) => PlanStepStatus;

export const parsePlanSteps = implementation.parsePlanSteps as (
  markdown: string,
) => PlanStep[];

export const projectPlanSteps = implementation.projectPlanSteps as (
  projection: { plan?: { steps?: Array<Record<string, unknown>> } | null } | null,
) => PlanStep[];
