// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./stepAdvanceDisplay.mjs";
import type { StepAdvancePayload } from "../coreBridge";

export type StepAdvanceDisplayKind = "verified" | "unverified" | "transition";

export interface StepAdvanceDisplay {
  kind: StepAdvanceDisplayKind;
  i18nKey: string;
  params: Record<string, string>;
}

export const isValidStepAdvancePayload = implementation.isValidStepAdvancePayload as (
  payload: unknown,
) => boolean;

export const stepAdvanceDisplay = implementation.stepAdvanceDisplay as (
  payload: StepAdvancePayload,
) => StepAdvanceDisplay;
