import assert from "node:assert/strict";
import test from "node:test";
import {
  SIDEBAR_FILTER_ROOT_ROWS,
  SIDEBAR_FILTER_STORAGE_KEY,
  canReorderSidebarThreads,
  freshSidebarThreadFilter,
  readSidebarThreadFilter,
  sidebarFilterBadgeModel,
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

test("badge model exposes numeric thresholds, a dot overflow, and an accessible label", () => {
  assert.deepEqual(sidebarFilterBadgeModel(0, "Filters"), { badge: null, badgeLabel: undefined });
  assert.deepEqual(sidebarFilterBadgeModel(1, "Filters"), { badge: 1, badgeLabel: "1 Filters" });
  assert.deepEqual(sidebarFilterBadgeModel(9, "Filters"), { badge: 9, badgeLabel: "9 Filters" });
  assert.deepEqual(sidebarFilterBadgeModel(10, "Filters"), { badge: "dot", badgeLabel: "10 Filters" });
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

test("reordering is enabled only for a zero-count recently-updated filter", () => {
  assert.equal(canReorderSidebarThreads(canonicalDefaults), true);
  for (const nonDefault of [
    { groupBy: "project" },
    { order: "updated_asc" },
    { states: ["working"] },
    { types: ["chat"] },
    { period: "today" },
    { projects: ["local-workspace"] },
    { channels: ["chat"] },
    { tagIds: ["tag-a"] },
    { showArchived: true },
  ]) {
    assert.equal(canReorderSidebarThreads({ ...canonicalDefaults, ...nonDefault }), false);
  }
});
