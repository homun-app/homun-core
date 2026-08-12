# Kernel UI Projection Contract Design

Date: 2026-08-11
Status: Draft for review
Scope: UI/kernel ownership convergence for Homun Runtime V2. This is not a visual redesign and not a rewrite mandate.

## Objective

Homun's runtime refactor must include the desktop UI contract. The observed
regressions are not only backend bugs: the renderer still composes live stream
state, durable activity projection, persisted marker fallbacks, approvals,
uncertain effects, browser session state, local refs, and message text into one
visible answer. That makes the UI a second partial engine.

The goal is to make the UI a presenter over one kernel projection:

```text
turn_events + runtime_plans + execution_effect_receipts + agent_runs + HITL state
  -> task-runtime reducer
  -> gateway KernelThreadProjection DTO
  -> desktop presenter rows/cards
```

Every slice in this migration must either remove an obsolete UI owner or mark it
as a temporary compatibility fallback with a specific removal condition.

## Reference Systems

### Codex

Local checkout:
`/Users/fabio/Projects/Homun/agent-system-research/codex` at `41ece45`.

Relevant code:

- `codex-rs/core/src/session/turn.rs`
- `codex-rs/core/src/state/turn.rs`
- `codex-rs/tui/src/chatwidget.rs`

Codex's TUI is not passive, but its responsibilities are narrower. `ChatWidget`
consumes protocol events, builds committed transcript cells and an in-flight
active cell, owns input/bottom-pane rendering, and forwards operations. The core
session and turn state remain outside the renderer.

Useful lesson for Homun: renderer state may exist for local presentation and
input ergonomics, but it must not redefine terminality, tool completion, plan
progress, or user-wait ownership.

### opencode

Local checkout:
`/Users/fabio/Projects/Homun/agent-system-research/opencode` at `d041eee`.

Relevant code:

- `packages/schema/src/session-status-event.ts`
- `packages/schema/src/session-message.ts`
- `packages/app/src/pages/session/timeline/projection.ts`
- `packages/app/src/pages/session/timeline/rows.ts`

opencode exposes typed `SessionStatus`, `Message`, and `Part` data, then builds
timeline rows such as `UserMessage`, `AssistantPart`, `Thinking`, `Retry`, and
`Error`. The timeline projection decides visual grouping and placeholders. It
does not inspect unrelated side effects to infer whether the agent really made
progress.

Useful lesson for Homun: the desktop should receive a normalized session/turn
projection, then derive visual rows. The row builder can add `Thinking` or
`Retry` from a canonical status, but it should not synthesize canonical status.

## Current Homun Facts

Code observations on `fabio/runtime-v2-first-slice`:

- `crates/task-runtime/src/turn_reducer.rs` now exposes `reduce_kernel_projection`.
- `crates/task-runtime/src/store.rs::project_thread_activity` now routes latest
  turn activity through that reducer.
- `apps/desktop/src/components/useChatActivityProjection.ts` still chooses among
  durable projection, live stream plan, persisted marker plan, local active turn
  refs, and replay state.
- `apps/desktop/src/lib/chat-runtime/browserActivityLifecycle.mjs` still derives
  `conversationPlan` from `isStreaming`, `livePlanMarkdown`, projected plan, and
  persisted plan.
- `apps/desktop/src/lib/chat-runtime/lifecycle.mjs` still derives `hasActiveTurn`
  and `workInProgress` from local streaming state, projected active turn, and
  HITL-tail detection.
- `apps/desktop/src/lib/chatEventParts.ts` still normalizes persisted structured
  parts and contains marker/HITL fallback behavior.
- `apps/desktop/src/components/ChatView.tsx` still composes turn lifecycle,
  activity, browser, approvals, uncertain effects, workspace sections, and
  composer state.

These pieces are valuable and should not be thrown away. The problem is that
some of them still own facts the kernel should own.

## Target Contract

### Kernel Owns

The backend projection must be the only source for:

- current turn status: `idle`, `running`, `waiting_user`, `waiting_approval`,
  `paused`, `completed`, `failed`, `cancelled`;
- active turn id and replay cursor;
- terminal reason and failure text;
- plan goal, step ids, step titles, step statuses, and plan revision;
- activity rows emitted by the turn/runtime;
- browser delegated state: active target, progress, done, bounded failure, and
  whether browser work can continue;
- pending approvals and uncertain effects, already filtered by risk and
  ownership;
- whether the composer is submitting a new turn, steering an active turn,
  replying to HITL, or disabled.

### UI Owns

The desktop may own:

- layout, panels, selected inspector tab, open/closed cards, scroll anchoring;
- composer draft text and local file attachment editing;
- optimistic local echo before the gateway returns the first projection;
- transient animation and elapsed timers;
- row virtualization and visual grouping;
- user commands that call backend APIs.

The desktop must not own:

- plan completion;
- terminality;
- liveness after a durable terminal event exists;
- browser success/failure;
- effect receipt risk classification;
- whether a user reply is steering versus a new turn;
- whether a stale marker should resurrect a plan.

## Proposed DTO

Introduce a backend-owned `KernelThreadProjection` DTO. The exact Rust/TS names
can be adjusted during implementation, but the shape must be stable enough that
the UI can stop composing state from multiple endpoints.

