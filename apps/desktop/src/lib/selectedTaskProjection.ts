import type { ChatThread, TaskItem } from "../types";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./selectedTaskProjection.mjs";

export const projectSelectedTask = implementation.projectSelectedTask as (input: {
  taskItems: TaskItem[];
  selectedTaskId: string;
  activeThread: Pick<ChatThread, "taskId" | "title">;
  fallbackTask: TaskItem;
}) => TaskItem;
