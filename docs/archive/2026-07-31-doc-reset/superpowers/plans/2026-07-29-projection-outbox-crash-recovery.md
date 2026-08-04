# Projection Outbox And Crash Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist exact-revision projection work atomically with execution outcomes and prove that gateway restart converges without duplicate effects or terminal events.

**Architecture:** `task-runtime` owns a generic `execution_projection_outbox` delivery state machine but not projection behavior. The gateway claims `chat_lifecycle` rows with process-generation fencing, runs the existing idempotent projector, and acknowledges only after its terminal turn event is durable. Uncertain `EffectHost` receipts block rows until the existing resolver atomically requeues them.

**Tech Stack:** Rust 2024, Tokio, rusqlite/SQLite WAL, Axum gateway tests, existing execution journal and Electron test harness.

---

### Task 1: Outbox schema and public delivery types

**Files:**
- Create: `crates/task-runtime/src/projection_outbox.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/task-runtime/src/lib.rs`
- Create: `crates/task-runtime/tests/projection_outbox.rs`

- [x] **Step 1: Write failing schema and round-trip tests**

Add tests that open an in-memory store, inspect `execution_projection_outbox`, and round-trip a seeded pending row through a read method. Assert the table rejects an unknown status and duplicate `(execution_id, revision, projection_kind)` identities.

- [x] **Step 2: Run the focused test and confirm the API is missing**

Run: `cargo test -p local-first-task-runtime --test projection_outbox -- --nocapture`

Expected: compilation fails because `ProjectionOutboxRecord`, `ProjectionStatus`, and the outbox methods do not exist.

- [x] **Step 3: Add the migration and typed model**

Create the focused module with these public types:

```rust
pub const CHAT_LIFECYCLE_PROJECTION: &str = "chat_lifecycle";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionStatus { Pending, Claimed, Blocked, Completed }

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionOutboxRecord {
    pub projection_ref: String,
    pub execution_id: String,
    pub revision: u64,
    pub projection_kind: String,
    pub status: ProjectionStatus,
    pub attempt_count: u64,
    pub claim_owner: Option<String>,
    pub claim_generation: Option<u64>,
    pub claim_token: u64,
    pub not_before: Option<i64>,
    pub blocked_on_ref: Option<EffectReceiptRef>,
    pub last_error_code: Option<String>,
    pub last_error_detail: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionErrorEvidence {
    pub code: String,
    pub redacted_detail: String,
}
```

Add `migrate_projection_outbox_v16(&Connection)` and call it after receipt/compensation migrations. Use strict status and ownership `CHECK` constraints, a unique source identity, a due-work index, and no copied outcome payload.

- [x] **Step 4: Export types and run focused tests**

Run: `cargo test -p local-first-task-runtime --test projection_outbox -- --nocapture`

Expected: schema and type round-trip tests pass.

- [x] **Step 5: Commit the schema slice**

```bash
git add crates/task-runtime/src/projection_outbox.rs crates/task-runtime/src/store.rs crates/task-runtime/src/lib.rs crates/task-runtime/tests/projection_outbox.rs
git commit -m "feat: add durable projection outbox"
```

### Task 2: Atomic outcome enqueue and exact-revision reads

**Files:**
- Modify: `crates/task-runtime/src/execution_store.rs`
- Modify: `crates/task-runtime/src/projection_outbox.rs`
- Modify: `crates/task-runtime/tests/projection_outbox.rs`
- Modify: `crates/task-runtime/tests/continuation.rs`

- [x] **Step 1: Add failing atomicity and exact-revision tests**

Cover these cases with file-backed stores:

```rust
assert_eq!(store.projection_rows_for_execution("turn-1")?.len(), 1);
assert_eq!(row.revision, 1);
assert_eq!(row.projection_kind, CHAT_LIFECYCLE_PROJECTION);
assert_eq!(row.status, ProjectionStatus::Pending);
```

Also assert idempotent outcome commit creates no duplicate, a conflicting commit creates no row, revision 1 remains loadable after revision 2 starts, and a continuation transaction enqueues the parent projection exactly once.

- [x] **Step 2: Run the tests and confirm no enqueue exists**

Run: `cargo test -p local-first-task-runtime --test projection_outbox --test continuation -- --nocapture`

Expected: the new assertions fail because outcome commit does not enqueue projection work.

- [x] **Step 3: Implement deterministic enqueue inside the outcome transaction**

Add transaction helpers:

