import assert from "node:assert/strict";
import test from "node:test";
import {
  SIDEBAR_FILTER_ROOT_ROWS,
  SIDEBAR_FILTER_STORAGE_KEY,
  canReorderSidebarThreads,
  freshSidebarThreadFilter,
  mergeSidebarUnarchiveResult,
  readSidebarThreadFilter,
  sidebarChannelOptions,
  sidebarFilterBadgeModel,
  sidebarWorkspaceIsActive,
  toggleAttentionFilterStates,
  writeSidebarThreadFilter,
} from "./sidebarFilterState.mjs";

const canonicalDefaults = {
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

test("storage uses the canonical sidebar key and normalizes missing or malformed values", () => {
  assert.equal(SIDEBAR_FILTER_STORAGE_KEY, "homun.sidebar.threadFilter.v2");
  assert.deepEqual(readSidebarThreadFilter(null), canonicalDefaults);
  assert.deepEqual(readSidebarThreadFilter({ getItem: () => null }), canonicalDefaults);
  assert.deepEqual(readSidebarThreadFilter({ getItem: () => "{" }), canonicalDefaults);
  assert.deepEqual(
    readSidebarThreadFilter({
      getItem: () => JSON.stringify({ groupBy: "bad", states: ["working", "bad"] }),
    }),
    { ...canonicalDefaults, states: ["working"] },
  );
});

test("storage reads and writes remain guarded when the storage implementation throws", () => {
  assert.deepEqual(
    readSidebarThreadFilter({ getItem: () => { throw new Error("blocked"); } }),
    canonicalDefaults,
  );
  assert.doesNotThrow(() => writeSidebarThreadFilter(
    { setItem: () => { throw new Error("full"); } },
    canonicalDefaults,
  ));
});

test("storage persists canonical data without mutating its input", () => {
  const stored = [];
  const input = {
    ...canonicalDefaults,
    states: ["working", "working", "invalid"],
    projects: [" project-a ", "project-a"],
    showArchived: "yes",
  };
  const snapshot = structuredClone(input);
  const result = writeSidebarThreadFilter({ setItem: (...args) => stored.push(args) }, input);

  assert.deepEqual(input, snapshot);
  assert.deepEqual(result, {
    ...canonicalDefaults,
    states: ["working"],
    projects: ["project-a"],
  });
  assert.deepEqual(stored, [[SIDEBAR_FILTER_STORAGE_KEY, JSON.stringify(result)]]);
});

test("root filter rows have one shared stable order", () => {
  assert.deepEqual(SIDEBAR_FILTER_ROOT_ROWS, [
    "groupBy",
    "order",
    "states",
    "types",
    "period",
    "projects",
    "channels",
    "showArchived",
  ]);
});

test("attention convenience adds whichever state is missing once without mutation", () => {
  const waitingOnly = ["working", "waiting_user"];
  const failedOnly = ["completed_unread", "failed"];

  assert.deepEqual(toggleAttentionFilterStates(waitingOnly), ["working", "waiting_user", "failed"]);
  assert.deepEqual(toggleAttentionFilterStates(failedOnly), ["completed_unread", "failed", "waiting_user"]);
  assert.deepEqual(waitingOnly, ["working", "waiting_user"]);
  assert.deepEqual(failedOnly, ["completed_unread", "failed"]);
});

test("attention convenience removes both selected states while preserving extras and order", () => {
  const states = ["working", "waiting_user", "completed_unread", "failed"];
  assert.deepEqual(toggleAttentionFilterStates(states), ["working", "completed_unread"]);
  assert.deepEqual(states, ["working", "waiting_user", "completed_unread", "failed"]);
});

test("badge model preserves the localized plural label at every visible threshold", () => {
  assert.deepEqual(sidebarFilterBadgeModel(0, "No active filters"), {
    badge: null,
    badgeLabel: undefined,
  });
  assert.deepEqual(sidebarFilterBadgeModel(1, "1 active filter"), {
    badge: 1,
    badgeLabel: "1 active filter",
  });
  assert.deepEqual(sidebarFilterBadgeModel(9, "9 active filters"), {
    badge: 9,
    badgeLabel: "9 active filters",
  });
  assert.deepEqual(sidebarFilterBadgeModel(10, "10 active filters"), {
    badge: "dot",
    badgeLabel: "10 active filters",
  });
});

test("channel choices retain persisted unloaded channels so active filters stay removable", () => {
  const available = ["chat", "slack", "chat"];
  const selected = ["telegram", " slack ", "discord", "telegram"];
  const before = structuredClone({ available, selected });

  assert.deepEqual(sidebarChannelOptions(available, selected), [
    "chat",
    "slack",
    "telegram",
    "discord",
  ]);
  assert.deepEqual({ available, selected }, before);
});

test("cross-project unarchive updates only the owning cache from its returned snapshot", () => {
  const cache = {
    alpha: [{ threadId: "alpha-archived", status: "archived" }],
    beta: [{ threadId: "beta-active", status: "active" }],
  };
  const snapshot = [
    { threadId: "alpha-archived", status: "active" },
    { threadId: "alpha-other", status: "active" },
  ];
  const before = structuredClone({ cache, snapshot });

  const result = mergeSidebarUnarchiveResult(cache, "alpha", "alpha-archived", snapshot, false);

  assert.notEqual(result, cache);
  assert.equal(result.beta, cache.beta);
  assert.deepEqual(result.alpha, snapshot);
  assert.deepEqual({ cache, snapshot }, before);
});

test("unarchive cache fallback is local and active-context snapshots remain App-owned", () => {
  const cache = {
    alpha: [
      { threadId: "target", status: "archived", pinned: true },
      { threadId: "other", status: "archived", pinned: false },
    ],
  };
  const fallback = mergeSidebarUnarchiveResult(cache, "alpha", "target", null, false);
  assert.deepEqual(fallback.alpha, [
    { threadId: "target", status: "active", pinned: false },
    { threadId: "other", status: "archived", pinned: false },
  ]);
  assert.equal(mergeSidebarUnarchiveResult(cache, "alpha", "target", [], true), cache);
});

test("workspace matching treats legacy personal ids consistently", () => {
  assert.equal(sidebarWorkspaceIsActive("project-a", "project-a", "local-workspace"), true);
  assert.equal(sidebarWorkspaceIsActive("project-a", "project-b", "local-workspace"), false);
  assert.equal(sidebarWorkspaceIsActive(null, "local-workspace", "local-workspace"), true);
  assert.equal(sidebarWorkspaceIsActive("local-workspace", null, "local-workspace"), true);
});

test("clear returns canonical filters with fresh mutable arrays", () => {
  const first = freshSidebarThreadFilter();
  const second = freshSidebarThreadFilter();
  assert.deepEqual(first, canonicalDefaults);
  assert.deepEqual(second, canonicalDefaults);
  assert.notEqual(first, second);
  for (const key of ["states", "types", "projects", "channels", "tagIds"]) {
    assert.notEqual(first[key], second[key], `${key} must be fresh`);
  }
  first.states.push("working");
  assert.deepEqual(second.states, []);
});

test("computed sidebar orders disable drag persistence so projected rows cannot snap back", () => {
  for (const order of ["updated_desc", "updated_asc", "title_asc"]) {
    assert.equal(canReorderSidebarThreads({ ...canonicalDefaults, order }), false);
  }
  assert.equal(canReorderSidebarThreads({ ...canonicalDefaults, states: ["working"] }), false);
});