```text
KernelThreadProjection
  thread_id
  revision
  turn:
    active_turn_id?
    status
    last_event_seq
    terminal_reason?
    failure_text?
    updated_at
  plan:
    goal?
    revision
    steps[]
  activity:
    rows[]
  browser:
    state
    target_id?
    latest_progress?
    failure_reason?
  actions:
    can_stop
    composer_mode
  attention:
    awaiting_user
    approvals[]
    uncertain_effects[]
  transcript:
    messages[]
    parts_by_message_id
```

`transcript` can be a later slice if it is too large for the first DTO change.
The first useful step is to make turn, plan, activity, browser, actions, and
attention canonical.

## Delete-First Migration Rule

Every implementation slice must include a deletion ledger:

```text
Removed owner:
  file/function:
  old responsibility:
  new owner:
  test that prevents resurrection:

Temporary fallback retained:
  file/function:
  reason:
  removal condition:
  tracking test:
```

A slice that only adds a new projection but keeps all old inference paths active
is not complete. Compatibility is allowed only when old persisted data requires
it, and it must be isolated behind a named legacy adapter.

## Migration Plan

### Slice 1: Backend UI Projection Contract

Owner: `crates/task-runtime` plus `crates/desktop-gateway`.

Add or extend a single endpoint that returns the kernel projection for one
thread. It may wrap the existing `/activity` route initially, but the DTO should
be explicit about turn, plan, activity, browser, and actions.

Remove or quarantine:

- renderer-local conversion from terminal task state to lifecycle state when the
  backend projection already provides it;
- any duplicated terminal status vocabulary that can be generated from backend
  DTO values.

Required test:

- terminal `turn_events` plus stale `tasks.status=running` returns
  `turn.status=completed`, `actions.can_stop=false`, no active turn.

### Slice 2: Frontend Presenter Adapter

Owner: `apps/desktop/src/lib/chat-runtime`.

Create a pure presenter adapter that maps `KernelThreadProjection` to:

- `conversationPlan`;
- `conversationActivity`;
- `workspacePlanSteps`;
- `workspaceSections`;
- `chatTurnState`;
- `composerMode`.

Remove or quarantine:

- legacy local plan fallback from persisted marker plan when projection is
  loaded. The desktop `deriveConversationPlan` owner was removed in the
  2026-08-12 UI cleanup;
- local `doing -> done` rewrite based on `projectedTurnStatus`;
- duplicated HITL-tail lifecycle decisions when backend `attention.awaiting_user`
  is present.

Required tests:

- durable projection wins over live stream gaps;
- stale turn projection cannot render an old plan;
- terminal projection clears active thinking state;
- read receipt uncertainty does not render a user verification card.

### Slice 3: Browser UI Projection

Owner: backend browser projection plus desktop presenter.

Move browser visual state behind the same projection boundary. The UI can show
browser panel state, but it must not decide success from snapshot visibility or
activity text.

Remove or quarantine:

- any UI inference where `previewDataUrl` or `computerLiveStatus.active` implies
  browser progress or completion;
- browser budget text parsing from generic activity rows, once backend emits a
  typed browser failure.

Required tests:

- visible browser snapshot without `BrowserDone` is still active/unknown;
- `BrowserDone` with extracted results closes browser work even if a read receipt
  is uncertain;
- no-progress browser failure renders a bounded failure, not an indefinite
  thinking state.

### Slice 4: Transcript Parts

Owner: gateway transcript projection plus desktop row builder.

Replace marker-dependent rendering with typed parts. Legacy marker parsing can
remain only as an import/migration adapter for older persisted messages.

Remove or quarantine:

- raw structured marker detection from general lifecycle code;
- marker-driven free HITL detection when durable HITL/projection exists;
- duplicated activity/plan extraction from assistant text.

Required tests:

- persisted typed parts render after reload without marker text;
- malformed marker fragments cannot leak as answer text;
- old marker-only messages still render through the legacy adapter, but do not
  affect current turn liveness.

## Non Goals

- No broad visual redesign.
- No immediate rewrite of `ChatView.tsx`.
- No replacement of React/Electron.
- No removal of optimistic local echo before a backend turn id exists.
- No attempt to copy Codex or opencode UI styling.

## Acceptance Criteria

The UI/kernel convergence is ready for release only when:

- a terminal durable turn cannot leave `ChatView` or `ChatComposerDock` in
  active thinking state;
- the plan visible in the workspace can be traced to `runtime_plans` and
  `turn_events`, not marker text alone;
- browser visible activity cannot be mistaken for `BrowserDone`;
- read receipts never create user verification cards;
- write receipts with real unknown remote outcome still require user resolution;
- each migrated fallback has either been deleted or documented as a legacy
  adapter with a removal condition;
- `python3 scripts/kernel_regression_gate.py` passes after every slice.

## First Implementation Plan To Write Next

The next implementation plan should not start by editing `ChatView.tsx`.

It should start with a RED contract around the current backend projection shape:

1. Extend the task-runtime/gateway projection DTO enough to carry canonical
   `turn.status`, `active_turn`, `plan`, `activity`, and `actions.can_stop`.
2. Add a frontend pure adapter test that consumes this DTO and proves the UI
   can render plan/activity/liveness without marker fallback.
3. Delete one obsolete fallback from `useChatActivityProjection.ts` or
   `browserActivityLifecycle.mjs`.
4. Run focused tests plus `python3 scripts/kernel_regression_gate.py`.
