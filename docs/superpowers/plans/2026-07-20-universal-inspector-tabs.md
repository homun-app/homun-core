# Universal Tabbed Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Homun's floating Workbench and computer detail panels with one persistent, resizable, per-task tabbed inspector that gives files, artifacts, memory, plans, activity, execution, sources, subagents, and computer views the full available column.

**Architecture:** Keep backend and data contracts unchanged. Add a pure reducer/persistence module for inspector state, a focused React shell for tabs and resize behavior, then adapt `ChatView`'s existing view renderers into resource-backed tabs. The chat and inspector become real sibling grid columns; narrow containers switch to a single-pane mode without overlaying the conversation.

**Tech Stack:** React 18, TypeScript, Vite, Electron, CSS Grid/container queries, Node `node:test`, existing Homun `coreBridge` and i18next.

---

## Working context and verified baseline

- Worktree: `/Users/fabio/Projects/Homun/app/.worktrees/universal-inspector-tabs`
- Branch: `fabio/universal-inspector-tabs`
- Design: `docs/superpowers/specs/2026-07-20-universal-inspector-tabs-design.md`
- Baseline verified on 2026-07-20:
  - `npm run test:ui-contract` → pass
  - `npm run test:electron` → 22 pass, 0 fail
  - `npm run typecheck` → pass
  - `cargo build --workspace` → pass with existing warnings

## File structure

### New files

- `apps/desktop/src/lib/inspectorWorkspace.mjs` — pure reducer, tab identity,
  persistence parsing, restoration filtering, and width clamping shared by runtime and
  `node:test`.
- `apps/desktop/src/lib/inspectorWorkspace.ts` — TypeScript types and typed re-export of the
  pure implementation.
- `apps/desktop/src/lib/inspectorWorkspace.test.mjs` — state, deduplication, ordering,
  isolation, restore, and ratio tests.
- `apps/desktop/src/components/InspectorTabStrip.tsx` — ARIA tab list, close, add, overflow,
  pointer reorder, and keyboard reorder.
- `apps/desktop/src/components/InspectorWorkspace.tsx` — structural shell, separator,
  persisted ratio, single-pane controls, and active content outlet.

### Modified files

- `apps/desktop/src/components/ChatView.tsx` — replace Workbench booleans with reducer state,
  map existing entry points to tab descriptors, render active view adapters, and move the
  computer detail surface into the inspector.
- `apps/desktop/src/components/ChatHeaderMenu.tsx` — open inspector descriptors instead of
  importing the legacy `WorkbenchTab` from `ChatView`.
- `apps/desktop/src/components/WorkspaceIsland.tsx` — open inspector utility tabs through the
  shared descriptor contract and stop competing with an open inspector.
- `apps/desktop/src/styles.css` — real two-column grid, tab strip, resize states, full-width
  artifact surface, and single-pane responsive behavior.
- `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json` — accessible tab, resize, overflow,
  missing, denied, and empty-workspace labels.
- `apps/desktop/scripts/check-ui-contract.mjs` — remove assertions for the floating island and
  assert the new structural/accessibility contract.
- `apps/desktop/package.json` — add the focused inspector state test script.

## Scope guard

This plan is one UI subsystem and remains one implementation plan. It does not add a new
browser, backend endpoints, editors, or cloud synchronization. `sources`, `subagents`, and
`computer` are adapters over data already present in `ChatView`/`WorkspaceIsland`; they do not
introduce new runtime behavior.

### Task 1: Pure inspector state and persistence contract

**Files:**
- Create: `apps/desktop/src/lib/inspectorWorkspace.mjs`
- Create: `apps/desktop/src/lib/inspectorWorkspace.ts`
- Create: `apps/desktop/src/lib/inspectorWorkspace.test.mjs`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write the failing state tests**

Create tests covering open/dedup, active-neighbor close, move, scope keys, validation, and
ratio clamp:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  clampInspectorRatio,
  inspectorStateKey,
  inspectorWorkspaceReducer,
  restoreInspectorState,
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
  const state = { open: true, focused: false, activeTabId: "b", tabs: [tab("a"), tab("b"), tab("c")] };
  const right = inspectorWorkspaceReducer(state, { type: "closeTab", tabId: "b" });
  assert.equal(right.activeTabId, "c");
  const left = inspectorWorkspaceReducer(right, { type: "closeTab", tabId: "c" });
  assert.equal(left.activeTabId, "a");
});

