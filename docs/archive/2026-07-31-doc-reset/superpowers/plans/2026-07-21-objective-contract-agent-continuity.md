# Objective Contract and Agent Continuity Implementation Plan

> **For Codex:** Execute this plan with `superpowers:executing-plans` and `superpowers:test-driven-development`. Keep every behavior test-first and commit each coherent task.

**Goal:** Make a Homun task preserve a canonical objective, replan safely, accept steering while running, stop all execution on cancellation, report memory access honestly, and expose the result through one regenerated Working Ledger.

**Architecture:** Store one mutable objective contract per thread and bind every runtime plan, approval and steering message to its revision. Enforce scope and mutation mode outside the model. Use shared cancellation state across broker, engine, stream and tools. Reuse the current Working Ledger as the sole readable projection.

**Tech stack:** Rust/SQLite/Axum/Tokio desktop gateway and task runtime; React/TypeScript desktop UI; Vitest and Cargo tests.

---

## Task 1: Persist the canonical objective contract

**Files:**
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/task-runtime/src/lib.rs`
- Test: existing unit-test modules in those files

1. Add failing storage tests for create/read, in-place revision replacement and plan-to-objective revision binding.
2. Run the targeted task-runtime tests and confirm the missing schema/API failure.
3. Add `ObjectiveMode`, `ObjectiveContractRecord`, schema migration, store methods, and `objective_revision` on runtime plans.
4. Re-run targeted tests, then `cargo test -p local-first-task-runtime --lib`.
5. Commit.

## Task 2: Add durable turn steering

**Files:**
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/task-runtime/src/lib.rs`
- Modify: `crates/desktop-gateway/src/turn_broker.rs`
- Test: their unit-test modules

1. Add failing tests for ordered pending steering messages and atomic consumption.
2. Add `turn_steering` schema/types/store API.
3. Add broker support that queues steering for a busy thread instead of rejecting it.
4. Verify targeted tests and both affected crates.
5. Commit.

## Task 3: Enforce objective mode and honest plan completion

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: relevant tool/effect policy module discovered during implementation
- Test: `crates/desktop-gateway/src/main.rs` unit tests

1. Add failing tests proving read-only analysis rejects mutation tools, same-objective replanning increments the revision autonomously, and a long answer does not complete open plan steps.
2. Implement deterministic objective classification with a read-only fail-closed default and an external tool/effect policy gate.
3. Replace response-length completion reconciliation with evidence-based step settlement only.
4. Bind approval records/resume to objective revision and invalidate stale approvals.
5. Verify focused gateway tests and commit.

## Task 4: Resume automatically and consume user steering

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Test: unit/integration tests beside implementation

1. Add failing tests for round-boundary consumption, same-goal autonomous replan and changed-goal/new-mutation confirmation.
2. Poll steering between rounds and feed it into the active run with the current objective revision.
3. Continue automatically after approval without requiring a user “continua”.
4. Verify focused tests and commit.

## Task 5: Make cancellation authoritative

**Files:**
- Modify: `crates/desktop-gateway/src/turn_broker.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: unit/integration tests beside implementation

1. Add a failing regression test proving no model round, tool dispatch, artifact write or plan update can occur after cancellation acknowledgement.
2. Replace notify-only cancellation with shared latched cancellation state and retain/abort the engine task handle.
3. Check cancellation before tool dispatch/effect persistence and finalize partial output through the normal sanitizer.
4. Verify focused tests, task-runtime and gateway tests; commit.

## Task 6: Return typed memory status and isolated thread continuity

**Files:**
- Modify: `crates/desktop-gateway/src/memory_recall.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: corresponding unit tests

1. Add failing tests distinguishing `ready`, `empty`, `degraded`, `unavailable`, and `denied`.
2. Add exact same-thread `__threads__` recall constrained by origin workspace and provenance.
3. Stop converting store/search failures to empty results; surface typed status in the turn and Working Ledger.
4. Verify memory and gateway tests; commit.

## Task 7: Regenerate one Working Ledger and keep the composer active

**Files:**
- Modify: `crates/desktop-gateway/src/working_ledger.rs`
- Modify: `apps/desktop/src/components/chat/ChatView.tsx`
- Modify: `apps/desktop/src/components/chat/Composer.tsx`
- Modify: `apps/desktop/src/lib/chatApi.ts`
- Test: Rust and frontend tests nearest these files

1. Add failing tests for objective/revision/scope/memory/cancellation fields in the ledger and for send-during-run steering UI.
2. Extend the structured ledger model and overwrite its single Markdown projection.
3. Keep composer input/send enabled while streaming; route submit to steering rather than a new competing turn.
4. Verify targeted Rust and Vitest suites; commit.

## Task 8: End-to-end regression and real-app verification

**Files:**
- Add/modify: the narrowest integration test covering the reviewed ODT-analysis sequence
- Modify documentation/status only if current repository conventions require it

1. Reproduce: permission grant, project search, read-only analysis, approval continuation, steering, cancellation and memory status.
2. Assert no write in analysis mode, automatic continuation, no post-cancel effects, and accurate ledger/memory state.
3. Run `cargo test -p local-first-task-runtime --lib`, `cargo test -p local-first-engine --lib`, affected gateway tests, frontend tests, `git diff --check`, and formatter/linter checks limited to touched code.
4. Build/run the desktop app and manually verify the composer remains writable, steering is consumed, cancellation settles, and the Working Ledger reflects the final state.
5. Use `superpowers:verification-before-completion`, review the diff, update project status if required, then use `superpowers:finishing-a-development-branch`.
