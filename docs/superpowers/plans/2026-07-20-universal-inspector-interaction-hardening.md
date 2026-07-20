# Universal Inspector Interaction Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate periodic preview reloads, make every document tab reliably scrollable, prevent tab-label overlap, and provide visible, accessible drag feedback.

**Architecture:** Stop unchanged polling snapshots at the App state boundary, then reconcile unchanged artifact catalogs without replacing their identity. Make each inspector tab panel the default document scroll owner, keep viewport-managed adapters explicit, and extend the existing pointer reorder with a tested drop-index helper plus transient visual state.

**Tech Stack:** React 19, TypeScript, CSS, Node test runner, Electron, existing inspector reducer and UI contract checks.

---

## File map

- Create `apps/desktop/src/lib/uiSnapshot.mjs`: pure semantic snapshot equality used by Node tests.
- Create `apps/desktop/src/lib/uiSnapshot.ts`: typed production equivalent for React state reconciliation.
- Create `apps/desktop/src/lib/uiSnapshot.test.mjs`: regression tests for unchanged polling and artifact snapshots.
- Modify `apps/desktop/src/App.tsx`: preserve the current message array when the backend snapshot is unchanged.
- Modify `apps/desktop/src/components/ChatView.tsx`: reconcile artifact catalogs and avoid preview reloads caused only by object identity.
- Modify `apps/desktop/src/lib/inspectorWorkspace.mjs`: pure drop-index calculation for pointer reordering.
- Modify `apps/desktop/src/lib/inspectorWorkspace.ts`: typed drop-index calculation used by the tab strip.
- Modify `apps/desktop/src/lib/inspectorWorkspace.test.mjs`: drop-position regression coverage.
- Modify `apps/desktop/src/components/InspectorTabStrip.tsx`: stable active-tab visibility and drag feedback state.
- Modify `apps/desktop/src/styles.css`: single scroll owner, non-overlapping tabs, drag source and insertion indicator.
- Modify `apps/desktop/scripts/check-ui-contract.mjs`: structural regression contracts.
- Modify `apps/desktop/package.json`: add one focused stability test command.

### Task 1: Stop unchanged polling snapshots at the state boundary

**Files:**
- Create: `apps/desktop/src/lib/uiSnapshot.mjs`
- Create: `apps/desktop/src/lib/uiSnapshot.ts`
- Create: `apps/desktop/src/lib/uiSnapshot.test.mjs`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write the failing semantic-equality tests**

Test equal messages with different array/object identities, changed text, changed event parts,
equal artifact catalogs and a changed artifact revision:

```js
test("unchanged message polling reuses the current snapshot", () => {
  const current = [message({ id: "m1", text: "stable" })];
  const incoming = [message({ id: "m1", text: "stable" })];
  assert.equal(reconcileChatMessages(current, incoming), current);
});

test("a real message change accepts the incoming snapshot", () => {
  const current = [message({ id: "m1", text: "before" })];
  const incoming = [message({ id: "m1", text: "after" })];
  assert.equal(reconcileChatMessages(current, incoming), incoming);
});

test("structured event changes are not hidden by reconciliation", () => {
  const current = [message({ eventParts: [{ type: "activity", text: "one" }] })];
  const incoming = [message({ eventParts: [{ type: "activity", text: "two" }] })];
  assert.equal(reconcileChatMessages(current, incoming), incoming);
});

test("unchanged artifact catalogs retain object identity", () => {
  const current = [artifact({ name: "report.md", updated: false })];
  const incoming = [artifact({ name: "report.md", updated: false })];
  assert.equal(reconcileMemoryArtifacts(current, incoming), current);
});

test("changed artifact metadata accepts the incoming catalog", () => {
  const current = [artifact({ name: "report.md", updated: false })];
  const incoming = [artifact({ name: "report.md", updated: true })];
  assert.equal(reconcileMemoryArtifacts(current, incoming), incoming);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd apps/desktop
node --test src/lib/uiSnapshot.test.mjs
```

Expected: FAIL because `uiSnapshot.mjs` or its exports do not exist.

- [ ] **Step 3: Implement minimal snapshot reconciliation**