test("moveTab reorders without changing the active tab", () => {
  const state = { open: true, focused: false, activeTabId: "b", tabs: [tab("a"), tab("b"), tab("c")] };
  const moved = inspectorWorkspaceReducer(state, { type: "moveTab", tabId: "c", targetIndex: 0 });
  assert.deepEqual(moved.tabs.map((item) => item.id), ["c", "a", "b"]);
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
  const raw = JSON.stringify({ open: true, activeTabId: "denied", tabs: [tab("ok"), tab("denied")] });
  const restored = restoreInspectorState(raw, (item) => item.id === "ok");
  assert.deepEqual(restored.tabs.map((item) => item.id), ["ok"]);
  assert.equal(restored.activeTabId, "ok");
});

test("ratio starts balanced and clamps both panes to 420px", () => {
  assert.equal(clampInspectorRatio(Number.NaN, 1400), 0.5);
  assert.equal(clampInspectorRatio(0.9, 1000), 0.58);
  assert.equal(clampInspectorRatio(0.1, 1000), 0.42);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd apps/desktop
node --test src/lib/inspectorWorkspace.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `inspectorWorkspace.mjs`.

- [ ] **Step 3: Implement the pure reducer and persistence helpers**

Implement these public contracts in `inspectorWorkspace.mjs`:

```js
export const INSPECTOR_WIDTH_RATIO_KEY = "homun.inspector.width-ratio.v1";
const STATE_PREFIX = "homun.inspector.thread.v1.";
export const EMPTY_INSPECTOR_STATE = Object.freeze({ open: false, focused: false, activeTabId: null, tabs: [] });

export function inspectorStateKey(threadId) {
  return `${STATE_PREFIX}${encodeURIComponent(threadId)}`;
}

export function inspectorWorkspaceReducer(state, action) {
  switch (action.type) {
    case "openTab": {
      const existing = state.tabs.find((item) => item.resourceKey === action.tab.resourceKey);
      if (existing) return { ...state, open: true, activeTabId: existing.id };
      return { ...state, open: true, activeTabId: action.tab.id, tabs: [...state.tabs, action.tab] };
    }
    case "activateTab":
      return state.tabs.some((item) => item.id === action.tabId)
        ? { ...state, open: true, activeTabId: action.tabId }
        : state;
    case "closeTab": {
      const index = state.tabs.findIndex((item) => item.id === action.tabId);
      if (index < 0) return state;
      const tabs = state.tabs.filter((item) => item.id !== action.tabId);
      if (state.activeTabId !== action.tabId) return { ...state, tabs };
      const next = tabs[index] ?? tabs[index - 1] ?? null;
      return { ...state, tabs, activeTabId: next?.id ?? null };
    }
    case "moveTab": {
      const from = state.tabs.findIndex((item) => item.id === action.tabId);
      if (from < 0) return state;
      const tabs = [...state.tabs];
      const [item] = tabs.splice(from, 1);
      tabs.splice(Math.max(0, Math.min(action.targetIndex, tabs.length)), 0, item);
      return { ...state, tabs };
    }
    case "showWorkspace":
      return { ...state, open: true };
    case "hideWorkspace":
      return { ...state, open: false };
    case "toggleFocus":
      return { ...state, open: true, focused: !state.focused };
    case "replaceState":
      return action.state;
    default:
      return state;
  }
}

export function restoreInspectorState(raw, isAllowed) {
  try {
    const parsed = JSON.parse(raw ?? "null");
    const tabs = Array.isArray(parsed?.tabs)
      ? parsed.tabs.filter((item) => item && typeof item.id === "string" &&
          typeof item.resourceKey === "string" && isAllowed(item))
      : [];
    const activeTabId = tabs.some((item) => item.id === parsed?.activeTabId)
      ? parsed.activeTabId
      : tabs[0]?.id ?? null;
    return { open: Boolean(parsed?.open), focused: Boolean(parsed?.focused), activeTabId, tabs };
  } catch {
    return { ...EMPTY_INSPECTOR_STATE, tabs: [] };
  }
}

export function clampInspectorRatio(value, containerWidth, minPane = 420) {
  if (!Number.isFinite(value) || !Number.isFinite(containerWidth) || containerWidth <= 0) return 0.5;
  if (containerWidth < minPane * 2) return 0.5;
  const min = minPane / containerWidth;
  return Math.min(1 - min, Math.max(min, value));
}
```

Add `loadInspectorState`, `saveInspectorState`, `loadInspectorWidthRatio`, and
`saveInspectorWidthRatio` as defensive wrappers accepting a `Storage`-compatible object.
They must catch storage/JSON errors, persist descriptors only, and call
`restoreInspectorState` on reads.

In `inspectorWorkspace.ts`, define `InspectorTabKind`, `InspectorTab`,
`InspectorWorkspaceState`, and the reducer action union exactly as in the design, then
re-export the `.mjs` functions using the existing `islandPlan.ts` typed-wrapper pattern.

Add to `package.json`:

```json
"test:inspector-workspace": "node --test src/lib/inspectorWorkspace.test.mjs"
```

- [ ] **Step 4: Run tests and typecheck GREEN**

Run:

```bash
cd apps/desktop
npm run test:inspector-workspace
npm run typecheck
```

Expected: 7 inspector tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the state foundation**

```bash
git add apps/desktop/package.json apps/desktop/src/lib/inspectorWorkspace.mjs \
  apps/desktop/src/lib/inspectorWorkspace.ts apps/desktop/src/lib/inspectorWorkspace.test.mjs
git commit -m "feat(ui): add inspector workspace state"
```

### Task 2: Accessible tab strip and resizable structural shell

**Files:**
- Create: `apps/desktop/src/components/InspectorTabStrip.tsx`
- Create: `apps/desktop/src/components/InspectorWorkspace.tsx`
- Modify: `apps/desktop/src/styles.css:2604-2675,6000-6075`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs:515-530`

- [ ] **Step 1: Replace the floating-panel contract with failing structural assertions**

Replace the assertions for `top: ... + 8px`, `right: 12px`, rounded corners, and floating
shadow with:

```js
assertContains("src/components/InspectorTabStrip.tsx", "role=\"tablist\"", "inspector must expose an ARIA tab list");
assertContains("src/components/InspectorWorkspace.tsx", "role=\"separator\"", "inspector must expose a keyboard resize separator");
assertContains("src/components/InspectorWorkspace.tsx", "onPointerDown", "inspector resizing must use pointer events");
assertContains("src/components/InspectorWorkspace.tsx", "onToggleFocus", "inspector must expose focus mode without destroying tabs");
assertContains("src/components/InspectorWorkspace.tsx", "hidden={tab.id !== state.activeTabId}", "inactive tab panels must remain mounted and hidden");
assertContains("src/styles.css", "grid-template-columns: minmax(420px, 1fr) minmax(420px, var(--inspector-width));", "chat and inspector must be real sibling columns");
assertContains("src/styles.css", ".active-task-layout.inspector-open > .chat-status-stack", "the working island must not create a third column");
assertNotContains("src/styles.css", ".workbench {\n  position: absolute", "legacy workbench must not float above the chat");
```

- [ ] **Step 2: Run the contract and verify RED**

Run `cd apps/desktop && npm run test:ui-contract`.

Expected: FAIL because `InspectorWorkspace.tsx` does not exist and old workbench CSS remains.

- [ ] **Step 3: Implement `InspectorTabStrip`**

The component accepts `tabs`, `activeTabId`, `addItems`, `onActivate`, `onClose`, `onMove`,
and `onAdd(kind)`. Render a scrollable `role="tablist"`; each title button uses `role="tab"`,
`aria-selected`, `aria-controls`, and roving `tabIndex`. Implement:

```ts
function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
  if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    onMove(tabs[index].id, index + (event.key === "ArrowLeft" ? -1 : 1));
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const next = (index + delta + tabs.length) % tabs.length;
    onActivate(tabs[next].id);
    tabRefs.current[next]?.focus();
  }
}
```

Use native drag events only for ordering, never as the sole input. The close button must be
a sibling of the title button to avoid nested interactive elements. Keep an overflow menu
containing every tab title. The `+` button toggles a keyboard-accessible menu built from
`addItems`; choosing an item calls `onAdd(item.kind)` and closes the menu. Close both menus on
Escape and outside pointer-down.

- [ ] **Step 4: Implement `InspectorWorkspace` resize and shell**

The shell receives the state and a `renderTab(tab)` function as props. It maps every tab to a
keyed `role="tabpanel"` and applies `hidden={tab.id !== activeTabId}`; inactive views remain
mounted so internal selection, loaders, blob lifetimes, and scroll are not lost. Apply the
ratio as a CSS variable on the outer chat layout via
`layoutRef.current?.style.setProperty` and persist on pointer-up.
The separator keyboard contract is:

```ts
function resizeBy(next: number) {
  const width = layoutRef.current?.getBoundingClientRect().width ?? 0;
  const ratio = clampInspectorRatio(next, width);
  setRatio(ratio);
  onRatioCommit(ratio);
}

function onSeparatorKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const step = event.shiftKey ? 0.1 : 0.025;
  if (event.key === "ArrowLeft") resizeBy(ratio + step);
  else if (event.key === "ArrowRight") resizeBy(ratio - step);
  else if (event.key === "Home") resizeBy(0);
  else if (event.key === "End") resizeBy(1);
  else return;
  event.preventDefault();
}
```

Use `document.body.classList.add("resizing-inspector")` during pointer movement, remove
listeners on pointer-up/cancel, and save only the committed ratio. Each mounted content panel
uses `id="inspector-panel-${tab.id}"`, `role="tabpanel"`, and
`hidden={tab.id !== state.activeTabId}`.

- [ ] **Step 5: Replace fake docking with real grid CSS**

Change `.active-task-layout` so the default remains one chat column, while
`.inspector-open` defines:

```css
.active-task-layout.inspector-open {
  --inspector-width: calc((100% - 1px) * var(--inspector-ratio, 0.5));
  grid-template-columns: minmax(420px, 1fr) minmax(420px, var(--inspector-width));
  grid-template-areas:
    "topbar inspector"
    "thread inspector"
    "composer inspector";
  padding-right: 0;
}

.active-task-layout.inspector-open > .task-topbar { grid-area: topbar; }
.active-task-layout.inspector-open > .thread-scroll { grid-area: thread; }
.active-task-layout.inspector-open > .composer-shell { grid-area: composer; }
.active-task-layout.inspector-open > .inspector-workspace { grid-area: inspector; }
.active-task-layout.inspector-open > .chat-status-stack { display: none; }

