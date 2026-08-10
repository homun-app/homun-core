// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./planGoal.mjs";

export const parsePlanGoal = implementation.parsePlanGoal as (
  markdown: string,
) => string | null;