Implement exact ordered-array reconciliation. Compare message scalar fields directly and
compare optional nested `metrics`, `attachments`, and `eventParts` with stable JSON values.
Compare every persisted `MemoryArtifactView` field so authorization-relevant paths and
revision metadata are never hidden.

```ts
export function reconcileChatMessages(
  current: ChatMessage[] | undefined,
  incoming: ChatMessage[],
): ChatMessage[] {
  if (!current || current.length !== incoming.length) return incoming;
  return current.every((item, index) => sameChatMessage(item, incoming[index]))
    ? current
    : incoming;
}

export function reconcileMemoryArtifacts(
  current: MemoryArtifactView[],
  incoming: MemoryArtifactView[],
): MemoryArtifactView[] {
  if (current.length !== incoming.length) return incoming;
  return current.every((item, index) => sameMemoryArtifact(item, incoming[index]))
    ? current
    : incoming;
}
```

Use `reconcileChatMessages` in `setThreadMessagesFromBackend` before creating the next
thread-message map. If the reconciled array is the current one, return the whole current
map unchanged.

- [ ] **Step 4: Run focused test and typecheck for GREEN**

Run:

```bash
cd apps/desktop
node --test src/lib/uiSnapshot.test.mjs
npm run typecheck
```

Expected: all snapshot tests pass; TypeScript exits 0.

- [ ] **Step 5: Commit the polling boundary fix**

```bash
git add apps/desktop/package.json apps/desktop/src/App.tsx \
  apps/desktop/src/lib/uiSnapshot.mjs apps/desktop/src/lib/uiSnapshot.ts \
  apps/desktop/src/lib/uiSnapshot.test.mjs
git commit -m "fix(ui): ignore unchanged chat polling snapshots"
```

### Task 2: Stabilize artifact identity and preview lifecycle

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing UI contracts for catalog reconciliation**

Require `ChatView` to use `reconcileMemoryArtifacts`, remove
`memoryArtifactsRevision`, and make the artifact preview effect depend on a primitive
selected-resource revision rather than the selected object reference.

```js
assertContains("src/components/ChatView.tsx", "reconcileMemoryArtifacts", "artifact polling must preserve an unchanged catalog");
assertNotContains("src/components/ChatView.tsx", "memoryArtifactsRevision", "artifact validation must not use an unconditional revision counter");
assertContains("src/components/ChatView.tsx", "selectedResourceRevision", "artifact preview reloads must follow a semantic resource revision");
```

- [ ] **Step 2: Run UI contracts and verify RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL on the new catalog lifecycle assertions.

- [ ] **Step 3: Reconcile the catalog and use a semantic preview revision**

Replace unconditional catalog state/revision updates with:

```ts
setMemoryArtifacts((current) => reconcileMemoryArtifacts(current, items));
```

Drive authorization restoration from `memoryArtifacts` identity plus loaded/error scope,
not a counter. In `ArtifactsPanel`, derive a primitive revision containing selected thread,
name, source, paths, size and updated flag; depend on that revision and explicit reload key.

```ts
const selectedResourceRevision = selected
  ? [selected.thread, selected.name, selected.source ?? "", selected.managed_path ?? "",
      selected.projectPath ?? "", selected.projectRelativePath ?? "", selected.size,
      selected.updated ? "1" : "0"].join("\u001f")
  : "";
```

Keep focus-driven revalidation fail-closed and generation guarded.

- [ ] **Step 4: Run snapshot, UI-contract and type tests for GREEN**

Run:

```bash
cd apps/desktop
npm run test:inspector-stability
npm run test:ui-contract
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the artifact lifecycle fix**

```bash
git add apps/desktop/src/components/ChatView.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "fix(ui): preserve stable inspector previews"
```

### Task 3: Establish one document scroll owner

**Files:**
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing scroll-owner contracts**

Require the tab panel to use vertical auto overflow and require embedded artifact/file/list
adapters not to create another vertical scroll container.

```js
assertContains("src/styles.css", ".inspector-tab-panel {\n  min-width: 0;\n  min-height: 0;\n  height: 100%;\n  overflow-y: auto;", "inspector tab panels must own document scrolling");
assertContains("src/styles.css", ".inspector-tab-panel .artifacts-preview-body {\n  overflow: visible;", "embedded artifact documents must use the tab scroll owner");
assertContains("src/styles.css", ".inspector-tab-panel .workbench-files {\n  overflow: visible;", "inspector lists must use the tab scroll owner");
```

- [ ] **Step 2: Run UI contracts and verify RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL because the panel currently hides overflow and adapters own nested scroll.

- [ ] **Step 3: Implement the single-scroll layout**

Set the tab panel to `overflow-y: auto`, `overflow-x: hidden`,
`overscroll-behavior: contain`, and a stable thin scrollbar gutter. Under an inspector tab,
make `workbench-files`, `workbench-fileview-body` and embedded artifact preview body use
visible overflow. Make the embedded artifact panel/content size to content with
`min-height: 100%` instead of creating a competing fixed-height scrollport.

Keep iframe, graph, canvas and computer view selectors as explicit viewport-managed
exceptions with `height: 100%; overflow: hidden`.

- [ ] **Step 4: Run UI contracts and typecheck for GREEN**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the scroll fix**

```bash
git add apps/desktop/src/styles.css apps/desktop/scripts/check-ui-contract.mjs
git commit -m "fix(ui): give inspector tabs stable scrolling"
```

### Task 4: Prevent tab overlap and keep the active tab visible

**Files:**
- Modify: `apps/desktop/src/components/InspectorTabStrip.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing tab-layout contracts**

Require non-shrinking tab units, a flexible zero-minimum title, and automatic active-tab
visibility.

```js
assertContains("src/styles.css", "flex: 0 0 auto;", "inspector tabs must not shrink through their children");
assertContains("src/components/InspectorTabStrip.tsx", "scrollIntoView", "the active inspector tab must remain visible");
assertContains("src/components/InspectorTabStrip.tsx", "onWheel", "vertical wheel input over the tab strip must navigate horizontal overflow");
```

- [ ] **Step 2: Run UI contracts and verify RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL on tab geometry/visibility assertions.

- [ ] **Step 3: Implement stable tab geometry**

Make each tab `flex: 0 0 auto` with bounded width. Make the title `flex: 1 1 auto`,
`min-width: 0` and ellipsized; keep close at `flex: 0 0 24px`. On activation and open,
call `scrollIntoView({ block: "nearest", inline: "nearest" })`. Translate vertical wheel
delta to `scrollLeft` only when pointer is inside the tab strip and horizontal overflow
exists.

- [ ] **Step 4: Run UI contracts and typecheck for GREEN**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the tab layout fix**

```bash
git add apps/desktop/src/components/InspectorTabStrip.tsx \
  apps/desktop/src/styles.css apps/desktop/scripts/check-ui-contract.mjs
git commit -m "fix(ui): keep inspector tabs readable"
```

### Task 5: Add visible and testable drag feedback