.active-task-layout.inspector-focused {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "inspector" "inspector" "inspector";
}
.active-task-layout.inspector-focused > .task-topbar,
.active-task-layout.inspector-focused > .thread-scroll,
.active-task-layout.inspector-focused > .composer-shell { display: none; }

.inspector-workspace {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: 58px minmax(0, 1fr);
  border-left: 1px solid var(--line);
  background: var(--bg);
  overflow: hidden;
}

.resizing-inspector,
.resizing-inspector * { cursor: col-resize !important; user-select: none !important; }
```

Remove `.active-task-layout.panel-open` and the old absolute `.workbench` geometry. Keep
content-specific classes until their adapters migrate in later tasks.

- [ ] **Step 6: Run focused verification GREEN**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run test:inspector-workspace
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the structural shell**

```bash
git add apps/desktop/src/components/InspectorTabStrip.tsx \
  apps/desktop/src/components/InspectorWorkspace.tsx apps/desktop/src/styles.css \
  apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(ui): add tabbed inspector shell"
```

### Task 3: Wire per-task state and singleton operational views

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx:390-405,650-705,2180-2270,2600-2645,4022-4055,5037-5445`
- Modify: `apps/desktop/src/components/ChatHeaderMenu.tsx`
- Modify: `apps/desktop/src/components/WorkspaceIsland.tsx`
- Modify: `apps/desktop/src/styles.css:6000-6500`

- [ ] **Step 1: Add failing UI-contract assertions for one state path**

Add:

```js
assertContains("src/components/ChatView.tsx", "useReducer(inspectorWorkspaceReducer", "chat must use one inspector reducer");
assertContains("src/components/ChatView.tsx", "loadInspectorState(thread.threadId", "inspector state must be scoped by thread");
assertContains("src/components/ChatView.tsx", "saveInspectorState(thread.threadId", "inspector state changes must persist by thread");
assertNotContains("src/components/ChatView.tsx", "setArtifactsOpen", "legacy open boolean must not compete with inspector state");
assertNotContains("src/components/ChatView.tsx", "setWorkbenchTab", "legacy active-tab state must be removed");
```

