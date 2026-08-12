# Turn Lifecycle and Chat Rendering Consolidation Design

Date: 2026-08-03
Status: Draft for review
Scope: consolidation, regression prevention, and code ownership cleanup. This is not a new-feature plan.

## Objective

Homun currently has useful kernel work, but the code still lets multiple layers infer the same turn and chat state independently. That is the main source of regressions where a bug appears fixed in one layer and later returns through another path.

This slice consolidates two tightly coupled areas first:

- Turn lifecycle: active, waiting, terminal, cancelled, failed, parked, resumed, and stopped.
- Chat rendering: user-visible text, hidden reasoning, activity, HITL cards, pending steering, and streaming/resume state.

The outcome is a smaller set of explicit contracts, code owners, and anti-regression tests that make invalid states hard to represent.

## Current Code Facts

These are code observations, not documentation assumptions.

- Superseded by Runtime V2: `crates/task-runtime/src/store.rs::project_kernel_thread`
  projects thread liveness, plan, activity, browser, attention, capability
  runtime, and actions from durable kernel state.
- `crates/task-runtime/src/types.rs::TaskStatus` defines the durable task status vocabulary, including active states such as `running`, `waiting_user_approval`, `parked`, and terminal states such as `completed`, `failed`, `cancelled`, and `expired`.
- `crates/task-runtime/src/store.rs::fence_chat_turn_finalization` uses `turn_steering` rows in `pending`, `claimed`, or `interpreted` to decide whether a running turn may enter the SQL-only `finalizing` state.
- `crates/desktop-gateway/src/turn_executor.rs::emit_turn_event` writes each turn event to durable storage and broadcasts it live.
- `crates/desktop-gateway/src/ws_gateway.rs::handle_resume` replays durable `turn_events` and then emits a resume terminal signal when the task is terminal.
- `crates/desktop-gateway/src/execution_projection.rs::project_chat_execution` projects execution outcomes into task status, agent run status, message delivery state, objective status, and HITL persistence.
- `crates/desktop-gateway/src/chat_store.rs` persists chat messages, message `delivery_state`, and free HITL waits in `thread_hitl_waits`.
- `apps/desktop/src/components/ChatView.tsx` still combines local renderer state (`promptSubmitting`, `streamingAssistantId`, `streamStatus`), durable projections (`projectedActiveTurn`, `projectedTurnStatus`), HITL-tail detection, pending steering, and resume markers to decide what the user sees.
- `apps/desktop/src/lib/markers.ts` and `apps/desktop/src/lib/chatVisibleContent.*` are the current stripping path for reasoning and structured markers, but rendering still depends on how `ChatView` and message components route streamed and persisted content.

## Problem Statement

The kernel is not currently a complete ownership boundary. It centralizes important execution facts, but gateway and renderer still contain compatibility logic and optimistic local state. This creates three classes of regressions:

1. A terminal turn can still leave stale steering or resume state that another layer treats as active work.
2. Internal model output such as reasoning, activity, markers, or malformed tool prose can leak through a path that bypasses the intended visible-content filter.
3. UI busy/thinking/waiting states can be derived from local state after the durable task is already terminal.

The fix is not another UI-only filter. The durable owner must reject or normalize invalid states, and the renderer must become a consumer of a small view model instead of recomputing lifecycle semantics across several hooks.

## Non Goals

- No new features.
- No visual redesign beyond fixing regressions caused by incorrect state.
- No broad rewrite of the app shell.
- No model-provider expansion.
- No browser feature work in this slice, except where browser events affect chat rendering or turn terminality.
- No large mechanical reformatting while files are behaviorally changing.

## Contract 1: Durable Turn Lifecycle

Owner: `crates/task-runtime`.

Durable task status is the only source of truth for whether a turn is active, waiting, parked, or terminal.

Required invariants:

- Terminal statuses are exactly `completed`, `failed`, `cancelled`, and `expired`.
- `finalizing` is an internal SQL-only fence state and must not render as active work.
- A terminal turn must not have user-actionable steering rows that can block later turns.
- A waiting-user turn is active but not model work.
- A parked turn is active and blocked on an explicit resumable cause.
- A new user message can become steering only when the current durable turn is genuinely active and not waiting for free HITL input.
- Resume must validate durable status before setting any renderer stream state.

Design implication:

The store should expose one helper for lifecycle classification, used by gateway and tests. Renderer-local terminal sets must be replaced or generated from this contract.

## Contract 2: Chat Delivery State

Owner: `crates/desktop-gateway` projection layer plus `chat_store`.

Message `delivery_state` describes what should be displayed for the persisted assistant message. It must not be used as a substitute for durable task lifecycle.

Required invariants:

- `streaming` means the assistant message is still being produced or replayed.
- `waiting_user` means a persisted HITL envelope exists or is recoverable.
- `delivered` means the final user-visible answer body is settled.
- `failed` and `cancelled` are terminal message states.
- Projection from execution outcome to message delivery state must be idempotent.
- Free HITL waits must persist independently of lossy text markers.

Design implication:

`execution_projection` should be the only place that maps execution outcomes to message delivery state. UI code should not infer delivery from marker text except as a documented legacy fallback while migration is incomplete.

## Contract 3: Visible Chat Content

Owner: `apps/desktop/src/lib/chat-rendering` after extraction.

The renderer must never display internal reasoning, raw structured markers, or leaked tool-call prose as answer text.

Required invariants:

- Reasoning can be stored, metered, collapsed, or shown in an explicit activity/reasoning surface only when intentionally enabled, but it is never part of assistant answer text.
- `‹‹REASONING››...‹‹/REASONING››`, `<think>...</think>`, activity markers, plan markers, tool-call prose, and incomplete marker fragments are stripped from visible answer text.
- Streaming and persisted rendering must use the same visible-content function.
- A test must cover unterminated streaming reasoning, nested marker-adjacent prose, and malformed weak-model tool prose.