```rust
fn projector_kind(execution_kind: &str) -> Option<&'static str> {
    (execution_kind == "chat_turn").then_some(CHAT_LIFECYCLE_PROJECTION)
}

fn enqueue_projection_on(
    tx: &Transaction<'_>,
    contract: &ExecutionContract,
    committed_at: i64,
) -> TaskRuntimeResult<()>;
```

Call the helper before committing both newly inserted and idempotently existing outcomes. Add `execution_revision(execution_id, revision)` that folds and returns the requested journal revision rather than the latest `executions` row. Apply the same parent enqueue inside `continue_execution_as_new`.

- [x] **Step 4: Add migration backfill tests**

Build a pre-v16 file fixture with committed revision 1 and 2 outcomes, reopen it, and assert one deterministic row per `OutcomeCommitted` chat revision. Assert reopening again is idempotent and malformed journal history aborts migration without partial outbox rows.

- [x] **Step 5: Run task-runtime suites**

Run: `cargo test -p local-first-task-runtime --test projection_outbox --test execution_store --test continuation -- --nocapture`

Expected: all pass.

- [x] **Step 6: Commit atomic enqueue**

```bash
git add crates/task-runtime/src/execution_store.rs crates/task-runtime/src/projection_outbox.rs crates/task-runtime/tests/projection_outbox.rs crates/task-runtime/tests/continuation.rs
git commit -m "feat: enqueue committed outcome projections atomically"
```

### Task 3: Fenced claim, retry, block, and recovery transitions

**Files:**
- Modify: `crates/task-runtime/src/projection_outbox.rs`
- Modify: `crates/task-runtime/tests/projection_outbox.rs`

- [x] **Step 1: Add failing transition and concurrency tests**

Test two file-backed `TaskStore` handles racing on one row. Exactly one receives:

```rust
pub struct ProjectionClaim {
    pub record: ProjectionOutboxRecord,
    pub owner: String,
    pub generation: u64,
    pub token: u64,
}
```

Assert a stale owner cannot complete/retry/block, a higher process generation reclaims `claimed`, retry sets bounded `not_before`, blocking requires a receipt, completed rows never claim again, and blocked rows never become due automatically.

- [x] **Step 2: Run the focused tests and verify failure**

Run: `cargo test -p local-first-task-runtime --test projection_outbox claim -- --nocapture`

Expected: compilation fails because transition APIs are absent.

- [x] **Step 3: Implement atomic claim transitions**

Implement on `TaskStore`:

```rust
pub fn claim_projection(&self, kind: &str, owner: &str, generation: u64, now: i64)
    -> TaskRuntimeResult<Option<ProjectionClaim>>;
pub fn complete_projection(&self, claim: &ProjectionClaim, now: i64) -> TaskRuntimeResult<()>;
pub fn retry_projection(&self, claim: &ProjectionClaim, error: ProjectionErrorEvidence, not_before: i64)
    -> TaskRuntimeResult<()>;
pub fn block_projection(&self, claim: &ProjectionClaim, receipt: &EffectReceiptRef, now: i64)
    -> TaskRuntimeResult<()>;
```

Use `TransactionBehavior::Immediate`; every update includes status, owner, generation, and token in its predicate and requires exactly one changed row.

- [x] **Step 4: Run concurrency tests repeatedly**

Run: `for i in {1..20}; do cargo test -q -p local-first-task-runtime --test projection_outbox claim || exit 1; done`

Expected: every iteration passes.

- [x] **Step 5: Commit the claim protocol**

```bash
git add crates/task-runtime/src/projection_outbox.rs crates/task-runtime/tests/projection_outbox.rs
git commit -m "feat: fence projection outbox claims"
```

### Task 4: Typed chat projection and gateway worker

**Files:**
- Modify: `crates/desktop-gateway/src/execution_projection.rs`
- Create: `crates/desktop-gateway/src/projection_worker.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/execution_runtime.rs`

- [x] **Step 1: Add failing projector result tests**

Change the projector contract to return:

```rust
pub(crate) enum ProjectionAttempt {
    Completed,
    BlockedOnEffect(EffectReceiptRef),
}
```

Extend the current missing-message partial-projection test and channel uncertainty tests so the final turn event is absent until replay and a pending channel receipt becomes `BlockedOnEffect` instead of an apparent success.

- [x] **Step 2: Run focused gateway tests and confirm mismatch**

Run: `cargo test -p local-first-desktop-gateway execution_projection -- --nocapture`

Expected: new result assertions fail against the existing `Result<(), _>` API.

- [x] **Step 3: Implement the typed result without changing projection ownership**