- [ ] **Step 2: Run `npm run test:ui-contract` and verify RED**

Expected: FAIL on the new reducer/persistence assertions.

- [ ] **Step 3: Replace the legacy booleans with reducer state**

In `ChatView`, initialize and persist by current thread:

```ts
const [inspector, dispatchInspector] = useReducer(
  inspectorWorkspaceReducer,
  undefined,
  () => loadInspectorState(
    thread.threadId,
    (item) => isRestorableInspectorTab(item, thread.threadId, thread.workspaceId),
  ),
);

useEffect(() => {
  dispatchInspector({
    type: "replaceState",
    state: loadInspectorState(
      thread.threadId,
      (item) => isRestorableInspectorTab(item, thread.threadId, thread.workspaceId),
    ),
  });
}, [thread.threadId, thread.workspaceId]);

useEffect(() => {
  saveInspectorState(thread.threadId, inspector);
}, [inspector, thread.threadId]);
```

`isRestorableInspectorTab` must require matching `payload.threadId` and exact equality of the
descriptor's `workspaceId` with `thread.workspaceId`. After this synchronous scope filter,
validate restored resource tabs before rendering their content: artifact descriptors must
still exist in the current authorized artifact list; file descriptors must resolve through
`coreBridge.fsFile(path, threadId)` with `authorized === true`. Keep those panels in a loading
state until the validation batch finishes, then dispatch one `replaceState` containing only
valid descriptors. Authorization errors never reuse cached content.

Add `openInspectorTab(kind, title, resourceKey, payload)` using
`crypto.randomUUID()` for the instance id, always storing the active `threadId` in payload,
and setting `workspaceId: thread.workspaceId ?? undefined` on the descriptor.

- [ ] **Step 4: Map legacy views to singleton descriptors**

Replace `WorkbenchTab` with `InspectorTabKind` in `ChatHeaderMenu` and `WorkspaceIsland`.
Map the existing views to stable keys:

```ts
const openUtilityTab = (kind: InspectorTabKind) =>
  openInspectorTab(kind, INSPECTOR_VIEW_LABEL[kind], `${kind}:${thread.threadId}`, {
    threadId: thread.threadId,
  });
```

The header menu opens `artifact`, `file`, and `activity` index tabs. Goal promotion opens
`goals:${threadId}`. The legacy `memoria` Workbench view maps to the `graph` kind titled
“Memory”; plan, execution, sources, and subagents use the same helper.
Opening an existing key must focus it instead of adding a duplicate.

Rename `availableWorkbenchViews` to `availableInspectorViews` and keep its current
data-driven availability rules. Extend it with Sources, Subagents, and Computer only when
their existing data/session signals are present. This array is the sole input to the `+`
menu; unavailable views are not rendered as dead menu items.

- [ ] **Step 5: Convert `Workbench` into the active content outlet**

Rename the rendering function to `InspectorView` and pass one `InspectorTab`, not `open` and
legacy `tab`. Keep existing loaders and renderers, switching on `tab.kind`. Mount it inside:

```tsx
<InspectorWorkspace
  layoutRef={layoutRef}
  state={inspector}
  onActivate={(tabId) => dispatchInspector({ type: "activateTab", tabId })}
  onCloseTab={(tabId) => dispatchInspector({ type: "closeTab", tabId })}
  onMoveTab={(tabId, targetIndex) => dispatchInspector({ type: "moveTab", tabId, targetIndex })}
  onHide={() => dispatchInspector({ type: "hideWorkspace" })}
  onToggleFocus={() => dispatchInspector({ type: "toggleFocus" })}
  addItems={availableInspectorViews}
  onAdd={openUtilityTab}
  renderTab={(tab) => <InspectorView key={tab.id} tab={tab} />}
/>
```

When `inspector.open` is true, add `inspector-open` to the layout and hide the Working Island.
When `inspector.focused` is true, also add `inspector-focused`; the expand/collapse action
toggles only this state and restores the previous ratio on exit.
Hiding the inspector must preserve `tabs` and `activeTabId`.

