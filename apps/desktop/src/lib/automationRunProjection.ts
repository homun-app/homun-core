import type { KernelThreadProjection } from "./chatApi";
import type { CoreTaskItem } from "./coreBridge";

// Node tests and the renderer share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./automationRunProjection.mjs";

export type AutomationRunState = "queued" | "running" | "terminal";

export interface AutomationRunDisplayState {
  state: AutomationRunState;
  labelKey: "automations.inQueue" | "automations.inProgress";
}

export function projectAutomationRunState(
  task: Pick<CoreTaskItem, "status" | "thread_id">,
  kernelProjection: KernelThreadProjection | null = null,
): AutomationRunDisplayState {
  return implementation.projectAutomationRunState(task, kernelProjection) as AutomationRunDisplayState;
}
