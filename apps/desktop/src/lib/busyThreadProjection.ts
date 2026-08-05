import type { ChatThread, TaskItem } from "../types";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./busyThreadProjection.mjs";

export const projectBusyThreadIds = implementation.projectBusyThreadIds as (input: {
  backgroundStreamIds: Set<string>;
  streamingThreadId: string | null;
  chatThreads: Pick<ChatThread, "threadId" | "taskId">[];
  taskItems: Pick<TaskItem, "id" | "status">[];
}) => Set<string>;
