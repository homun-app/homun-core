# Visible Conversation Turns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every externally-originated Homun turn visible in its owning chat before tools, browser, LLM, approvals, or subagents start working.

**Architecture:** Introduce a small gateway-level visible-turn contract as the first slice of a future Conversation Runtime. The gateway persists the user message and assistant placeholder before publishing a `thread.turn_started` event; clients navigate and refresh from that event, then consume `thread.updated` while streaming continues.

**Tech Stack:** Rust desktop gateway (`crates/desktop-gateway`), SQLite `ChatStore`, React/Electron frontend (`apps/desktop`), NDJSON `/api/events`, existing chat stream registry.

---

### Task 1: Backend Visible-Turn Contract

**Files:**
- Modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/main.rs`

- [x] Add a `VisibleConversationTurn` struct with `turn_id`, `user_message_id`, and `assistant_message_id`.
- [x] Add a pure `thread_turn_started_event(...) -> serde_json::Value` helper.
- [x] Add `start_visible_conversation_turn(...) -> Option<VisibleConversationTurn>` that:
  - creates a durable user chat message;
  - creates a durable assistant placeholder;
  - commits both through `ChatStore`;
  - publishes `thread.turn_started` only after persistence succeeds.
- [x] Add tests for the event payload shape.

### Task 2: Channel-Originated Turns

**Files:**
- Modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/main.rs`

- [x] Replace the early `thread.upserted` in `handle_channel_inbound` with `start_visible_conversation_turn`.
- [x] Keep typing presence after the visible turn is started.
- [x] Run `run_agent_turn_into_message` with the persisted message ids.
- [x] Fail closed if no visible turn was persisted: do not run tools or send an invisible fallback reply.
- [x] If the threaded agent fails after the visible turn exists, update the visible placeholder with the stateless fallback reply.

### Task 3: Scheduled/Automation Turns

**Files:**
- Modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/main.rs`

- [x] Replace scheduled-task early `thread.upserted` plus final append with `start_visible_conversation_turn`.
- [x] Use `run_agent_turn_into_message` so scheduled work streams into the visible assistant placeholder.
- [x] Preserve existing policy selection: autonomous automation may act, confirmation automation proposes, check-in runs read-only.
- [x] Preserve incomplete-plan detection and task outcome semantics.

### Task 3.5: Remote Approval Continuations

**Files:**
- Modify: `/Users/fabio/Projects/Homun/app/crates/desktop-gateway/src/main.rs`

- [x] Make approved-action continuation create a visible user bubble and assistant placeholder before resuming the agent.
- [x] Stream the resumed agent turn into the persisted assistant placeholder.
- [x] Fail closed when the continuation turn cannot be persisted.
- [x] Preserve remote approval activation from the persisted final assistant message.
- [x] Remove the old headless agent helper so future backend producers cannot bypass visible placeholders.

### Task 4: Frontend Event Handling

**Files:**
- Modify: `/Users/fabio/Projects/Homun/app/apps/desktop/src/lib/coreBridge.ts`
- Modify: `/Users/fabio/Projects/Homun/app/apps/desktop/src/App.tsx`

- [x] Extend `AppEvent` with optional `turn_id`, `user_message_id`, `assistant_message_id`, and `source`.
- [x] Add a pending event-thread set so `thread.updated` is not lost while React is navigating.
- [x] Handle `thread.turn_started` by notifying if needed, navigating to the thread, and forcing message refresh.
- [x] Keep `thread.upserted` compatibility for older producers.
- [x] Refresh current or pending event threads on `thread.updated`.

### Task 5: Verification and Docs

**Files:**
- Modify: `/Users/fabio/Projects/Homun/app/apps/desktop/scripts/check-ui-contract.mjs`
- Modify: `/Users/fabio/Projects/Homun/app/docs/DEVELOPMENT.md`
- Modify: `/Users/fabio/Projects/Homun/app/docs/roadmap.md`

- [x] Add static UI contract checks for `thread.turn_started`, pending event thread handling, and no early channel `thread.upserted`.
- [x] Update `DEVELOPMENT.md` "SEI QUI" with the visible-turn safety invariant.
- [x] Update `roadmap.md` with the unified Conversation Runtime direction.
- [x] Run:
  - `cargo test -p local-first-desktop-gateway channel_agent_stream_lines_accumulate_delta_and_done_text -- --nocapture`
  - `cargo test -p local-first-desktop-gateway -- --nocapture`
  - `npm run test:ui-contract`
  - `npm run build`
  - `git diff --check`

### Error Scenarios Covered

- Event arrives before messages: impossible for new producers because `thread.turn_started` is emitted after persistence.
- Client navigates while `thread.updated` arrives: pending event-thread set keeps refresh alive.
- App closed or event lost: durable user/assistant placeholder remains in `ChatStore`.
- External source cannot persist a visible turn: fail closed; no invisible tool/browser work and no invisible outbound reply.
- Agent stream fails after visible turn: placeholder is updated with the fallback or final error state.
- Multiple external turns on one channel: each turn has a distinct `turn_id` and persisted message ids.
- Subagents: future child work must emit under the parent `turn_id`; subagents do not own independent chat lifecycles.
