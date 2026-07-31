import type { ChatThread } from "../types";
import type { ThreadAttentionStatus } from "./threadAttentionState";

// Node contract tests and the desktop application share this dependency-free implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./threadFilter.mjs";

export type ThreadGroup = "none" | "project" | "channel" | "period";
export type ThreadOrder = "updated_desc" | "updated_asc" | "title_asc";
export type ThreadPeriod = "all" | "today" | "7d" | "30d";
export type ThreadState = "working" | "completed_unread" | "waiting_user" | "failed";
export type ThreadType = "chat" | "project";

export interface ThreadFilter {
  groupBy: ThreadGroup;
  order: ThreadOrder;
  states: ThreadState[];
  types: ThreadType[];
  period: ThreadPeriod;
  projects: string[];
  channels: string[];
  tagIds: string[];
  showArchived: boolean;
}

export interface ThreadGroupProjection {
  key: string;
  threads: ChatThread[];
}

export const EMPTY_THREAD_FILTER = implementation.EMPTY_THREAD_FILTER as ThreadFilter;

export const normalizeThreadFilter = implementation.normalizeThreadFilter as (
  value: unknown,
) => ThreadFilter;

export const threadFilterCount = implementation.threadFilterCount as (
  filter: ThreadFilter,
) => number;

export const threadFilterIsActive = implementation.threadFilterIsActive as (
  filter: ThreadFilter,
) => boolean;

export const threadSourceKey = implementation.threadSourceKey as (thread: ChatThread) => string;

export const threadUpdatedMs = implementation.threadUpdatedMs as (updatedAt: string) => number;

export const projectThreads = implementation.projectThreads as (
  threads: ChatThread[],
  filter: ThreadFilter,
  attentionByThread: Record<string, ThreadAttentionStatus>,
  threadTagIdsByThread: Record<string, string[]>,
  personalWorkspaceId: string,
  now: number,
) => ThreadGroupProjection[];
