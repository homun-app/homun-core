# Journal Attempt Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist worker attempt ownership in the canonical execution journal before adapter dispatch.

**Architecture:** Add typed attempt start/reclaim events to the existing journal fold. Keep task leases as scheduler ownership, but bind production outcome commit to the journal's running revision and fencing token.

**Tech Stack:** Rust 2024, rusqlite transactions, serde journal events, Cargo tests.

---

### Task 1: Journal attempt state machine

**Files:**
- Modify: `crates/task-runtime/src/execution_store.rs`
- Modify: `crates/task-runtime/src/lib.rs`
- Modify: `crates/task-runtime/tests/execution_store.rs`

- [x] Add failing tests for attempt start, idempotency, conflicting owner, reclaim, and stale outcome rejection.
- [x] Add `AttemptStarted` and `AttemptReclaimed` events and fold them into `ExecutionState::Running`.
- [x] Add transactional start and reclaim APIs with exact revision/fence checks.
- [x] Require `Running` for new production outcome commits while retaining legacy journal readability.

### Task 2: Runtime ownership wiring

**Files:**
- Modify: `crates/desktop-gateway/src/execution_runtime.rs`

- [x] Add a failing adapter test proving journal state is `Running` during dispatch.
- [x] Start or reclaim the attempt after authoritative contract/fence resolution and before building `ExecutionAdapterContext`.
- [x] Verify lease loss and stale-fence tests still reject old workers.

### Task 3: Regression and documentation

**Files:**
- Modify: `docs/TURN_CONTRACT.md`
- Modify: `docs/superpowers/specs/2026-07-29-journal-attempt-ownership-design.md`
- Modify: `docs/superpowers/plans/2026-07-29-journal-attempt-ownership.md`

- [x] Run task-runtime execution-store tests.
- [x] Run desktop execution-runtime and ownership tests.
- [x] Run workspace tests and a warning-denied workspace build.
- [x] Document the durable attempt and reclaim sequence.
