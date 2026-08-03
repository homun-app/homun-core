# Turn Lifecycle Chat Rendering Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate Homun's turn lifecycle and chat rendering contracts so terminal, waiting-user, reasoning visibility, resume, steering, and composer states are owned by explicit test-covered modules instead of scattered UI/gateway inference.

**Architecture:** Start by freezing the current dirty worktree into named slices, then extract pure frontend view models and visible-content functions before changing behavior. Durable lifecycle cleanup follows in Rust once frontend tests pin observed behavior, then Electron smoke verifies the actual desktop flow.

**Tech Stack:** Rust workspace crates (`task-runtime`, `desktop-gateway`, `engine`), Electron/Vite React desktop app, TypeScript/JavaScript pure-node tests, Cargo tests, npm build and UI contract tests.

---

## Required Starting Point

Run from:

```bash
cd /Users/fabio/Projects/Homun/app
```

Read first:

- `docs/superpowers/specs/2026-08-03-turn-lifecycle-chat-rendering-consolidation-design.md`
- `apps/desktop/src/components/ChatView.tsx`
- `apps/desktop/src/lib/chatVisibleContent.ts`
- `apps/desktop/src/lib/chatVisibleContent.mjs`
- `apps/desktop/src/lib/markers.ts`
- `apps/desktop/src/lib/composerTurnContract.ts`
- `apps/desktop/src/lib/composerTurnContract.mjs`
- `apps/desktop/src/lib/chatSteeringState.ts`
- `apps/desktop/src/lib/chatSteeringState.mjs`
- `crates/task-runtime/src/types.rs`
- `crates/task-runtime/src/store.rs`
- `crates/desktop-gateway/src/main.rs`
- `crates/desktop-gateway/src/chat_store.rs`
- `crates/desktop-gateway/src/execution_projection.rs`
- `crates/desktop-gateway/src/turn_executor.rs`
- `crates/desktop-gateway/src/ws_gateway.rs`

Do not revert unrelated worktree changes. If a file has changes not made in this plan, inspect the diff and preserve them.

## Target File Structure

Create these focused frontend modules:

```text
apps/desktop/src/lib/chat-runtime/
  lifecycle.ts
  lifecycle.mjs
  lifecycle.test.mjs
  composerMode.ts
  composerMode.mjs
  composerMode.test.mjs
  steering.ts
  steering.mjs
  steering.test.mjs
  resume.ts
  resume.mjs
  resume.test.mjs

apps/desktop/src/lib/chat-rendering/
  visibleContent.ts
  visibleContent.mjs
  visibleContent.test.mjs
```

Add Rust lifecycle helpers:

```text
crates/task-runtime/src/turn_lifecycle.rs
```

Keep Rust gateway module extraction as a later step after behavior is pinned; `crates/desktop-gateway/src/main.rs` is currently highly coupled and should not be split before tests prove the seams.

---

### Task 1: Worktree Inventory and Slice Boundaries

**Files:**
- Read: all dirty files from `git status --short`
- Modify: none
- Test: none

- [ ] **Step 1: Capture the dirty worktree**

Run:

```bash
git status --short
```

Expected: a list of modified files. Save the list in the task notes. Do not stage anything.

- [ ] **Step 2: Classify dirty files into slices**

Run:

```bash
git diff --name-only
```

Expected: paths grouped into these buckets:

```text
chat-lifecycle-rendering:
  apps/desktop/src/components/ChatView.tsx
  apps/desktop/src/components/ActiveTurnStatus.tsx
  apps/desktop/src/components/ComposerShell.tsx
  apps/desktop/src/lib/composerTurnContract.*
  apps/desktop/src/lib/chatVisibleContent.*
  apps/desktop/src/lib/markers.ts
  apps/desktop/src/styles/chat.css
  apps/desktop/src/styles/composer.css

browser-computer-workspace:
  apps/desktop/src/styles/workspace-island.css
  apps/desktop/tests/adaptive-workspace-island-ui.test.mjs
  crates/engine/src/agent_loop.rs

runtime-model-context:
  apps/desktop/src/components/RuntimeContextPanel.tsx
  crates/desktop-gateway/src/model_client.rs
  crates/desktop-gateway/src/runtime_context.rs

durable-turn-runtime:
  crates/task-runtime/src/broker.rs
  crates/task-runtime/src/store.rs
  crates/desktop-gateway/src/chat_store.rs
  crates/desktop-gateway/src/execution_projection.rs
  crates/desktop-gateway/src/main.rs

docs:
  docs/README.md
  docs/STATO.md
  docs/testing/anti-regression-protocol.md
```

If the actual list differs, update the bucket notes before continuing.

- [ ] **Step 3: Commit nothing**

Run:

```bash
git diff --cached --name-only
```

Expected: no output. If output appears, unstage only those paths with:

```bash
git restore --staged docs/superpowers/plans/2026-08-03-turn-lifecycle-chat-rendering-consolidation.md
```

Do not restore file contents.

---

### Task 2: Frontend Lifecycle Classifier

**Files:**
- Create: `apps/desktop/src/lib/chat-runtime/lifecycle.mjs`
- Create: `apps/desktop/src/lib/chat-runtime/lifecycle.ts`
- Create: `apps/desktop/src/lib/chat-runtime/lifecycle.test.mjs`
- Modify later: `apps/desktop/src/components/ChatView.tsx`

- [ ] **Step 1: Write failing lifecycle tests**

