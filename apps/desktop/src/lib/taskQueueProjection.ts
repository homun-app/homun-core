import type {
  CoreApprovelItem,
  CoreTaskItem,
  CoreTaskQueueSnapshot,
  CoreUncertainEffect,
} from "./coreBridge";
import type { ApprovelItem, TaskItem, UncertainEffectItem } from "../types";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./taskQueueProjection.mjs";

export type EffectResolutionError = {
  receiptId: string;
  message: string;
};

export const projectTaskQueueSnapshot =
  implementation.projectTaskQueueSnapshot as (input: {
    snapshot: CoreTaskQueueSnapshot;
    fallbackTasks: TaskItem[];
    mapTask: (item: CoreTaskItem) => TaskItem;
    mapApproval: (item: CoreApprovelItem) => ApprovelItem;
    mapUncertainEffect: (item: CoreUncertainEffect) => UncertainEffectItem;
  }) => {
    taskItems: TaskItem[];
    approvelItems: ApprovelItem[];
    uncertainEffectItems: UncertainEffectItem[];
  };

export const projectEffectResolutionError =
  implementation.projectEffectResolutionError as (
    currentEffectResolutionError: EffectResolutionError | null,
    uncertainEffectItems: Pick<UncertainEffectItem, "id">[],
  ) => EffectResolutionError | null;