Keep the ratio in `ChatView` (initialized by `loadInspectorWidthRatio`) and pass it to the
shell. On each committed resize, update it and pass
``layoutSignal={`${inspector.activeTabId}:${inspectorRatio}`}`` to `MemoryGraphPanel`, preserving
the existing delayed canvas refit behavior.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run test:inspector-workspace
npm run typecheck
```

Expected: all exit 0.

Commit:

```bash
git add apps/desktop/src/components/ChatView.tsx \
  apps/desktop/src/components/ChatHeaderMenu.tsx \
  apps/desktop/src/components/WorkspaceIsland.tsx apps/desktop/src/styles.css \
  apps/desktop/scripts/check-ui-contract.mjs
git commit -m "refactor(ui): route workbench views through inspector"
```

### Task 4: File and artifact tabs as resource instances

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx:5037-5800`
- Modify: `apps/desktop/src/styles.css:6075-6505`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing resource-tab assertions**

Add:

```js
assertContains("src/components/ChatView.tsx", "`file:${normalizedPath}`", "file tabs must dedupe by canonical path");
assertContains("src/components/ChatView.tsx", "`artifact:${artifact.thread}:${artifact.name}`", "artifact tabs must dedupe by provenance and name");
assertNotContains("src/styles.css", ".artifacts-panel.embedded .artifacts-panel-body {\n  grid-template-columns:", "artifact preview must not keep a permanent inner sidebar");
```

- [ ] **Step 2: Run `npm run test:ui-contract` and verify RED**

Expected: FAIL because file/artifact resources still replace internal selection.

- [ ] **Step 3: Make the Files index open file tabs**

Keep the directory browser as the singleton `file:${threadId}:index` tab. Replace
`setOpenFile` navigation with:

```ts
async function openFileTab(path: string) {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  openInspectorTab("file", normalizedPath.split("/").pop() || normalizedPath,
    `file:${normalizedPath}`, { threadId: thread.threadId, path: normalizedPath });
}
```

The resource file adapter loads `coreBridge.fsFile(tab.payload.path, threadId)`, owns its
loading/error/diff state, and renders a breadcrumb plus full-width `CodeView`/`DiffView`.
If the bridge returns unauthorized, render `denied`; if the path disappears, render
`missing` with Ricarica and Chiudi actions.

- [ ] **Step 4: Make Review index open artifact tabs**

The singleton `artifact:${threadId}:index` tab renders a full-width list/grid only. Clicking
an item opens:

```ts
openInspectorTab(
  "artifact",
  artifact.name,
  `artifact:${artifact.thread}:${artifact.name}`,
  { threadId: thread.threadId, artifactThread: artifact.thread, name: artifact.name },
);
```

The artifact adapter resolves the item from `workbenchArtifacts` and passes a one-item array
to `ArtifactsPanel`. Remove the permanent `.artifacts-list` branch and the embedded
two-column grid. Preserve versions, edit, diff, download, folder, PDF/image/code/CSV preview,
and blob URL cleanup.

- [ ] **Step 5: Preserve per-tab scroll and selection during tab changes**

Because `InspectorWorkspace` keeps keyed inactive panels mounted with `hidden`, native scroll
and internal component selection survive normal tab switches. Add a scroll map as a defensive
fallback for panels that recreate their scroll container after data refresh:

```ts
const scrollByTab = useRef(new Map<string, number>());
function rememberScroll(tabId: string, node: HTMLElement) {
  scrollByTab.current.set(tabId, node.scrollTop);
}
function restoreScroll(tabId: string, node: HTMLElement) {
  requestAnimationFrame(() => node.scrollTo({ top: scrollByTab.current.get(tabId) ?? 0 }));
}
```

Do not persist rendered content or blob URLs to localStorage.

- [ ] **Step 6: Verify and commit resource tabs**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run test:inspector-workspace
npm run typecheck
npm run build
```

Expected: all exit 0; Vite produces `dist/` without errors.

Commit:

```bash
git add apps/desktop/src/components/ChatView.tsx apps/desktop/src/styles.css \
  apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(ui): open files and artifacts in inspector tabs"