Create `apps/desktop/src/lib/chat-runtime/lifecycle.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTurnLifecycle,
  TERMINAL_TURN_STATUSES,
} from "./lifecycle.mjs";

test("terminal projected turn at rest clears active work", () => {
  const result = deriveTurnLifecycle({
    promptSubmitting: false,
    streamingAssistantId: null,
    projectedActiveTurn: null,
    projectedTurnStatus: "completed",
    projectionLoaded: true,
    threadTailAwaitsHitl: false,
  });

  assert.equal(result.terminalTurnAtRest, true);
  assert.equal(result.hasActiveTurn, false);
  assert.equal(result.workInProgress, false);
  assert.equal(result.turnAwaitingUser, false);
  assert.equal(result.canStop, false);
});

test("waiting user is active but not model work", () => {
  const result = deriveTurnLifecycle({
    promptSubmitting: false,
    streamingAssistantId: null,
    projectedActiveTurn: {
      turn_id: "turn_waiting",
      status: "waiting_user_approval",
      updated_at: 10,
      attempt: 1,
      max_attempts: 1,
      last_event_seq: 4,
      not_before: null,
      blocked_reason: null,
    },
    projectedTurnStatus: "waiting_user_approval",
    projectionLoaded: true,
    threadTailAwaitsHitl: false,
  });

  assert.equal(result.hasActiveTurn, true);
  assert.equal(result.workInProgress, false);
  assert.equal(result.turnAwaitingUser, true);
  assert.equal(result.canStop, false);
});

test("streaming local state is work even before projection arrives", () => {
  const result = deriveTurnLifecycle({
    promptSubmitting: true,
    streamingAssistantId: null,
    projectedActiveTurn: null,
    projectedTurnStatus: null,
    projectionLoaded: false,
    threadTailAwaitsHitl: false,
  });

  assert.equal(result.hasActiveTurn, true);
  assert.equal(result.workInProgress, true);
  assert.equal(result.terminalTurnAtRest, false);
  assert.equal(result.canStop, true);
});

test("terminal status set is explicit", () => {
  assert.deepEqual([...TERMINAL_TURN_STATUSES].sort(), [
    "cancelled",
    "completed",
    "expired",
    "failed",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test apps/desktop/src/lib/chat-runtime/lifecycle.test.mjs
```

Expected: FAIL because `lifecycle.mjs` does not exist.

- [ ] **Step 3: Implement lifecycle module**

Create `apps/desktop/src/lib/chat-runtime/lifecycle.mjs`:

```js
export const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export function deriveTurnLifecycle(input) {
  const isStreaming = Boolean(input.promptSubmitting || input.streamingAssistantId);
  const threadTailAwaitsHitl = Boolean(input.threadTailAwaitsHitl);
  const activeStatus = input.projectedActiveTurn?.status ?? null;
  const turnAwaitingUser = activeStatus === "waiting_user_approval" || threadTailAwaitsHitl;
  const terminalTurnAtRest = Boolean(
    input.projectionLoaded
      && !input.projectedActiveTurn
      && input.projectedTurnStatus !== null
      && TERMINAL_TURN_STATUSES.has(input.projectedTurnStatus),
  );
  const hasActiveTurn = Boolean(isStreaming || input.projectedActiveTurn || threadTailAwaitsHitl);
  const workInProgress = Boolean(isStreaming || (input.projectedActiveTurn && !turnAwaitingUser));
  const canStop = Boolean(isStreaming || (input.projectedActiveTurn && !turnAwaitingUser));

  return {
    isStreaming,
    threadTailAwaitsHitl,
    turnAwaitingUser,
    terminalTurnAtRest,
    hasActiveTurn,
    workInProgress,
    canStop,
  };
}
```

Create `apps/desktop/src/lib/chat-runtime/lifecycle.ts`:

```ts
export interface ActiveTurnProjectionLike {
  turn_id: string;
  status: string;
  updated_at?: number;
  attempt?: number;
  max_attempts?: number;
  last_event_seq?: number;
  not_before?: number | null;
  blocked_reason?: string | null;
}

export interface TurnLifecycleInput {
  promptSubmitting: boolean;
  streamingAssistantId: string | null;
  projectedActiveTurn: ActiveTurnProjectionLike | null;
  projectedTurnStatus: string | null;
  projectionLoaded: boolean;
  threadTailAwaitsHitl: boolean;
}

export interface TurnLifecycleView {
  isStreaming: boolean;
  threadTailAwaitsHitl: boolean;
  turnAwaitingUser: boolean;
  terminalTurnAtRest: boolean;
  hasActiveTurn: boolean;
  workInProgress: boolean;
  canStop: boolean;
}

export const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export function deriveTurnLifecycle(input: TurnLifecycleInput): TurnLifecycleView {
  const isStreaming = Boolean(input.promptSubmitting || input.streamingAssistantId);
  const threadTailAwaitsHitl = Boolean(input.threadTailAwaitsHitl);
  const activeStatus = input.projectedActiveTurn?.status ?? null;
  const turnAwaitingUser = activeStatus === "waiting_user_approval" || threadTailAwaitsHitl;
  const terminalTurnAtRest = Boolean(
    input.projectionLoaded
      && !input.projectedActiveTurn
      && input.projectedTurnStatus !== null
      && TERMINAL_TURN_STATUSES.has(input.projectedTurnStatus),
  );
  const hasActiveTurn = Boolean(isStreaming || input.projectedActiveTurn || threadTailAwaitsHitl);
  const workInProgress = Boolean(isStreaming || (input.projectedActiveTurn && !turnAwaitingUser));
  const canStop = Boolean(isStreaming || (input.projectedActiveTurn && !turnAwaitingUser));

  return {
    isStreaming,
    threadTailAwaitsHitl,
    turnAwaitingUser,
    terminalTurnAtRest,
    hasActiveTurn,
    workInProgress,
    canStop,
  };
}
```

- [ ] **Step 4: Verify lifecycle test passes**

Run:

```bash
node --test apps/desktop/src/lib/chat-runtime/lifecycle.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/desktop/src/lib/chat-runtime/lifecycle.mjs apps/desktop/src/lib/chat-runtime/lifecycle.ts apps/desktop/src/lib/chat-runtime/lifecycle.test.mjs
git commit -m "test(chat): pin turn lifecycle view model"
```

---

### Task 3: Pending Steering Visibility View Model

