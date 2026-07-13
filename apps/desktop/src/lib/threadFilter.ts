import type { ChatThread } from "../types";

// Sidebar list filter: by tag, by recency (updatedAt), and by conversation type (source). Kept
// as a plain value + pure predicate so the sidebar can filter without extra state machinery.

export type DateFilter = "all" | "today" | "7d" | "30d";

export interface ThreadFilter {
  /** Tag ids — a thread passes if it carries ANY of them (OR). Empty = no tag constraint. */
  tagIds: string[];
  date: DateFilter;
  /** Source keys ("chat" for a plain thread, else the channel) — OR. Empty = any type. */
  sources: string[];
}

export const EMPTY_THREAD_FILTER: ThreadFilter = { tagIds: [], date: "all", sources: [] };

export function threadFilterIsActive(filter: ThreadFilter): boolean {
  return filter.tagIds.length > 0 || filter.date !== "all" || filter.sources.length > 0;
}

export function threadFilterCount(filter: ThreadFilter): number {
  return filter.tagIds.length + filter.sources.length + (filter.date !== "all" ? 1 : 0);
}

/** The source key for a thread: the channel, or "chat" for a plain conversation. */
export function threadSourceKey(thread: ChatThread): string {
  return thread.source ?? "chat";
}

/** Parse the stored `updatedAt` (epoch seconds or ms as a string) to epoch ms, mirroring
 *  `formatThreadRelativeTime`. Returns 0 when unparseable so such a thread only survives the
 *  "all" date filter. */
export function threadUpdatedMs(updatedAt: string): number {
  if (!updatedAt) return 0;
  const numeric = Number(updatedAt);
  if (Number.isFinite(numeric)) return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  const parsed = Date.parse(updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const DATE_WINDOW_MS: Record<Exclude<DateFilter, "all">, number> = {
  today: 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Does a thread pass the filter? `threadTagIds` is the set of tag ids on this thread (the caller
 * has the shared assignments map, so we don't re-query here). `now` is injected for testability.
 */
export function threadMatchesFilter(
  thread: ChatThread,
  filter: ThreadFilter,
  threadTagIds: string[],
  now: number = Date.now(),
): boolean {
  if (filter.date !== "all") {
    const updated = threadUpdatedMs(thread.updatedAt);
    if (updated === 0 || now - updated > DATE_WINDOW_MS[filter.date]) return false;
  }
  if (filter.sources.length > 0 && !filter.sources.includes(threadSourceKey(thread))) {
    return false;
  }
  if (filter.tagIds.length > 0 && !filter.tagIds.some((id) => threadTagIds.includes(id))) {
    return false;
  }
  return true;
}
