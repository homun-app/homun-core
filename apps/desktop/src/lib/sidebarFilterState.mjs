import { normalizeThreadFilter, threadFilterCount } from "./threadFilter.mjs";

export const SIDEBAR_FILTER_STORAGE_KEY = "homun.sidebar.threadFilter.v2";

export const SIDEBAR_FILTER_ROOT_ROWS = Object.freeze([
  "groupBy",
  "order",
  "states",
  "types",
  "period",
  "projects",
  "channels",
  "showArchived",
]);

export function freshSidebarThreadFilter() {
  return normalizeThreadFilter(null);
}

export function readSidebarThreadFilter(storage) {
  try {
    const stored = storage?.getItem(SIDEBAR_FILTER_STORAGE_KEY);
    return normalizeThreadFilter(stored ? JSON.parse(stored) : null);
  } catch {
    return freshSidebarThreadFilter();
  }
}

export function writeSidebarThreadFilter(storage, filter) {
  const canonical = normalizeThreadFilter(filter);
  try {
    storage?.setItem(SIDEBAR_FILTER_STORAGE_KEY, JSON.stringify(canonical));
  } catch {
    // Persistence is best-effort; callers keep using the canonical in-memory value.
  }
  return canonical;
}

export function toggleAttentionFilterStates(states) {
  const hasWaiting = states.includes("waiting_user");
  const hasFailed = states.includes("failed");
  if (hasWaiting && hasFailed) {
    return states.filter((state) => state !== "waiting_user" && state !== "failed");
  }
  const next = [...states];
  if (!hasWaiting) next.push("waiting_user");
  if (!hasFailed) next.push("failed");
  return next;
}

export function sidebarFilterBadgeModel(count, label) {
  if (count <= 0) return { badge: null, badgeLabel: undefined };
  return {
    badge: count <= 9 ? count : "dot",
    badgeLabel: `${count} ${label}`,
  };
}

export function canReorderSidebarThreads(filter) {
  const canonical = normalizeThreadFilter(filter);
  return threadFilterCount(canonical) === 0 && canonical.order === "updated_desc";
}