**Files:**
- Create: `apps/desktop/src/lib/chat-runtime/steering.mjs`
- Create: `apps/desktop/src/lib/chat-runtime/steering.ts`
- Create: `apps/desktop/src/lib/chat-runtime/steering.test.mjs`
- Modify later: `apps/desktop/src/components/ChatView.tsx`

- [ ] **Step 1: Write failing steering tests**

Create `apps/desktop/src/lib/chat-runtime/steering.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  STALE_STEERING_STATUSES,
  visiblePendingSteeringRows,
} from "./steering.mjs";

test("terminal turn hides stale steering rows", () => {
  const rows = [
    { steering_id: 1, status: "pending" },
    { steering_id: 2, status: "claimed" },
    { steering_id: 3, status: "interpreted" },
    { steering_id: 4, status: "applied" },
    { steering_id: 5, status: "completed" },
    { steering_id: 6, status: "cancelled" },
  ];

  assert.deepEqual(
    visiblePendingSteeringRows(rows, { terminalTurnAtRest: true }).map((row) => row.steering_id),
    [1],
  );
});

test("active turn keeps all rows visible for truthful progress", () => {
  const rows = [
    { steering_id: 1, status: "pending" },
    { steering_id: 2, status: "applied" },
  ];

  assert.deepEqual(
    visiblePendingSteeringRows(rows, { terminalTurnAtRest: false }).map((row) => row.steering_id),
    [1, 2],
  );
});

test("stale steering status set is explicit", () => {
  assert.deepEqual([...STALE_STEERING_STATUSES].sort(), [
    "applied",
    "cancelled",
    "claimed",
    "completed",
    "interpreted",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test apps/desktop/src/lib/chat-runtime/steering.test.mjs
```

Expected: FAIL because `steering.mjs` does not exist.

- [ ] **Step 3: Implement steering module**

Create `apps/desktop/src/lib/chat-runtime/steering.mjs`:

```js
export const STALE_STEERING_STATUSES = new Set([
  "claimed",
  "interpreted",
  "applied",
  "completed",
  "cancelled",
]);

export function visiblePendingSteeringRows(rows, options) {
  if (!options.terminalTurnAtRest) return rows;
  return rows.filter((row) => !STALE_STEERING_STATUSES.has(row.status));
}
```

Create `apps/desktop/src/lib/chat-runtime/steering.ts`:

```ts
export interface SteeringRowLike {
  status: string;
}

export const STALE_STEERING_STATUSES = new Set([
  "claimed",
  "interpreted",
  "applied",
  "completed",
  "cancelled",
]);

export function visiblePendingSteeringRows<Row extends SteeringRowLike>(
  rows: Row[],
  options: { terminalTurnAtRest: boolean },
): Row[] {
  if (!options.terminalTurnAtRest) return rows;
  return rows.filter((row) => !STALE_STEERING_STATUSES.has(row.status));
}
```

- [ ] **Step 4: Verify steering test passes**

Run:

```bash
node --test apps/desktop/src/lib/chat-runtime/steering.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/desktop/src/lib/chat-runtime/steering.mjs apps/desktop/src/lib/chat-runtime/steering.ts apps/desktop/src/lib/chat-runtime/steering.test.mjs
git commit -m "test(chat): pin steering visibility state"
```

---

### Task 4: Composer Mode View Model

**Files:**
- Create: `apps/desktop/src/lib/chat-runtime/composerMode.mjs`
- Create: `apps/desktop/src/lib/chat-runtime/composerMode.ts`
- Create: `apps/desktop/src/lib/chat-runtime/composerMode.test.mjs`
- Modify later: `apps/desktop/src/components/ChatView.tsx`

- [ ] **Step 1: Write failing composer tests**

Create `apps/desktop/src/lib/chat-runtime/composerMode.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { deriveComposerMode } from "./composerMode.mjs";

test("terminal turn starts a new turn instead of steering", () => {
  assert.equal(
    deriveComposerMode({
      promptSubmitting: false,
      streamingAssistantId: null,
      turnAwaitingUser: false,
      terminalTurnAtRest: true,
      hasActiveTurn: false,
    }).mode,
    "new_turn",
  );
});

test("waiting user reply is not treated as generic steering", () => {
  assert.equal(
    deriveComposerMode({
      promptSubmitting: false,
      streamingAssistantId: null,
      turnAwaitingUser: true,
      terminalTurnAtRest: false,
      hasActiveTurn: true,
    }).mode,
    "waiting_user_reply",
  );
});

test("active model work routes input as steering", () => {
  assert.equal(
    deriveComposerMode({
      promptSubmitting: false,
      streamingAssistantId: "assistant-1",
      turnAwaitingUser: false,
      terminalTurnAtRest: false,
      hasActiveTurn: true,
    }).mode,
    "steering",
  );
});

test("local submit disables duplicate send", () => {
  assert.equal(
    deriveComposerMode({
      promptSubmitting: true,
      streamingAssistantId: null,
      turnAwaitingUser: false,
      terminalTurnAtRest: false,
      hasActiveTurn: true,
    }).disabled,
    true,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test apps/desktop/src/lib/chat-runtime/composerMode.test.mjs
```

Expected: FAIL because `composerMode.mjs` does not exist.

- [ ] **Step 3: Implement composer module**

Create `apps/desktop/src/lib/chat-runtime/composerMode.mjs`:

```js
export function deriveComposerMode(input) {
  if (input.promptSubmitting) {
    return { mode: "disabled", disabled: true, forceNewTurn: false };
  }
  if (input.turnAwaitingUser) {
    return { mode: "waiting_user_reply", disabled: false, forceNewTurn: true };
  }
  if (input.terminalTurnAtRest || !input.hasActiveTurn) {
    return { mode: "new_turn", disabled: false, forceNewTurn: true };
  }
  if (input.streamingAssistantId || input.hasActiveTurn) {
    return { mode: "steering", disabled: false, forceNewTurn: false };
  }
  return { mode: "new_turn", disabled: false, forceNewTurn: true };
}
```