```

### Task 5: Computer, sources, subagents, responsive mode, and failure states

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx:2200-2275,2565-2645,8151-8245`
- Modify: `apps/desktop/src/components/WorkspaceIsland.tsx`
- Modify: `apps/desktop/src/styles.css:5456-5525,10200-10455`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing unification and responsive assertions**

Add:

```js
assertNotContains("src/components/ChatView.tsx", "detailsOpen && (", "computer detail must use the shared inspector");
assertNotContains("src/styles.css", ".computer-detail-panel {\n  position: absolute", "computer detail must not float separately");
assertContains("src/styles.css", "@container chat-workspace (max-width: 960px)", "narrow behavior must follow available chat width");
assertContains("src/components/ChatView.tsx", "kind === \"sources\"", "sources must have an inspector adapter");
assertContains("src/components/ChatView.tsx", "kind === \"subagents\"", "subagents must have an inspector adapter");
```

- [ ] **Step 2: Run the UI contract and verify RED**

Run `cd apps/desktop && npm run test:ui-contract`.

Expected: FAIL on computer and utility-view assertions.

- [ ] **Step 3: Adapt the computer panel**

Replace `detailsOpen` with `openUtilityTab("computer")`. Render the existing
`ComputerDetailPanel` body inside the active tab, removing its outer absolute `aside`,
fullscreen toggle, and independent close button. Keep surface tabs, live preview, controls,
approval behavior, and the current session model unchanged.

- [ ] **Step 4: Add sources and subagent adapters**

Render existing `islandSources` in a full-width list with provenance and open actions.
Render `projectedSubagents` with status, title, summary, and timestamps using the same status
semantics already present in `WorkspaceIsland`. These views are read-only projections and
must not copy data into inspector persistence; descriptors store only `threadId`.

The Working Island opens these singleton tabs from its corresponding sections. It remains
available only while the inspector is hidden.

- [ ] **Step 5: Implement container-based single-pane behavior**

Set `container: chat-workspace / inline-size` on `.workspace` or the closest stable central
container. Add:

```css
@container chat-workspace (max-width: 960px) {
  .active-task-layout.inspector-open {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "inspector"
      "inspector"
      "inspector";
  }
  .active-task-layout.inspector-open > .task-topbar,
  .active-task-layout.inspector-open > .thread-scroll,
  .active-task-layout.inspector-open > .composer-shell { display: none; }
  .inspector-resize-handle { display: none; }
  .inspector-mobile-back { display: inline-flex; }
}
```

The back action dispatches `hideWorkspace`; it does not close tabs. Do not implement this as
an overlay or fixed-position panel.

The explicit focus button uses the same single-pane grid rules above the threshold and
dispatches `toggleFocus`; leaving focus restores the persisted ratio.

- [ ] **Step 6: Implement explicit local failure states**

Use the existing state-view language and classes for:

```ts
type InspectorResourceStatus = "loading" | "ready" | "missing" | "denied" | "unsupported" | "error";
```

Errors stay inside the affected tab. A denied transition clears prior preview/blob state
before rendering the message. Retry reruns the adapter resolver; close dispatches
`closeTab`.

- [ ] **Step 7: Verify and commit the complete view set**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run test:inspector-workspace
npm run typecheck
npm run build
```

Expected: all exit 0.

Commit:

```bash
git add apps/desktop/src/components/ChatView.tsx \
  apps/desktop/src/components/WorkspaceIsland.tsx apps/desktop/src/styles.css \
  apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(ui): unify operational views in inspector"
