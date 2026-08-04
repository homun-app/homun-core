import { normalizeThreadFilter } from "./threadFilter.mjs";

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

export function sidebarFilterBadgeModel(count, localizedLabel) {
  if (count <= 0) return { badge: null, badgeLabel: undefined };
  return {
    badge: count <= 9 ? count : "dot",
    badgeLabel: localizedLabel,
  };
}

export function sidebarChannelOptions(availableChannels, selectedChannels) {
  const options = [];
  const seen = new Set();
  for (const value of [...availableChannels, ...selectedChannels]) {
    if (typeof value !== "string") continue;
    const channel = value.trim();
    if (!channel || seen.has(channel)) continue;
    seen.add(channel);
    options.push(channel);
  }
  return options;
}

export function sidebarWorkspaceIsActive(ownerWorkspaceId, activeWorkspaceId, personalWorkspaceId) {
  const owner = ownerWorkspaceId ?? personalWorkspaceId;
  const active = activeWorkspaceId ?? personalWorkspaceId;
  return owner === active;
}

export function mergeSidebarUnarchiveResult(
  projectThreadsById,
  ownerWorkspaceId,
  threadId,
  snapshotThreads,
  ownerIsActive,
) {
  if (ownerIsActive) return projectThreadsById;
  const current = projectThreadsById[ownerWorkspaceId] ?? [];
  const next = Array.isArray(snapshotThreads)
    ? [...snapshotThreads]
    : current.map((thread) => thread.threadId === threadId
      ? { ...thread, status: "active", pinned: false }
      : thread);
  return { ...projectThreadsById, [ownerWorkspaceId]: next };
}

export function canReorderSidebarThreads(_filter) {
  // Every canonical order is computed. Dragging is reserved for a future manual order.
  return false;
}
