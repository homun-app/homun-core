const THREAD_GROUPS = new Set(["none", "project", "channel", "period"]);
const THREAD_ORDERS = new Set(["updated_desc", "updated_asc", "title_asc"]);
const THREAD_PERIODS = new Set(["all", "today", "7d", "30d"]);
const THREAD_STATES = new Set(["working", "completed_unread", "waiting_user", "failed"]);
const THREAD_TYPES = new Set(["chat", "project"]);

const DAY_MS = 24 * 60 * 60 * 1000;
// App epoch-second values stay below 12 digits; stored millisecond values start here.
const NUMERIC_MILLISECONDS_MIN = 100_000_000_000;
const PERIOD_WINDOW_MS = {
  today: DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};
const PERIOD_GROUP_ORDER = ["today", "7d", "30d", "older"];

export const EMPTY_THREAD_FILTER = {
  groupBy: "none",
  order: "updated_desc",
  states: [],
  types: [],
  period: "all",
  projects: [],
  channels: [],
  tagIds: [],
  showArchived: false,
};

function emptyThreadFilter() {
  return {
    groupBy: "none",
    order: "updated_desc",
    states: [],
    types: [],
    period: "all",
    projects: [],
    channels: [],
    tagIds: [],
    showArchived: false,
  };
}

function normalizedEnumArray(value, knownValues) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    if (!knownValues.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function normalizedStringArray(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function normalizeThreadFilter(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return emptyThreadFilter();
  }
  return {
    groupBy: THREAD_GROUPS.has(value.groupBy) ? value.groupBy : "none",
    order: THREAD_ORDERS.has(value.order) ? value.order : "updated_desc",
    states: normalizedEnumArray(value.states, THREAD_STATES),
    types: normalizedEnumArray(value.types, THREAD_TYPES),
    period: THREAD_PERIODS.has(value.period) ? value.period : "all",
    projects: normalizedStringArray(value.projects),
    channels: normalizedStringArray(value.channels),
    tagIds: normalizedStringArray(value.tagIds),
    showArchived: value.showArchived === true,
  };
}

export function threadFilterCount(filter) {
  return (
    filter.states.length
    + filter.types.length
    + filter.projects.length
    + filter.channels.length
    + filter.tagIds.length
    + (filter.groupBy !== "none" ? 1 : 0)
    + (filter.order !== "updated_desc" ? 1 : 0)
    + (filter.period !== "all" ? 1 : 0)
    + (filter.showArchived ? 1 : 0)
  );
}

export function threadFilterIsActive(filter) {
  return threadFilterCount(filter) > 0;
}

export function threadSourceKey(thread) {
  return thread.source ?? "chat";
}

export function threadUpdatedMs(updatedAt) {
  if (!updatedAt) return 0;
  const numeric = Number(updatedAt);
  if (Number.isFinite(numeric)) {
    return numeric >= NUMERIC_MILLISECONDS_MIN ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function threadWorkspaceKey(thread, personalWorkspaceId) {
  return thread.workspaceId == null ? personalWorkspaceId : thread.workspaceId;
}

function threadType(thread, personalWorkspaceId) {
  return thread.workspaceId == null || thread.workspaceId === personalWorkspaceId
    ? "chat"
    : "project";
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareTitles(left, right) {
  const leftTitle = String(left.title ?? "");
  const rightTitle = String(right.title ?? "");
  return (
    compareText(leftTitle.toLowerCase(), rightTitle.toLowerCase())
    || compareText(leftTitle, rightTitle)
    || compareText(String(left.threadId), String(right.threadId))
  );
}

function compareThreads(left, right, order) {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  if (order === "title_asc") return compareTitles(left, right);

  const leftUpdated = threadUpdatedMs(left.updatedAt);
  const rightUpdated = threadUpdatedMs(right.updatedAt);
  if (leftUpdated !== rightUpdated) {
    if (order === "updated_asc") return leftUpdated < rightUpdated ? -1 : 1;
    return leftUpdated > rightUpdated ? -1 : 1;
  }
  return compareTitles(left, right);
}

function matchesPeriod(thread, period, now) {
  if (period === "all") return true;
  const updated = threadUpdatedMs(thread.updatedAt);
  if (updated === 0) return false;
  return now - updated <= PERIOD_WINDOW_MS[period];
}

function matchesFilter(
  thread,
  filter,
  attentionByThread,
  threadTagIdsByThread,
  personalWorkspaceId,
  now,
) {
  if (!filter.showArchived && thread.status === "archived") return false;
  if (filter.states.length > 0 && !filter.states.includes(attentionByThread[thread.threadId])) {
    return false;
  }
  if (filter.types.length > 0 && !filter.types.includes(threadType(thread, personalWorkspaceId))) {
    return false;
  }
  if (
    filter.projects.length > 0
    && !filter.projects.includes(threadWorkspaceKey(thread, personalWorkspaceId))
  ) {
    return false;
  }
  if (filter.channels.length > 0 && !filter.channels.includes(threadSourceKey(thread))) {
    return false;
  }
  const threadTagIds = threadTagIdsByThread[thread.threadId];
  if (
    filter.tagIds.length > 0
    && (!Array.isArray(threadTagIds) || !filter.tagIds.some((tagId) => threadTagIds.includes(tagId)))
  ) {
    return false;
  }
  return matchesPeriod(thread, filter.period, now);
}

function periodGroupKey(thread, now) {
  const updated = threadUpdatedMs(thread.updatedAt);
  if (updated === 0) return "older";
  const age = now - updated;
  if (age <= PERIOD_WINDOW_MS.today) return "today";
  if (age <= PERIOD_WINDOW_MS["7d"]) return "7d";
  if (age <= PERIOD_WINDOW_MS["30d"]) return "30d";
  return "older";
}

function groupByEncounterOrder(threads, keyForThread) {
  const groups = new Map();
  for (const thread of threads) {
    const key = keyForThread(thread);
    const groupedThreads = groups.get(key);
    if (groupedThreads) groupedThreads.push(thread);
    else groups.set(key, [thread]);
  }
  return Array.from(groups, ([key, groupedThreads]) => ({ key, threads: groupedThreads }));
}

export function projectThreads(
  threads,
  filter,
  attentionByThread,
  threadTagIdsByThread,
  personalWorkspaceId,
  now,
) {
  const canonicalFilter = normalizeThreadFilter(filter);
  const projected = threads
    .filter((thread) =>
      matchesFilter(
        thread,
        canonicalFilter,
        attentionByThread,
        threadTagIdsByThread,
        personalWorkspaceId,
        now,
      ),
    )
    .sort((left, right) => compareThreads(left, right, canonicalFilter.order));

  if (canonicalFilter.groupBy === "none") return [{ key: "all", threads: projected }];
  if (canonicalFilter.groupBy === "project") {
    return groupByEncounterOrder(projected, (thread) =>
      threadWorkspaceKey(thread, personalWorkspaceId),
    );
  }
  if (canonicalFilter.groupBy === "channel") {
    return groupByEncounterOrder(projected, threadSourceKey);
  }

  const grouped = new Map(PERIOD_GROUP_ORDER.map((key) => [key, []]));
  for (const thread of projected) grouped.get(periodGroupKey(thread, now)).push(thread);
  return PERIOD_GROUP_ORDER
    .filter((key) => grouped.get(key).length > 0)
    .map((key) => ({ key, threads: grouped.get(key) }));
}