```

### Task 6: Localized labels and full interaction contract

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing contract assertions for translated accessible labels**

Add:

```js
assertContains("src/components/InspectorTabStrip.tsx", "t(\"chat.inspector.closeTab\"", "tab close labels must be localized");
assertContains("src/components/InspectorWorkspace.tsx", "t(\"chat.inspector.resize\"", "separator label must be localized");
assertContains("src/components/InspectorWorkspace.tsx", "aria-valuenow", "separator must expose its current value");
```

- [ ] **Step 2: Run `npm run test:ui-contract` and verify RED**

Expected: FAIL until components consume the nested translation keys.

- [ ] **Step 3: Add the complete translation shape to every locale**

Add the same keys to all five locale files:

```json
"inspector": {
  "addTab": "Open view",
  "closeTab": "Close {{title}}",
  "closeWorkspace": "Hide workspace",
  "empty": "Open a file, artifact, or activity view.",
  "focus": "Expand workspace",
  "exitFocus": "Restore split view",
  "hiddenTabs": "All open tabs",
  "missing": "This resource is no longer available.",
  "denied": "This resource is no longer authorized.",
  "unsupported": "Preview is not available for this format.",
  "retry": "Retry",
  "resize": "Resize workspace",
  "returnToChat": "Return to conversation"
}
```

Translate naturally in `it`, `es`, `fr`, and `de`; do not copy the English values. Update
the components to consume these keys for visible and ARIA labels.

- [ ] **Step 4: Run localization and UI verification GREEN**

Run:

```bash
cd apps/desktop
npm run test:electron
npm run test:ui-contract
npm run typecheck
```

Expected: 22 Electron tests plus locale parity pass; UI contract and typecheck exit 0.

- [ ] **Step 5: Commit localization/accessibility**

```bash
git add apps/desktop/src/i18n/locales apps/desktop/src/components/InspectorTabStrip.tsx \
  apps/desktop/src/components/InspectorWorkspace.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(ui): localize inspector accessibility"
```

### Task 7: Real-app visual and interaction verification

**Files:**
- Modify if verification exposes defects: only files already listed in Tasks 1–6
- Evidence only, not committed: screenshots under a temporary directory outside tracked paths

- [ ] **Step 1: Run the complete targeted automated gate**

Run:

```bash
cd apps/desktop
npm run test:inspector-workspace
npm run test:ui-contract
npm run test:electron
npm run typecheck
npm run build
cd ../..
git diff --check
```

Expected: inspector tests pass, 22 Electron tests pass, UI contract/typecheck/build pass, and
`git diff --check` prints nothing. Record warnings honestly; do not call excluded suites green.

- [ ] **Step 2: Start the actual desktop UI and verify wide geometry**

Run the app using the repository's normal desktop development launcher. At an available
central width of at least 1200 px:

1. open Files, then two different files;
2. verify three tabs (index + two resources) and no duplicate when reopening one;
3. drag the separator and confirm both chat and preview remain readable;
4. close/reopen the workspace and confirm tabs remain;
5. switch to another activity and confirm its tab set is independent;
6. return and confirm the first activity's order and active tab are restored.

Capture a screenshot showing the real 50/50 sibling layout.

- [ ] **Step 3: Verify artifacts and operational views**

Open at least one artifact with a preview, then Memory, Sources, Plan, Activity, Execution,
Subagents when data exists, and Computer when a session exists. Confirm:

- artifact preview has no permanent inner sidebar;
- toolbar actions remain reachable through overflow;
- switching tabs preserves each tab's scroll;
- graph refits after resize;
- computer controls and surface tabs still work;
- an unavailable data set shows an intentional empty state, not blank content.

- [ ] **Step 4: Verify medium and narrow geometry**

At approximately 1000–1100 px central width, confirm the ratio clamps without covering the
composer. Below the 960 px container threshold, confirm the inspector becomes a single pane,
the resize handle disappears, and “Return to conversation” hides without closing tabs.

Verify keyboard flows:

- Arrow Left/Right switches tabs;
- Alt+Arrow Left/Right reorders tabs;
- close control is reachable and labeled;
- separator arrows, Shift+arrows, Home, and End resize within bounds.

- [ ] **Step 5: Repair any observed defect test-first**

For each defect, add the narrowest reproducible assertion to
`inspectorWorkspace.test.mjs` or `check-ui-contract.mjs`, run it RED, apply the minimal fix,
then rerun the Task 7 automated gate. Do not broaden this slice into new product behavior.

- [ ] **Step 6: Commit verification fixes if any**

If files changed:

```bash
git add apps/desktop/src apps/desktop/scripts/check-ui-contract.mjs apps/desktop/package.json
git commit -m "fix(ui): harden inspector interactions"
```

If no files changed, do not create an empty commit.

## Completion gate

Before integration, invoke `superpowers:verification-before-completion`, then
`superpowers:requesting-code-review`. Only after review findings are resolved and fresh tests
are green should `superpowers:finishing-a-development-branch` be used to choose merge/PR/cleanup.

Do not tag or publish a release as part of this plan.