**Files:**
- Modify: `apps/desktop/src/lib/inspectorWorkspace.mjs`
- Modify: `apps/desktop/src/lib/inspectorWorkspace.ts`
- Modify: `apps/desktop/src/lib/inspectorWorkspace.test.mjs`
- Modify: `apps/desktop/src/components/InspectorTabStrip.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing drop-index tests**

Add a pure helper that returns insertion index and side from tab bounds and pointer x.

```js
test("drop geometry distinguishes before and after a tab midpoint", () => {
  const bounds = [
    { id: "a", left: 0, right: 100 },
    { id: "b", left: 100, right: 200 },
  ];
  assert.deepEqual(inspectorDropTarget(bounds, 120, "a"), { index: 0, tabId: "b", side: "before" });
  assert.deepEqual(inspectorDropTarget(bounds, 180, "a"), { index: 1, tabId: "b", side: "after" });
});
```

Also test pointers beyond the first/last tab and exclusion of the dragged source.

- [ ] **Step 2: Run reducer tests and verify RED**

Run: `cd apps/desktop && npm run test:inspector-workspace`

Expected: FAIL because `inspectorDropTarget` is not exported.

- [ ] **Step 3: Implement drop geometry and transient React state**

Add `draggingTabId`, `dropTarget` and threshold state. On pointer move after 6 px:

- set body class `dragging-inspector-tab`;
- compute target with the pure helper;
- scroll the strip when within 28 px of either edge;
- apply `dragging`, `drop-before` or `drop-after` classes;
- set `aria-grabbed` on the source.

On pointer up, emit exactly one `onMove` with the normalized insertion index. On click,
cancel, blur and unmount, clear pointer capture, body class and transient state.

- [ ] **Step 4: Add and satisfy drag UI contracts**

Require the semantic class names, `aria-grabbed`, window-blur cleanup and insertion-marker
CSS. Run `npm run test:ui-contract` first to observe RED, then implement the minimal CSS:

```css
.inspector-tab.dragging { opacity: 0.48; cursor: grabbing; }
.inspector-tab.drop-before::before,
.inspector-tab.drop-after::after { /* one-pixel accent insertion marker */ }
.dragging-inspector-tab,
.dragging-inspector-tab * { cursor: grabbing !important; user-select: none !important; }
```

- [ ] **Step 5: Run reducer, UI-contract and type tests for GREEN**

Run:

```bash
cd apps/desktop
npm run test:inspector-workspace
npm run test:ui-contract
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit drag feedback**

```bash
git add apps/desktop/src/lib/inspectorWorkspace.mjs \
  apps/desktop/src/lib/inspectorWorkspace.ts \
  apps/desktop/src/lib/inspectorWorkspace.test.mjs \
  apps/desktop/src/components/InspectorTabStrip.tsx \
  apps/desktop/src/styles.css apps/desktop/scripts/check-ui-contract.mjs
git commit -m "fix(ui): show inspector tab drag feedback"
```

### Task 6: Full verification and real-app proof

**Files:**
- Modify only if a verification exposes a defect.

- [ ] **Step 1: Run the full desktop gate**

```bash
cd apps/desktop
npm run test:inspector-stability
npm run test:inspector-workspace
npm run test:ui-contract
npm run test:electron
npm run typecheck
npm run build
```

Expected: snapshot tests pass, inspector reducer tests pass, Electron reports 22/22 or
the current complete count, typecheck exits 0 and Vite production build exits 0.

- [ ] **Step 2: Run repository hygiene checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional plan/checklist edits if still pending.

- [ ] **Step 3: Verify the running Electron app**

At wide, medium and narrow widths:

1. open at least eight tabs with short and long names;
2. confirm no title/close overlap;
3. scroll a long Markdown artifact below the fold;
4. wait at least ten seconds and confirm the exact scroll position and content remain;
5. switch away and back and confirm each tab preserves its position;
6. drag a tab across at least three positions and capture source opacity plus insertion line;
7. confirm the window itself does not move;
8. click, close, keyboard-reorder and use `Open tabs`;
9. resize into single-pane mode and return to split mode.

Expected: every interaction remains stable; no unsolicited `Carico…`, jump-to-top,
overlap, window drag or missing drag feedback.

- [ ] **Step 4: Re-run any touched gate after live fixes**

If live verification requires a change, add a failing regression contract/test first, apply
the minimal fix, then repeat Steps 1–3 completely.

- [ ] **Step 5: Commit final verification-only corrections**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/components/ChatView.tsx \
  apps/desktop/src/components/InspectorTabStrip.tsx apps/desktop/src/styles.css \
  apps/desktop/src/lib/uiSnapshot.mjs apps/desktop/src/lib/uiSnapshot.ts \
  apps/desktop/src/lib/uiSnapshot.test.mjs \
  apps/desktop/src/lib/inspectorWorkspace.mjs \
  apps/desktop/src/lib/inspectorWorkspace.ts \
  apps/desktop/src/lib/inspectorWorkspace.test.mjs \
  apps/desktop/scripts/check-ui-contract.mjs apps/desktop/package.json
git commit -m "fix(ui): finalize inspector interaction stability"
```

Skip this commit when no verification correction was necessary.
