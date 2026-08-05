import type { ChatThread } from "../types";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./threadSnapshotProjection.mjs";

export const projectThreadSnapshotSelection =
  implementation.projectThreadSnapshotSelection as (input: {
    mappedThreads: ChatThread[];
    activeThreadId: string;
    snapshotActiveThreadId: string;
    defaultThread: ChatThread;
  }) => {
    desiredThreads: ChatThread[];
    preservedThread: ChatThread | undefined;
    selectedThread: ChatThread;
  };