Create `apps/desktop/src/lib/chat-runtime/composerMode.ts`:

```ts
export type ComposerMode = "new_turn" | "steering" | "waiting_user_reply" | "disabled";

export interface ComposerModeInput {
  promptSubmitting: boolean;
  streamingAssistantId: string | null;
  turnAwaitingUser: boolean;
  terminalTurnAtRest: boolean;
  hasActiveTurn: boolean;
}

export interface ComposerModeView {
  mode: ComposerMode;
  disabled: boolean;
  forceNewTurn: boolean;
}

export function deriveComposerMode(input: ComposerModeInput): ComposerModeView {
  if (input.promptSubmitting) {
    return { mode: "disabled", disabled: true, forceNewTurn: false };
  }
  if (input.turnAwaitingUser) {
    return { mode: "waiting_user_reply", disabled: false, forceNewTurn: true };
  }
  if (input.terminalTurnAtRest || !input.hasActiveTurn) {
    return { mode: "new_turn", disabled: false, forceNewTurn: true };
  }
  if (input.streamingAssistantId || input.hasActiveTurn) {
    return { mode: "steering", disabled: false, forceNewTurn: false };
  }
  return { mode: "new_turn", disabled: false, forceNewTurn: true };
}
```

- [ ] **Step 4: Verify composer test passes**

Run:

```bash
node --test apps/desktop/src/lib/chat-runtime/composerMode.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/desktop/src/lib/chat-runtime/composerMode.mjs apps/desktop/src/lib/chat-runtime/composerMode.ts apps/desktop/src/lib/chat-runtime/composerMode.test.mjs
git commit -m "test(chat): pin composer turn modes"
```

---

### Task 5: Unify Visible Content API

**Files:**
- Create: `apps/desktop/src/lib/chat-rendering/visibleContent.mjs`
- Create: `apps/desktop/src/lib/chat-rendering/visibleContent.ts`
- Create: `apps/desktop/src/lib/chat-rendering/visibleContent.test.mjs`
- Read/possibly modify: `apps/desktop/src/lib/chatVisibleContent.mjs`
- Read/possibly modify: `apps/desktop/src/lib/markers.ts`

- [ ] **Step 1: Write failing visible-content tests**

Create `apps/desktop/src/lib/chat-rendering/visibleContent.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { visibleAssistantText } from "./visibleContent.mjs";

test("persisted reasoning marker is removed from visible answer", () => {
  const input = "Prima. ‹‹REASONING››raw chain‹‹/REASONING›› Dopo.";
  assert.equal(visibleAssistantText(input), "Prima.  Dopo.");
});

test("closed think block is removed from visible answer", () => {
  const input = "Risposta <think>secret</think> finale";
  assert.equal(visibleAssistantText(input), "Risposta  finale");
});

test("unterminated think block is hidden while streaming", () => {
  const input = "Risposta visibile <think>secret still streaming";
  assert.equal(visibleAssistantText(input), "Risposta visibile");
});

test("weak model prose tool call is removed", () => {
  const input = "Prima <tool_call name=\"browse\">{\"q\":\"x\"}</tool_call> Dopo";
  assert.equal(visibleAssistantText(input), "Prima  Dopo");
});

test("unterminated weak model prose tool call is removed to end", () => {
  const input = "Prima <tool_call name=\"browse\">{\"q\":\"x\"}";
  assert.equal(visibleAssistantText(input), "Prima");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test apps/desktop/src/lib/chat-rendering/visibleContent.test.mjs
```

Expected: FAIL because `visibleContent.mjs` does not exist.

- [ ] **Step 3: Implement visible-content module**

Create `apps/desktop/src/lib/chat-rendering/visibleContent.mjs`:

```js
const REASONING_MARKER_RE = /‹‹REASONING››[\s\S]*?‹‹\/REASONING››/g;
const STRAY_REASONING_MARKER_RE = /‹{1,2}\/?REASONING››/g;
const THINK_RE = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
const THINK_OPEN_RE = /<think(?:ing)?>[\s\S]*$/i;
const LEAKED_TOOLCALL_RE = /<tool_call\b[\s\S]*?(?:<\/tool_call>|$)/gi;
const STRUCTURED_MARKER_RE =
  /‹‹(?:COMPOSIO_(?:CONFIRM|DONE|RECONNECT)|MCP_CONFIRM|FS_AUTHORIZE|SANDBOX_ESCALATE|SANDBOX_READONLY|CONNECT_SUGGEST|VAULT_PROPOSE|VAULT_REVEAL|PAYMENT_APPROVAL|CHOICES|CLARIFY|AWAIT_USER|PLAN_PROPOSE|GOAL_PROPOSE|PLAN|ACT|ARTIFACT|DIFF)››[\s\S]*?‹‹\/(?:COMPOSIO_(?:CONFIRM|DONE|RECONNECT)|MCP_CONFIRM|FS_AUTHORIZE|SANDBOX_ESCALATE|SANDBOX_READONLY|CONNECT_SUGGEST|VAULT_PROPOSE|VAULT_REVEAL|PAYMENT_APPROVAL|CHOICES|CLARIFY|AWAIT_USER|PLAN_PROPOSE|GOAL_PROPOSE|PLAN|ACT|ARTIFACT|DIFF)››/g;
const UNCLOSED_STRUCTURED_MARKER_RE =
  /‹‹(?:REASONING|COMPOSIO_CONFIRM|COMPOSIO_DONE|COMPOSIO_RECONNECT|MCP_CONFIRM|FS_AUTHORIZE|SANDBOX_ESCALATE|SANDBOX_READONLY|CONNECT_SUGGEST|VAULT_PROPOSE|VAULT_REVEAL|PAYMENT_APPROVAL|CHOICES|CLARIFY|AWAIT_USER|PLAN_PROPOSE|GOAL_PROPOSE|PLAN|ACT|ARTIFACT|DIFF)››[\s\S]*$/;

export function visibleAssistantText(text = "") {
  return text
    .replace(REASONING_MARKER_RE, "")
    .replace(THINK_RE, "")
    .replace(THINK_OPEN_RE, "")
    .replace(LEAKED_TOOLCALL_RE, "")
    .replace(STRUCTURED_MARKER_RE, "")
    .replace(UNCLOSED_STRUCTURED_MARKER_RE, "")
    .replace(STRAY_REASONING_MARKER_RE, "")
    .trim();
}
```

