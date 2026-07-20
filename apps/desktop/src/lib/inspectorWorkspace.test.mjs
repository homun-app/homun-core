import test from "node:test";
import assert from "node:assert/strict";

import {
  clampInspectorRatio,
  inspectorStateKey,
  inspectorWorkspaceReducer,
  loadInspectorState,
  loadInspectorWidthRatio,
  restoreInspectorState,
  saveInspectorState,
  saveInspectorWidthRatio,
} from "./inspectorWorkspace.mjs";

const base = { open: false, focused: false, activeTabId: null, tabs: [] };
const tab = (id, resourceKey = id) => ({
  id,
  kind: "file",
  resourceKey,
  title: id,
  payload: {},
});

test("openTab focuses an existing resource instead of duplicating it", () => {
  const first = inspectorWorkspaceReducer(base, { type: "openTab", tab: tab("a", "same") });
  const second = inspectorWorkspaceReducer(first, { type: "openTab", tab: tab("b", "same") });
  assert.equal(second.tabs.length, 1);
  assert.equal(second.activeTabId, "a");
  assert.equal(second.open, true);
});

test("closeTab selects the right neighbor, then the left neighbor", () => {
  const state = {
    open: true,
    focused: false,
    activeTabId: "b",
    tabs: [tab("a"), tab("b"), tab("c")],
  };
  const right = inspectorWorkspaceReducer(state, { type: "closeTab", tabId: "b" });
  assert.equal(right.activeTabId, "c");
  const left = inspectorWorkspaceReducer(right, { type: "closeTab", tabId: "c" });
  assert.equal(left.activeTabId, "a");
});

test("moveTab reorders without changing the active tab", () => {
  const state = {
    open: true,
    focused: false,
    activeTabId: "b",
    tabs: [tab("a"), tab("b"), tab("c")],
  };
  const moved = inspectorWorkspaceReducer(state, {
    type: "moveTab",
    tabId: "c",
    targetIndex: 0,
  });
  assert.deepEqual(
    moved.tabs.map((item) => item.id),
    ["c", "a", "b"],
  );
  assert.equal(moved.activeTabId, "b");
});

test("toggleFocus expands and restores without changing tabs", () => {
  const opened = inspectorWorkspaceReducer(base, { type: "openTab", tab: tab("a") });
  const focused = inspectorWorkspaceReducer(opened, { type: "toggleFocus" });
  assert.equal(focused.focused, true);
  assert.deepEqual(focused.tabs, opened.tabs);
  assert.equal(inspectorWorkspaceReducer(focused, { type: "toggleFocus" }).focused, false);
});

test("persistence keys isolate activities", () => {
  assert.notEqual(inspectorStateKey("thread-a"), inspectorStateKey("thread-b"));
});

test("restore drops descriptors rejected by current authorization", () => {
  const raw = JSON.stringify({
    open: true,
    activeTabId: "denied",
    tabs: [tab("ok"), tab("denied")],
  });
  const restored = restoreInspectorState(raw, (item) => item.id === "ok");
  assert.deepEqual(
    restored.tabs.map((item) => item.id),
    ["ok"],
  );
  assert.equal(restored.activeTabId, "ok");
});

test("ratio starts balanced and clamps both panes to 420px", () => {
  assert.equal(clampInspectorRatio(Number.NaN, 1400), 0.5);
  assert.equal(clampInspectorRatio(0.9, 1000), 0.58);
  assert.equal(clampInspectorRatio(0.1, 1000), 0.42);
});

test("state persistence stores descriptors per activity and validates on load", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const state = {
    open: true,
    focused: false,
    activeTabId: "ok",
    tabs: [tab("ok"), tab("blocked")],
  };
  saveInspectorState("thread-a", state, storage);
  const loaded = loadInspectorState("thread-a", (item) => item.id === "ok", storage);
  assert.deepEqual(loaded.tabs.map((item) => item.id), ["ok"]);
  assert.equal(loadInspectorState("thread-b", () => true, storage).tabs.length, 0);
});

test("width persistence falls back safely when storage is invalid", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  saveInspectorWidthRatio(0.63, storage);
  assert.equal(loadInspectorWidthRatio(storage), 0.63);
  values.set("homun.inspector.width-ratio.v1", "not-a-number");
  assert.equal(loadInspectorWidthRatio(storage), 0.5);
});