Design implication:

`markers.ts`, `chatVisibleContent.ts`, and message display helpers should move behind one pure view-model API. `ChatView` should render the returned parts, not parse markers inline.

## Contract 4: Renderer Turn View Model

Owner: `apps/desktop/src/lib/chat-runtime` after extraction.

`ChatView.tsx` should not own lifecycle semantics. It should assemble inputs and delegate state decisions to pure functions.

Inputs:

- durable activity projection
- active turn projection
- latest turn status
- stream status
- local submit state
- persisted messages
- HITL wait state
- pending steering rows
- resume marker status

Outputs:

- `hasActiveTurn`
- `workInProgress`
- `turnAwaitingUser`
- `canStop`
- `terminalTurnAtRest`
- visible pending steering rows
- active assistant message id
- composer mode: new turn, steering, disabled, waiting-user reply

Required invariants:

- A terminal durable turn always clears busy/thinking UI unless a new stream has started.
- Free HITL does not show model work in progress.
- Stale resume markers cannot set `isStreaming`.
- Stale steering rows cannot keep the thread blocked or visible as pending work.
- The composer decision is explainable from the view-model output and covered by tests.

## Proposed Code Organization

This slice should move logic by ownership, not by cosmetic grouping.

Frontend target layout:

```text
apps/desktop/src/lib/chat-runtime/
  lifecycle.ts
  lifecycle.test.mjs
  resume.ts
  resume.test.mjs
  steering.ts
  steering.test.mjs
  composerMode.ts
  composerMode.test.mjs

apps/desktop/src/lib/chat-rendering/
  visibleContent.ts
  visibleContent.test.mjs
  markers.ts
  markers.test.mjs
  eventParts.ts
  eventParts.test.mjs
```

Gateway target layout:

```text
crates/desktop-gateway/src/chat_turn/
  mod.rs
  routes.rs
  projection.rs
  resume.rs
  delivery.rs
  hitl.rs
  steering_cleanup.rs
```

Task runtime target layout:

```text
crates/task-runtime/src/turn_lifecycle.rs
crates/task-runtime/src/turn_steering.rs
```

The first implementation pass should extract pure frontend logic and add tests before moving Rust modules. Rust module extraction should follow once tests pin behavior, because `desktop-gateway/src/main.rs` is highly coupled.

## Anti-Regression Fixture Set

The first slice is not complete until these cases are automated:

- Terminal turn plus stale resume marker does not show thinking and does not resume.
- Terminal turn plus stale steering row does not show pending work and cannot block a new turn.
- Waiting-user HITL shows the card/reply path but not model work.
- Cancelled turn emits one terminal event and settles message delivery.
- Reasoning marker in persisted message is not visible as answer text.
- Unterminated `<think>` while streaming is hidden from answer text.
- Weak-model prose tool call is stripped from answer text.
- User message stays visually right-aligned and unframed after send and after edit.
- Assistant activity/browser panel does not overlap with computer/browser workspace surfaces.

## Work Plan

### Phase 0: Stabilize the Worktree

- List all current dirty files.
- Group current changes into narrow slices: UI rendering, turn lifecycle, browser contract, runtime/model/context, docs.
- Avoid committing unrelated changes together.
- If a file has unrelated edits, inspect it before modifying and preserve user changes.

### Phase 1: Ownership Inventory

- Create a code-backed ownership table for turn lifecycle and chat rendering.
- Mark each owner as canonical, projection, cache, compatibility fallback, or UI-only.
- Identify duplicated terminal status sets and duplicated marker stripping paths.
- Document every current fallback that exists because of old persisted data.

### Phase 2: Frontend Pure View Models

- Extract lifecycle and composer decisions from `ChatView.tsx` into pure functions.
- Add test fixtures before changing rendering.
- Replace inline decision logic with the view model.
- Keep visual output unchanged except for regression fixes.

### Phase 3: Durable Lifecycle Cleanup

- Move stale steering cleanup rules into a task-runtime or gateway helper with tests.
- Ensure terminality, finalizing, waiting-user, and parked are classified by one shared function.
- Add store-level tests for terminal turn plus stale steering.

### Phase 4: Visible Content Unification

- Consolidate marker and reasoning stripping behind one API used by streaming and persisted rendering.
- Add tests for reasoning leakage and weak-model malformed output.
- Remove inline regex copies only after coverage is green.

### Phase 5: Verification Gate

- Run targeted frontend tests.
- Run targeted Rust tests for task runtime and desktop gateway.
- Run build.
- Run Electron smoke for the actual chat flows after code changes.
- Update docs/contracts with exact code links and test commands.

## Acceptance Criteria

This slice is done only when:

- `ChatView.tsx` no longer directly owns the lifecycle/composer state machine.
- There is one documented lifecycle classifier for terminal, active, waiting-user, parked, and finalizing.
- The renderer has one visible-content API for streaming and persisted messages.
- The anti-regression fixtures above are automated.
- The documentation names the owner of every state used by chat rendering.
- The user-visible bugs from this group are tested: reasoning leak, stale thinking, stale steering, edit prompt sizing/alignment, and workspace panel overlap.

## Review Questions

- Is `Turn Lifecycle + Chat Rendering` the correct first consolidation slice?
- Should browser overlap be treated inside this slice because it affects chat rendering, or moved to the next `Browser/Computer Workspace` slice?
- Should the first implementation pass prioritize extracting frontend pure functions, or fixing durable stale steering cleanup first?