Return `Completed` only after `emit_turn_event`. Return `BlockedOnEffect` on `ChannelProjectionDelivery::Pending`. Keep task/run/message/objective/wait writes idempotent and keep channel dispatch in `EffectHost`.

- [x] **Step 4: Implement a bounded worker**

`projection_worker.rs` owns worker scheduling only:

```rust
pub(crate) async fn drain_at_startup(state: &AppState, generation: u64) -> Result<usize, LocalTaskExecutionError>;
pub(crate) fn start(state: AppState, generation: u64);
pub(crate) fn notify();
```

The worker claims `chat_lifecycle`, loads `execution_revision`, validates scope against the task, invokes the projector, and completes or blocks through the claim API. Retryable SQLite contention receives bounded backoff; invariant violations preserve evidence and set module-owned persisted health read by the gateway endpoint. Startup attempts committed replay before orphan recovery, but defers failures to the independent worker so canonical outcomes cannot make the gateway unavailable.

- [x] **Step 5: Replace startup scan and notify after production commit**

After `bump_process_generation`, call `drain_at_startup`, then abort/recover only outcome-less orphan runs. Start the worker before task execution. Replace `replay_committed_chat_projections` calls with `projection_worker::notify()`; keep `ExecutionContract` and `ExecutionOutcome` unchanged and route every remote adapter output through `EffectHost`.

- [x] **Step 6: Run gateway and task-runtime tests**

Run: `cargo test -p local-first-desktop-gateway execution_projection -- --nocapture`

Run: `cargo test -p local-first-task-runtime --test projection_outbox -- --nocapture`

Expected: all pass.

- [x] **Step 7: Commit the worker**

```bash
git add crates/desktop-gateway/src/execution_projection.rs crates/desktop-gateway/src/projection_worker.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/execution_runtime.rs
git commit -m "feat: project committed outcomes from durable outbox"
```

### Task 5: Atomic receipt resolution requeue