Create `apps/desktop/src/lib/chat-rendering/visibleContent.ts`:

```ts
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./visibleContent.mjs";

export const visibleAssistantText = implementation.visibleAssistantText as (text?: string) => string;
```

- [ ] **Step 4: Verify visible-content test passes**

Run:

```bash
node --test apps/desktop/src/lib/chat-rendering/visibleContent.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/desktop/src/lib/chat-rendering/visibleContent.mjs apps/desktop/src/lib/chat-rendering/visibleContent.ts apps/desktop/src/lib/chat-rendering/visibleContent.test.mjs
git commit -m "test(chat): pin visible assistant content"
```

---

### Task 6: Wire ChatView to Pure Frontend View Models

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify only if needed: `apps/desktop/src/lib/composerTurnContract.ts`
- Test: tests from Tasks 2, 3, 4, 5

- [ ] **Step 1: Inspect existing dirty diff before editing**

Run:

```bash
git diff -- apps/desktop/src/components/ChatView.tsx
```

Expected: inspect current user/agent edits. Preserve unrelated changes.

- [ ] **Step 2: Replace inline lifecycle constants/imports**

Modify the imports in `apps/desktop/src/components/ChatView.tsx` to include:

```ts
import { deriveTurnLifecycle } from "../lib/chat-runtime/lifecycle";
import { deriveComposerMode } from "../lib/chat-runtime/composerMode";
import { visiblePendingSteeringRows } from "../lib/chat-runtime/steering";
```

Remove local duplicate terminal or stale status sets only after all references compile.

- [ ] **Step 3: Replace inline lifecycle derivation**

Replace the block deriving `isStreaming`, `turnAwaitingUser`, `hasActiveTurn`, `workInProgress`, `terminalTurnAtRest`, and `visiblePendingSteeringRows` with:

```ts
const lifecycleView = deriveTurnLifecycle({
  promptSubmitting,
  streamingAssistantId,
  projectedActiveTurn,
  projectedTurnStatus,
  projectionLoaded,
  threadTailAwaitsHitl,
});
const {
  isStreaming,
  turnAwaitingUser,
  hasActiveTurn,
  workInProgress,
  terminalTurnAtRest,
} = lifecycleView;
const visiblePendingSteeringRowsForTurn = useMemo(
  () => visiblePendingSteeringRows(pendingSteering.rows, { terminalTurnAtRest }),
  [pendingSteering.rows, terminalTurnAtRest],
);
```

Then update the prop site that currently passes `visiblePendingSteeringRows` so it passes `visiblePendingSteeringRowsForTurn`.

- [ ] **Step 4: Replace composer force-new-turn decision**

At the existing submit path, derive:

```ts
const composerMode = deriveComposerMode({
  promptSubmitting,
  streamingAssistantId,
  turnAwaitingUser,
  terminalTurnAtRest,
  hasActiveTurn,
});
const forceNewTurn = Boolean(options?.forceNewTurn || composerMode.forceNewTurn);
```

Expected: waiting-user replies and terminal-at-rest both force a new/resume-safe path, while active model work remains steering.

- [ ] **Step 5: Run frontend tests**

Run:

```bash
node --test \
  apps/desktop/src/lib/chat-runtime/lifecycle.test.mjs \
  apps/desktop/src/lib/chat-runtime/steering.test.mjs \
  apps/desktop/src/lib/chat-runtime/composerMode.test.mjs \
  apps/desktop/src/lib/chat-rendering/visibleContent.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Run TypeScript/build gate**

Run:

```bash
npm run build
```

Expected: build completes successfully.

- [ ] **Step 7: Commit**

Run:

```bash
git add apps/desktop/src/components/ChatView.tsx apps/desktop/src/lib/chat-runtime apps/desktop/src/lib/chat-rendering
git commit -m "refactor(chat): derive turn UI state from view models"
```

---

### Task 7: Rust Turn Lifecycle Classifier

**Files:**
- Create: `crates/task-runtime/src/turn_lifecycle.rs`
- Modify: `crates/task-runtime/src/lib.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Test: Rust unit tests in `turn_lifecycle.rs` or `store.rs`

- [ ] **Step 1: Write lifecycle classifier tests**

Create `crates/task-runtime/src/turn_lifecycle.rs` with tests first:

```rust
use crate::TaskStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnLifecycleClass {
    ActiveWork,
    WaitingUser,
    Parked,
    Terminal,
    InternalFinalizing,
}

pub fn classify_task_status(status: &str) -> TurnLifecycleClass {
    match status {
        "completed" | "failed" | "cancelled" | "expired" => TurnLifecycleClass::Terminal,
        "finalizing" => TurnLifecycleClass::InternalFinalizing,
        "waiting_user_approval" => TurnLifecycleClass::WaitingUser,
        "parked" => TurnLifecycleClass::Parked,
        _ => TurnLifecycleClass::ActiveWork,
    }
}

pub fn task_status_is_terminal(status: TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Expired
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_terminal_statuses() {
        for status in ["completed", "failed", "cancelled", "expired"] {
            assert_eq!(classify_task_status(status), TurnLifecycleClass::Terminal);
        }
    }

    #[test]
    fn classifies_waiting_parked_and_finalizing() {
        assert_eq!(
            classify_task_status("waiting_user_approval"),
            TurnLifecycleClass::WaitingUser
        );
        assert_eq!(classify_task_status("parked"), TurnLifecycleClass::Parked);
        assert_eq!(
            classify_task_status("finalizing"),
            TurnLifecycleClass::InternalFinalizing
        );
    }

    #[test]
    fn unknown_non_terminal_statuses_are_active_work() {
        assert_eq!(classify_task_status("running"), TurnLifecycleClass::ActiveWork);
        assert_eq!(classify_task_status("queued"), TurnLifecycleClass::ActiveWork);
    }
}
```

