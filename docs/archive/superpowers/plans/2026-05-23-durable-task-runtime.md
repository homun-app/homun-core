# Durable Task Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the central Rust crate for durable local-first tasks, queues, priorities, resource governance, checkpoints, approvals and crash recovery.

**Architecture:** Add `crates/task-runtime` as an independent crate. Keep scheduling, queueing and resource governance out of subagents, capabilities and browser automation. Start with deterministic SQLite-backed contracts and fake executors before integrating live executors.

**Tech Stack:** Rust 2024, serde, serde_json, rusqlite bundled, uuid, time.

---

## File Structure

- Create `crates/task-runtime/Cargo.toml`: crate manifest.
- Create `crates/task-runtime/src/lib.rs`: public exports.
- Create `crates/task-runtime/src/types.rs`: task ids, statuses, priorities, resource classes, retry policy and task records.
- Create `crates/task-runtime/src/error.rs`: typed errors.
- Create `crates/task-runtime/src/store.rs`: SQLite schema and CRUD.
- Create `crates/task-runtime/src/scheduler.rs`: deterministic scheduler and queue selection.
- Create `crates/task-runtime/src/resources.rs`: resource limits and reservations.
- Create `crates/task-runtime/src/lease.rs`: lease/heartbeat/recovery.
- Create `crates/task-runtime/src/checkpoint.rs`: checkpoint records and redacted views.
- Create `crates/task-runtime/src/approval.rs`: approval requests and decisions.
- Create `crates/task-runtime/src/executor.rs`: executor trait and fake executor.
- Create `crates/task-runtime/src/facade.rs`: `TaskRuntime` public boundary.
- Create `crates/task-runtime/src/ui.rs`: UI-safe read model.
- Modify `Cargo.toml`: add crate to workspace.
- Modify `PROJECT.md`: keep roadmap synced.
- Modify `docs/work-memory.md`: record what changed and why.

## Task 1: Crate Skeleton And Contracts

**Files:**
- Create: `crates/task-runtime/Cargo.toml`
- Create: `crates/task-runtime/src/lib.rs`
- Create: `crates/task-runtime/src/types.rs`
- Create: `crates/task-runtime/src/error.rs`
- Modify: `Cargo.toml`
- Test: `crates/task-runtime/tests/contracts.rs`

- [x] Write tests that construct a task with `user_id`, `workspace_id`, status, priority, resource requirements and retry policy.
- [x] Implement public contract types.
- [x] Export the crate from `lib.rs`.
- [x] Run `cargo test -p local-first-task-runtime --test contracts`.
- [x] Commit as `Add durable task runtime contracts`.

## Task 2: SQLite Store

**Files:**
- Create: `crates/task-runtime/src/store.rs`
- Test: `crates/task-runtime/tests/store.rs`

- [x] Write tests for schema creation, task insert, task load, status update, user/workspace isolation and idempotent migrations.
- [x] Implement `TaskStore::open`, `TaskStore::open_in_memory`, `insert_task`, `get_task`, `update_task_status` and `list_tasks`.
- [x] Run `cargo test -p local-first-task-runtime --test store`.
- [x] Commit as `Add durable task SQLite store`.

## Task 3: Queue And Scheduler

**Files:**
- Create: `crates/task-runtime/src/scheduler.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Test: `crates/task-runtime/tests/scheduler.rs`

- [x] Write tests for priority order, deterministic tie-breaks, `not_before`, dependency blocking and waiting-resource transitions.
- [x] Implement runnable task selection.
- [x] Implement workflow dependency checks.
- [x] Run `cargo test -p local-first-task-runtime --test scheduler`.
- [x] Commit as `Add durable task scheduler`.

## Task 4: Resource Governor

**Files:**
- Create: `crates/task-runtime/src/resources.rs`
- Modify: `crates/task-runtime/src/scheduler.rs`
- Test: `crates/task-runtime/tests/resources.rs`

- [x] Write tests for limits on `llm_inference`, `browser_session`, `graph_indexing` and connector API resources.
- [x] Implement resource limit config and reservation checks.
- [x] Ensure blocked tasks expose `waiting_resource` and a clear `blocked_reason`.
- [x] Run `cargo test -p local-first-task-runtime --test resources`.
- [x] Commit as `Add task resource governor`.

## Task 5: Lease, Heartbeat And Recovery

**Files:**
- Create: `crates/task-runtime/src/lease.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Test: `crates/task-runtime/tests/lease.rs`

- [x] Write tests for acquire lease, heartbeat refresh, stale lease recovery and duplicate execution prevention.
- [x] Implement lease owner and lease expiry updates.
- [x] Implement recovery that releases resources and returns retryable tasks to queue.
- [x] Run `cargo test -p local-first-task-runtime --test lease`.
- [x] Commit as `Add task leases and recovery`.

## Task 6: Checkpoints And Retry

**Files:**
- Create: `crates/task-runtime/src/checkpoint.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Test: `crates/task-runtime/tests/checkpoint.rs`

- [x] Write tests for checkpoint append, latest checkpoint, retryable failure, backoff and terminal failure.
- [x] Implement checkpoint persistence with redacted UI payloads.
- [x] Implement retry policy transitions.
- [x] Run `cargo test -p local-first-task-runtime --test checkpoint`.
- [x] Commit as `Add task checkpoints and retry`.

## Task 7: Approval Gates

**Files:**
- Create: `crates/task-runtime/src/approval.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Test: `crates/task-runtime/tests/approval.rs`

- [x] Write tests for approval request, approve, reject, high-risk waiting state and audit fields.
- [x] Implement approval records and transitions.
- [x] Ensure rejected approvals do not execute the task.
- [x] Run `cargo test -p local-first-task-runtime --test approval`.
- [x] Commit as `Add durable task approval gates`.

## Task 8: Executor Boundary And Facade

**Files:**
- Create: `crates/task-runtime/src/executor.rs`
- Create: `crates/task-runtime/src/facade.rs`
- Test: `crates/task-runtime/tests/facade.rs`

- [x] Write tests with a fake executor for completed task, checkpoint-and-continue, wait-for-time, wait-for-approval and retryable failure.
- [x] Implement `TaskExecutor` and `TaskRuntime`.
- [x] Ensure `TaskRuntime` performs scheduling, resource reservation, lease acquisition, executor call and state transition.
- [x] Run `cargo test -p local-first-task-runtime --test facade`.
- [x] Commit as `Add durable task runtime facade`.

## Task 9: UI Read Model

**Files:**
- Create: `crates/task-runtime/src/ui.rs`
- Test: `crates/task-runtime/tests/ui.rs`

- [x] Write tests for queue snapshot, active tasks, blocked tasks, waiting approvals, resource saturation and recent failures.
- [x] Implement UI-safe read structs that omit raw secrets and sensitive payloads.
- [x] Run `cargo test -p local-first-task-runtime --test ui`.
- [x] Commit as `Add durable task UI read model`.

## Task 10: Documentation And Verification

**Files:**
- Modify: `PROJECT.md`
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-durable-task-runtime.md`

- [x] Mark completed plan steps.
- [x] Update work memory with what was implemented and why.
- [x] Run `make test`.
- [x] Commit as `Document durable task runtime`.

