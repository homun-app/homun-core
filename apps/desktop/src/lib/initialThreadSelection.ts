import type { ChatThread } from "../types";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./initialThreadSelection.mjs";

export const selectInitialThreadFromSnapshot =
  implementation.selectInitialThreadFromSnapshot as (input: {
    mappedThreads: ChatThread[];
    snapshotActiveThreadId?: string | null;
    defaultThread: ChatThread;
  }) => {
    desiredThreads: ChatThread[];
    selectedThread: ChatThread;
  };
