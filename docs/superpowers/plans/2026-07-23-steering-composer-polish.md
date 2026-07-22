# Steering Composer Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present one compact active-turn indicator and compact queued steering strips above the composer without changing durable turn semantics.

**Architecture:** Keep `ChatView` as the composition owner, but mount active-turn state only in the composer stack. Keep `ActiveTurnStatus` and `PendingSteeringQueue` as focused presentational components; adjust their markup and CSS while reusing the existing steering mutation callbacks and state reducer.

**Tech Stack:** React 19, TypeScript, CSS, i18next, Node source-contract tests, Playwright over Electron CDP.

---

### Task 1: Lock the presentation contract

**Files:**
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`
- Test: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing assertions**

Require `ChatView.tsx` to omit `variant="assistant-footer"`, mount `ActiveTurnStatus` exactly once,
guard the transcript thinking state while `chatTurnState` exists, use
`chat.inspector.views.activity`, and expose the `pending-steering-strip` compact class.

- [ ] **Step 2: Run the contract and verify red**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL on the first new assertion because the current source still mounts the footer and
composer variants.

- [ ] **Step 3: Commit the red contract with the implementation only after green**

The red test is intentionally left uncommitted until Tasks 2 and 3 satisfy it.

### Task 2: Converge active-turn presentation

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/components/ActiveTurnStatus.tsx`
- Modify: `apps/desktop/src/styles.css`
- Test: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Remove transcript mounts**

Delete both `active-turn-tail` blocks and suppress `AssistantThinkingState` for the empty streaming
placeholder whenever `chatTurnState` already owns visible progress.

- [ ] **Step 2: Simplify the component contract**

Remove the `variant` prop, render only the current phase, hide attempt 1, use
`chat.inspector.views.activity`, and keep `stillWorking` as the accessible label.

- [ ] **Step 3: Style the composer pill**

Make `.active-turn-status` content-width, rounded and bordered; retain teal progress, elapsed time,
activity count and stop without full-width separators.

- [ ] **Step 4: Run focused gates**

Run: `cd apps/desktop && npm run test:ui-contract && npm run typecheck`

Expected: active-turn assertions pass; steering assertion remains red until Task 3.

### Task 3: Replace steering cards with strips

**Files:**
- Modify: `apps/desktop/src/components/PendingSteeringQueue.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/src/styles.css`
- Test: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add the request label in every locale**

Add `chat.steeringRequest` with localized equivalents of Request/Richiesta.

- [ ] **Step 2: Flatten non-editing markup**

Use one `pending-steering-strip` row with route icon, ellipsized prompt, status/position and icon-only
actions. Keep the edit form and attachment names as optional expanded rows.

- [ ] **Step 3: Replace vertical-card CSS**

Use a compact grid/flex strip, visible focus states and bounded scrolling for multiple requests.

- [ ] **Step 4: Complete TDD green**

Run: `cd apps/desktop && npm run test:ui-contract && npm run test:electron && npm run build`

Expected: all commands exit 0; no translation key is rendered literally.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/desktop
git commit -m "fix(desktop): unify active turn and steering controls"
```

### Task 4: Package and visually verify

**Files:**
- Modify only if a verified defect is found.
- Test artifacts: temporary screenshots outside the repository unless promoted as QA evidence.

- [ ] **Step 1: Run the complete local gate**

Run: `python3 scripts/pre_release_gate.py`

Expected: `== ALL GREEN ==` with explicit skips reported, not counted as live coverage.

- [ ] **Step 2: Build the macOS package**

Run from `apps/desktop`: `npm run dist` using the existing local signing environment.

Expected: a signed arm64 `homun.app` candidate with the modified renderer.

- [ ] **Step 3: Run Electron CDP QA**

Launch the candidate with a local remote-debugging port, enqueue a long prompt and a quick steer,
then assert one `.active-turn-status`, zero `.active-turn-tail`, one `.pending-steering-strip`, no
literal `chat.inspector.activity`, and no pending prompt in the transcript.

- [ ] **Step 4: Verify wide and compact screenshots**

Capture 1360x900 and 900x700. Expected: composer reachable, strip single-line, no overlap or document
overflow, stable selected chat.

### Task 5: Integrate, release, install and retest

**Files:**
- No source files unless the packaged QA finds a defect.

- [ ] **Step 1: Merge the verified branch to `main` and rerun the release gate**

Expected: clean `main`, full gate exit 0 on the exact release commit.

- [ ] **Step 2: Tag the next patch release**

Determine the latest remote tag and create the next annotated `v0.1.x` tag; push `main` then the tag.

- [ ] **Step 3: Audit CI and the draft release**

Require green CI/container/native jobs, signed+notarized macOS verification, signed Windows build,
10 expected assets and updater manifests stamped to the new version.

- [ ] **Step 4: Publish, install and rerun live QA**

Publish the draft as latest, verify the official DMG digest/signature/notarization, atomically update
`/Applications/homun.app`, and repeat the CDP assertions/screenshots on the installed application.

- [ ] **Step 5: Clean up the merged worktree**

Remove only `fabio/steering-composer-polish` after its commits are reachable from `main` and the
installed release is verified.