- [ ] **Step 2: Export module**

Modify `crates/task-runtime/src/lib.rs`:

```rust
pub mod turn_lifecycle;
```

- [ ] **Step 3: Run classifier tests**

Run:

```bash
cargo test -p local-first-task-runtime turn_lifecycle
```

Expected: PASS.

- [ ] **Step 4: Use classifier in activity projection**

Modify `crates/task-runtime/src/store.rs` where active turn excludes terminal/finalizing statuses:

```rust
if matches!(
    crate::turn_lifecycle::classify_task_status(status.as_str()),
    crate::turn_lifecycle::TurnLifecycleClass::Terminal
        | crate::turn_lifecycle::TurnLifecycleClass::InternalFinalizing
) {
    return None;
}
```

- [ ] **Step 5: Verify task runtime**

Run:

```bash
cargo test -p local-first-task-runtime project_thread_activity turn_lifecycle
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add crates/task-runtime/src/turn_lifecycle.rs crates/task-runtime/src/lib.rs crates/task-runtime/src/store.rs
git commit -m "refactor(runtime): centralize turn lifecycle classification"
```

---

### Task 8: Durable Stale Steering Cleanup

**Files:**
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: existing desktop-gateway tests near steering finalization

- [ ] **Step 1: Write failing store-level test**

Add a test in `crates/task-runtime/src/store.rs` near existing turn steering tests:

```rust
#[test]
fn terminal_turn_stale_steering_can_be_closed_by_turn_owner() {
    let store = test_store();
    let user = UserId::new("u");
    let workspace = WorkspaceId::new("w");
    let thread_id = "thread_stale_steering";
    let turn_id = "turn_stale_steering";

    let pending = NewTurnSteering {
        source_message_id: "msg_pending".to_string(),
        prompt: "pending".to_string(),
        payload: serde_json::json!({}),
    };
    let applied = NewTurnSteering {
        source_message_id: "msg_applied".to_string(),
        prompt: "applied".to_string(),
        payload: serde_json::json!({}),
    };

    let pending = store
        .append_turn_steering(user.as_str(), workspace.as_str(), thread_id, turn_id, &pending, 1)
        .unwrap();
    let applied = store
        .append_turn_steering(user.as_str(), workspace.as_str(), thread_id, turn_id, &applied, 1)
        .unwrap();
    let claimed = store
        .claim_pending_turn_steering(user.as_str(), workspace.as_str(), thread_id, turn_id, "run", 1)
        .unwrap();
    let applied_row = claimed
        .into_iter()
        .find(|row| row.steering_id == applied.steering_id)
        .unwrap();
    let interpreted = store
        .mark_turn_steering_interpreted(applied_row.steering_id, applied_row.revision, &serde_json::json!({ "decision": "apply" }), "run")
        .unwrap();
    store
        .mark_turn_steering_applied(interpreted.steering_id, interpreted.revision, "run")
        .unwrap();

    let closed = store
        .close_unsettled_turn_steering(user.as_str(), workspace.as_str(), thread_id, turn_id)
        .unwrap();

    assert!(closed >= 2);
    let rows = store
        .list_turn_steering(user.as_str(), workspace.as_str(), thread_id)
        .unwrap();
    assert!(rows.iter().all(|row| {
        row.status.as_str() == "completed" || row.status.as_str() == "cancelled"
    }));
}
```

If local helper names differ, use the existing test-store helper names from `store.rs`; do not invent a second test harness.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p local-first-task-runtime terminal_turn_stale_steering_can_be_closed_by_turn_owner
```

Expected: FAIL because `close_unsettled_turn_steering` does not exist.

- [ ] **Step 3: Implement store helper**

Add to `impl TaskStore` in `crates/task-runtime/src/store.rs`:

```rust
pub fn close_unsettled_turn_steering(
    &self,
    user_id: &str,
    workspace_id: &str,
    thread_id: &str,
    active_turn_id: &str,
) -> TaskRuntimeResult<usize> {
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let changed = self.connection.execute(
        "UPDATE turn_steering
         SET status='cancelled', cancelled_at=COALESCE(cancelled_at, ?1), updated_at=?1,
             revision=revision+1
         WHERE user_id=?2 AND workspace_id=?3 AND thread_id=?4 AND active_turn_id=?5
           AND status IN ('pending','held','claimed','interpreted','applied')",
        params![now, user_id, workspace_id, thread_id, active_turn_id],
    )?;
    Ok(changed)
}
```

- [ ] **Step 4: Update gateway finalization cleanup**

Modify `finalize_turn_steering` in `crates/desktop-gateway/src/main.rs` to call `close_unsettled_turn_steering` once, then publish changed rows if needed. If the current publish API needs full row records, reload rows before and after:

```rust
let before = store.list_turn_steering(user_id, workspace_id, thread_id).unwrap_or_default();
let _ = store.close_unsettled_turn_steering(user_id, workspace_id, thread_id, turn_id);
let after = store.list_turn_steering(user_id, workspace_id, thread_id).unwrap_or_default();
for record in after {
    if record.active_turn_id == turn_id
        && before.iter().any(|old| old.steering_id == record.steering_id && old.status != record.status)
    {
        publish_steering_changed(&record);
    }
}
```

Keep the existing best-effort non-fatal behavior.

- [ ] **Step 5: Run Rust verification**

Run:

```bash
cargo test -p local-first-task-runtime terminal_turn_stale_steering_can_be_closed_by_turn_owner
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway steering
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add crates/task-runtime/src/store.rs crates/desktop-gateway/src/main.rs
git commit -m "fix(runtime): close stale steering on terminal turns"
```

---

### Task 9: Resume Marker Validation

**Files:**
- Create: `apps/desktop/src/lib/chat-runtime/resume.mjs`
- Create: `apps/desktop/src/lib/chat-runtime/resume.ts`
- Create: `apps/desktop/src/lib/chat-runtime/resume.test.mjs`
- Modify: `apps/desktop/src/components/ChatView.tsx`

- [ ] **Step 1: Write failing resume tests**

Create `apps/desktop/src/lib/chat-runtime/resume.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { shouldResumeMarker } from "./resume.mjs";