**Files:**
- Modify: `crates/task-runtime/src/execution_store.rs`
- Modify: `crates/task-runtime/src/projection_outbox.rs`
- Modify: `crates/task-runtime/tests/effect_receipts.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [x] **Step 1: Add failing resolver transaction tests**

Seed a blocked outbox row and uncertain receipt. For both `Applied` and `NotApplied`, assert one call to `resolve_effect_receipt` changes the receipt and row to due `pending` atomically. A failing resolution must leave both unchanged. Concurrent resolution must not create duplicate claims.

- [x] **Step 2: Run focused tests and verify blocked rows remain blocked**

Run: `cargo test -p local-first-task-runtime --test effect_receipts resolution_requeues_projection -- --nocapture`

Expected: failure because resolution does not update outbox state.

- [x] **Step 3: Requeue inside the existing receipt transaction**

Move the outbox update into the transaction used by `resolve_effect_receipt`. Match only `blocked_on_ref`, clear block/error fields, and set `not_before` due. Return the number of requeued projections so the gateway can notify after commit.

- [x] **Step 4: Remove resolver history replay**

In the gateway resolver, replace `replay_committed_chat_projections(..., usize::MAX)` with a worker notification and report the requeued count. Preserve the per-receipt single-flight guard.

- [x] **Step 5: Run focused resolver tests**

Run: `cargo test -p local-first-task-runtime --test effect_receipts -- --nocapture`

Run: `cargo test -p local-first-desktop-gateway effect_resolution -- --nocapture`

Expected: all pass with no redispatch race.

- [x] **Step 6: Commit resolver integration**

```bash
git add crates/task-runtime/src/execution_store.rs crates/task-runtime/src/projection_outbox.rs crates/task-runtime/tests/effect_receipts.rs crates/desktop-gateway/src/main.rs
git commit -m "fix: requeue blocked projections with effect resolution"
```

### Task 6: Deterministic crash harness

**Files:**
- Create: `crates/task-runtime/tests/projection_crash_recovery.rs`
- Modify: `crates/desktop-gateway/src/execution_projection.rs`
- Modify: `crates/desktop-gateway/src/projection_worker.rs`

- [x] **Step 1: Add file-backed restart scenarios**

Use a unique SQLite path per test. Drop the first store at each persistence boundary, reopen it, bump process generation, and assert pending/claimed/completed state. Cover commit-before-notify, stale claim, acknowledgement-before-completion, and legacy backfill.

- [x] **Step 2: Exercise deterministic projection interruption boundaries**

Use the real missing-message invariant to stop after task/run projection but before message and terminal acknowledgement. Then persist the terminal acknowledgement through the direct idempotent projector while leaving the outbox pending, and prove that worker replay completes the row without a second event. This covers both partial-projection and acknowledgement-before-outbox-completion boundaries without adding a production or test crash switch.

- [x] **Step 3: Cover uncertain remote outcome convergence**

Combine the existing `EffectHost` dispatch-count tests with file-backed receipt/outbox recovery. Assert that an uncertain terminal channel receipt leaves the projection blocked, and that `Applied` or `NotApplied` resolution atomically returns the same row to `pending`; existing host tests retain the zero-or-one redispatch guarantee for the same receipt identity.

- [x] **Step 4: Run the crash matrix repeatedly**

Run: `for i in {1..10}; do cargo test -q -p local-first-task-runtime --test projection_crash_recovery || exit 1; done`

Run: `cargo test -p local-first-desktop-gateway projection_crash -- --nocapture`

Expected: all scenarios converge without duplicate terminal events or effects.

The implemented review hardening also verifies a 120-second stale-claim boundary,
renews active claims every 30 seconds under an RAII cancellation guard, checks claim currency before adapter output,
writes terminal and suspended `projection_ref` acknowledgements atomically, treats
sidecar `5xx` as ambiguous, and covers stable remote approval replay through the same
effect receipt contract. Stream transport errors remain nonterminal observations;
legacy unacknowledged errors are adopted atomically by canonical failed projections,
completed and uncertain channel receipts retain redacted route evidence. Claim validation
and adapter receipt claim are one transaction; a persistent supervisor isolates drain panics
and reclaims their expired claims in the same process generation. Per-execution claims are
revision ordered, and production callers only notify the supervisor instead of starting
overlapping drains.

- [x] **Step 5: Commit the crash harness**

```bash
git add crates/task-runtime/tests/projection_crash_recovery.rs crates/desktop-gateway/src/execution_projection.rs crates/desktop-gateway/src/projection_worker.rs
git commit -m "test: prove projection crash recovery"
```

### Task 7: Remove obsolete scan, document operations, and verify dev runtime

**Files:**
- Modify: `apps/desktop/electron/main.cjs`
- Create: `apps/desktop/tests/electron-gateway-startup.test.mjs`
- Modify: `crates/task-runtime/src/execution_store.rs`
- Modify: `crates/desktop-gateway/src/execution_projection.rs`
- Modify: `docs/TURN_CONTRACT.md`
- Modify: `docs/superpowers/specs/2026-07-29-projection-outbox-crash-recovery-design.md`
- Modify: `docs/superpowers/plans/2026-07-29-projection-outbox-crash-recovery.md`

- [x] **Step 1: Remove dead production replay code**

Delete `replay_committed_chat_projections` and the unbounded production scan. Keep only bounded diagnostic coverage if a migration assertion still requires it. Search for direct projection loops and ensure all production callers consume the outbox worker.

- [x] **Step 2: Update the runtime contract**

Document atomic enqueue, exact-revision delivery, claim fencing, blocked receipts, resolver requeue, error visibility, and the crash matrix in `TURN_CONTRACT.md`. Mark completed plan checkboxes and record any deliberately deferred work.

- [x] **Step 3: Run complete verification**

Run: `cargo test --workspace --quiet`

Run: `RUSTFLAGS='-D warnings' cargo build --workspace`

Run: `npm run build`

Run: `npm run test:ui-contract`

Run: `npm run test:electron`

Run: `git diff --check`

Expected: every command exits zero; Rust emits no warnings.

- [x] **Step 4: Restart and inspect the development version**

Stop only the development supervisor belonging to this worktree, start `npm run electron:dev`, verify Vite on `127.0.0.1:1420`, and require `GET http://127.0.0.1:18765/api/health` to return `ok: true`. Inspect startup logs for migration, stale-claim recovery, projector failures, and warnings.

The live cold rebuild exposed Electron's 60-second gateway wait as too short for
development Cargo builds and left the rejected bootstrap promise unhandled. Development
now allows 180 seconds while packaged startup remains bounded at 60 seconds; a terminal
startup handler logs, reports, and exits explicitly. The restarted worktree reached
generation 121 with both ports listening, healthy projection status, and no new warning,
error, failure, or panic diagnostics.

- [x] **Step 5: Commit final cleanup and documentation**

```bash
git add crates/task-runtime/src/execution_store.rs crates/desktop-gateway/src/execution_projection.rs docs/TURN_CONTRACT.md docs/superpowers/specs/2026-07-29-projection-outbox-crash-recovery-design.md docs/superpowers/plans/2026-07-29-projection-outbox-crash-recovery.md
git commit -m "docs: record durable projection recovery"
```
