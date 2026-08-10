// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./planStepDisplay.mjs";

export type PlanStepStatus = "todo" | "doing" | "done" | "blocked";

export interface PlanStepDisplayInput {
  status?: PlanStepStatus | string;
  title?: string;
  detail?: string;
  done_criterion?: string | null;
}

export interface PlanStepDisplay {
  status: string;
  itemClassName: string;
  titleClassName: string;
  icon: string;
  iconLabel: string;
  animate: boolean;
  showDoneCriterion: boolean;
}

export const derivePlanStepDisplay = implementation.derivePlanStepDisplay as (
  step: PlanStepDisplayInput,
) => PlanStepDisplay;

export const getDoneCriterionText = implementation.getDoneCriterionText as (
  step: PlanStepDisplayInput,
) => string | null;