test("terminal status rejects resume marker", () => {
  assert.equal(
    shouldResumeMarker({ marker: { requestId: "a" }, status: "completed" }),
    false,
  );
});

test("missing marker rejects resume", () => {
  assert.equal(shouldResumeMarker({ marker: null, status: "running" }), false);
});

test("active status allows resume marker", () => {
  assert.equal(
    shouldResumeMarker({ marker: { requestId: "a" }, status: "running" }),
    true,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test apps/desktop/src/lib/chat-runtime/resume.test.mjs
```

Expected: FAIL because `resume.mjs` does not exist.

- [ ] **Step 3: Implement resume module**

Create `apps/desktop/src/lib/chat-runtime/resume.mjs`:

```js
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);

export function shouldResumeMarker({ marker, status }) {
  if (!marker) return false;
  if (!status) return true;
  return !TERMINAL.has(status);
}
```

Create `apps/desktop/src/lib/chat-runtime/resume.ts`:

```ts
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);

export function shouldResumeMarker(input: { marker: unknown | null; status: string | null }): boolean {
  if (!input.marker) return false;
  if (!input.status) return true;
  return !TERMINAL.has(input.status);
}
```

- [ ] **Step 4: Use helper in ChatView resume path**

Modify `apps/desktop/src/components/ChatView.tsx` so `resumeActiveStream` clears markers before setting stream state when `fetchTurnStatus` reports a terminal status. Use `shouldResumeMarker` in the local marker effect before calling `resumeActiveStream`.

- [ ] **Step 5: Verify tests and build**

Run:

```bash
node --test apps/desktop/src/lib/chat-runtime/resume.test.mjs
npm run build
```

Expected: PASS and successful build.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/desktop/src/lib/chat-runtime/resume.mjs apps/desktop/src/lib/chat-runtime/resume.ts apps/desktop/src/lib/chat-runtime/resume.test.mjs apps/desktop/src/components/ChatView.tsx
git commit -m "fix(chat): validate resume markers before streaming"
```

---

### Task 10: UI Regression Fixtures

**Files:**
- Modify: `apps/desktop/tests/cursor-grammar-ui.test.mjs`
- Modify: `apps/desktop/tests/adaptive-workspace-island-ui.test.mjs`
- Possibly modify: `apps/desktop/src/styles/chat.css`
- Possibly modify: `apps/desktop/src/styles/composer.css`

- [ ] **Step 1: Add right-aligned unframed user message assertion**

In `apps/desktop/tests/cursor-grammar-ui.test.mjs`, add an assertion that renders a sent user message and checks:

```js
assert.equal(userBubbleHasBackground, false);
assert.equal(userBubbleHasBorder, false);
assert.equal(userMessageAlignedRight, true);
```

Use the existing test helper style in the file. If these exact helper variables do not exist, compute them from the rendered DOM styles in the same test file.

- [ ] **Step 2: Add edit prompt minimum width assertion**

In `apps/desktop/tests/cursor-grammar-ui.test.mjs`, add a fixture for editing a multiline message and assert:

```js
assert.ok(editTextareaBox.width >= 360);
assert.ok(editTextareaBox.height >= 96);
```

Use lower thresholds for mobile viewport only if the existing test suite already has mobile-specific thresholds.

- [ ] **Step 3: Add activity/browser non-overlap assertion**

In `apps/desktop/tests/adaptive-workspace-island-ui.test.mjs`, add a fixture with both activity island and computer workspace open. Assert either:

```js
assert.equal(activityPanelVisible && computerPanelVisible && panelsOverlap, false);
```

or, if the intended behavior is mutual exclusion:

```js
assert.equal(activityPanelVisible, false);
assert.equal(computerPanelVisible, true);
```

Choose the assertion that matches the current product decision before implementation. The recommended behavior is mutual exclusion for narrow widths and side-by-side only when both fit without reducing composer width below its minimum.

- [ ] **Step 4: Run UI contract tests**

Run:

```bash
npm run test:cursor-grammar
npm run test:ui-contract
```

Expected: tests fail if current UI still violates these assertions.

- [ ] **Step 5: Apply minimal CSS/UI fixes**

Modify only the needed files. Preserve the current dark theme and existing component class names. For user message bubbles, the target CSS behavior is:

```css
.message.user .message-bubble {
  background: transparent;
  border-color: transparent;
  margin-left: auto;
}
```

For edit textarea sizing, the target behavior is:

```css
.message-edit textarea {
  min-width: min(420px, 100%);
  min-height: 96px;
}
```

For panel overlap, prefer a single state owner in `ChatView.tsx` or the inspector reducer: opening computer should close activity popover on constrained widths; desktop widths may use side-by-side only if tests prove no overlap.

- [ ] **Step 6: Verify UI contract tests pass**

Run:

```bash
npm run test:cursor-grammar
npm run test:ui-contract
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add apps/desktop/tests/cursor-grammar-ui.test.mjs apps/desktop/tests/adaptive-workspace-island-ui.test.mjs apps/desktop/src/styles/chat.css apps/desktop/src/styles/composer.css apps/desktop/src/components/ChatView.tsx
git commit -m "fix(chat): lock message and workspace layout regressions"
```

---

### Task 11: Documentation Contracts

**Files:**
- Create: `docs/contracts/turn-lifecycle.md`
- Create: `docs/contracts/chat-rendering.md`
- Modify: `docs/README.md`
- Modify: `docs/STATO.md`

- [ ] **Step 1: Create turn lifecycle contract doc**

Create `docs/contracts/turn-lifecycle.md`:

```md
# Turn Lifecycle Contract

Status owner: `crates/task-runtime`.

Durable statuses:

- Active work: `queued`, `pending`, `running`, `waiting_time`, `waiting_external_event`, `waiting_resource`, `paused`
- Waiting for user: `waiting_user_approval`
- Parked: `parked`
- Internal finalization fence: `finalizing`
- Terminal: `completed`, `failed`, `cancelled`, `expired`

Rules:

- UI busy state must derive from durable active work or an explicitly live stream.
- Waiting-user is active but not model work.
- Terminal turns must not leave user-actionable steering that blocks later turns.
- Resume markers must be checked against durable status before replay starts.

Primary code:

- `crates/task-runtime/src/types.rs`
- `crates/task-runtime/src/turn_lifecycle.rs`
- `crates/task-runtime/src/store.rs`
- `crates/desktop-gateway/src/execution_projection.rs`
- `apps/desktop/src/lib/chat-runtime/lifecycle.ts`
```

- [ ] **Step 2: Create chat rendering contract doc**

Create `docs/contracts/chat-rendering.md`:

```md
# Chat Rendering Contract

Visible content owner: `apps/desktop/src/lib/chat-rendering`.

Rules:

- Reasoning is never answer text.
- Structured markers are rendered out of band or stripped.
- Streaming and persisted messages use the same visible-content rules.
- Weak-model prose tool calls are stripped from visible assistant text.
- User messages are right-aligned and unframed after send and edit.

Primary code:

- `apps/desktop/src/lib/chat-rendering/visibleContent.ts`
- `apps/desktop/src/lib/chat-rendering/visibleContent.mjs`
- `apps/desktop/src/lib/markers.ts`
- `apps/desktop/src/components/ChatView.tsx`
- `apps/desktop/src/components/RichMessage.tsx`
```

- [ ] **Step 3: Link docs**

Modify `docs/README.md` to link both new docs under the active architecture/testing section.

Modify `docs/STATO.md` to note:

```md
- Consolidation focus: no new features until turn lifecycle and chat rendering contracts are code-owned and regression-tested.
```

- [ ] **Step 4: Verify docs diff**

Run:

```bash
git diff --check -- docs/contracts/turn-lifecycle.md docs/contracts/chat-rendering.md docs/README.md docs/STATO.md
```

Expected: no output.

- [ ] **Step 5: Commit**

Run:

```bash
git add docs/contracts/turn-lifecycle.md docs/contracts/chat-rendering.md docs/README.md docs/STATO.md
git commit -m "docs: publish chat lifecycle contracts"
```

---

### Task 12: Full Verification and Electron Smoke

**Files:**
- Modify: none unless verification finds a defect

- [ ] **Step 1: Run frontend test set**

Run:

```bash
node --test \
  apps/desktop/src/lib/chat-runtime/lifecycle.test.mjs \
  apps/desktop/src/lib/chat-runtime/steering.test.mjs \
  apps/desktop/src/lib/chat-runtime/composerMode.test.mjs \
  apps/desktop/src/lib/chat-runtime/resume.test.mjs \
  apps/desktop/src/lib/chat-rendering/visibleContent.test.mjs
npm run test:cursor-grammar
npm run test:ui-contract
npm run build
```

Expected: all pass.

- [ ] **Step 2: Run Rust test set**

Run:

```bash
cargo fmt --all --check
cargo test -p local-first-task-runtime turn_lifecycle
cargo test -p local-first-task-runtime terminal_turn_stale_steering_can_be_closed_by_turn_owner
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway steering
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway execution_projection
```

Expected: all pass.

- [ ] **Step 3: Restart desktop dev app**

Run:

```bash
npm --prefix apps/desktop run electron:dev
```

Expected: Electron opens and gateway is reachable. If another process owns the port, identify it before killing anything.

- [ ] **Step 4: Manual Electron smoke**

In the real app, verify:

```text
1. Send a normal chat message.
2. Confirm user prompt is right-aligned and unframed after send.
3. Confirm assistant answer does not expose reasoning or raw markers.
4. Edit a prior user message and confirm textarea is not tiny.
5. Trigger or inspect Activity.
6. Open Computer/browser workspace and confirm no overlap with Activity.
7. Stop/cancel a running turn and confirm thinking clears.
8. Reload the app and confirm stale resume does not resurrect a terminal turn.
```

Expected: all checks pass. Capture screenshots for any visual failure before fixing.

- [ ] **Step 5: Final status**

Run:

```bash
git status --short
```

Expected: only intentionally uncommitted files remain. Report them by slice.

---

## Self-Review Notes

Spec coverage:

- Durable turn lifecycle: Tasks 2, 7, 8, 9, 12.
- Chat delivery and HITL boundaries: Tasks 2, 6, 8, 12.
- Visible reasoning/content contract: Tasks 5, 6, 10, 12.
- Renderer view model extraction: Tasks 2, 3, 4, 6.
- UI regressions from current screenshots: Task 10.
- Documentation updates: Task 11.

Risk:

- Existing worktree changes are broad. Task 1 is mandatory before code edits.
- `desktop-gateway/src/main.rs` is very large. Rust extraction is intentionally deferred until behavior is pinned.
- The exact helper names inside `crates/task-runtime/src/store.rs` tests may need adjustment to match local test utilities; this must be resolved by reading nearby tests, not by creating a duplicate harness.

Execution policy:

- Commit after each task.
- Do not combine UI layout, Rust lifecycle, browser, runtime model, and docs changes in one commit.
- Do not mark completion without Electron smoke, because these regressions are user-visible.
