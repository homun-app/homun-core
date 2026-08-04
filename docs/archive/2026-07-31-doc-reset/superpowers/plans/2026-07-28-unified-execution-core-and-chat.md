# Unified Execution Core And Chat Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce Homun's single durable `execute(contract) -> ExecutionOutcome` protocol, make timer and signal suspension resumable, and migrate `chat_turn` so one committed outcome owns task, run, message, objective, wait, and terminal event projection.

**Architecture:** A new leaf crate owns only neutral protocol types, avoiding dependency cycles between engine, task runtime, and gateway. `TaskStore` owns the canonical execution journal and fencing commit; the gateway owns one idempotent projector into its existing read models. During this tranche only, the current engine `TurnOutcome` is normalized by the chat adapter; the old gateway `TaskExecutionOutcome` and terminal deduction are deleted for `chat_turn`, not wrapped permanently.

**Tech Stack:** Rust 2024, Tokio, serde/serde_json, rusqlite WAL transactions, existing task-runtime lease/scheduler, existing gateway chat/task stores.

---

## Scope Boundary

This plan completes the protocol core and the production `chat_turn` migration. It does not yet migrate every capability adapter, unify all effect receipts/checkpoint codecs, or add continue-as-new/sagas. Those are follow-up plans after this tranche proves the canonical protocol in the hardest user-facing path.

## File Map

- Create `crates/execution-protocol/`: dependency-light canonical contract, outcome, wake, failure, state, and journal event types.
- Create `crates/task-runtime/src/execution_store.rs`: durable execution records, events, wake delivery, and fenced outcome commit.
- Create `crates/task-runtime/src/execution_projection.rs`: pure task/run projection from canonical outcomes.
- Modify `crates/task-runtime/src/scheduler.rs`: wake due `At` conditions before selecting ready work.
- Create `crates/desktop-gateway/src/execution_projection.rs`: idempotent projection into chat message, agent run, objective, HITL wait, and turn event.
- Create `crates/desktop-gateway/src/execution_runtime.rs`: the only production `execute` entry point and internal adapter registry.
- Modify `crates/desktop-gateway/src/turn_executor.rs`: make chat an adapter returning canonical `ExecutionOutcome`; remove `ChatTurnRunBranch` and rereads used to infer terminal state.
- Modify `crates/desktop-gateway/src/main.rs`: call the unified runtime and remove the parked empty-`done` lifecycle workaround.

### Task 1: Add The Canonical Leaf Protocol

**Files:**
- Create: `crates/execution-protocol/Cargo.toml`
- Create: `crates/execution-protocol/src/lib.rs`
- Modify: `Cargo.toml`
- Modify: `crates/engine/Cargo.toml`
- Modify: `crates/task-runtime/Cargo.toml`
- Modify: `crates/desktop-gateway/Cargo.toml`

- [ ] **Step 1: Create the crate and write round-trip tests first**

Create `crates/execution-protocol/Cargo.toml`:

```toml
[package]
name = "local-first-execution-protocol"
version = "0.1.0"
edition = "2024"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

Add tests at the bottom of `crates/execution-protocol/src/lib.rs` that construct all four outcomes and every wake condition:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_outcomes_round_trip_without_domain_types() {
        let outcomes = [
            ExecutionOutcome::completed(json!({"ok": true})),
            ExecutionOutcome::Suspended {
                wake: WakeCondition::Signal {
                    kind: "connector.message".into(),
                    correlation_id: "msg-1".into(),
                },
                checkpoint: CheckpointEnvelope::empty("exec-1", 1, "chat_turn"),
            },
            ExecutionOutcome::Cancelled {
                reason: CancelReason::User,
            },
            ExecutionOutcome::Failed {
                failure: ExecutionFailure::permanent("no_reply", "No final reply"),
            },
        ];
        for outcome in outcomes {
            let encoded = serde_json::to_string(&outcome).unwrap();
            assert_eq!(serde_json::from_str::<ExecutionOutcome>(&encoded).unwrap(), outcome);
        }
    }

    #[test]
    fn wake_conditions_have_stable_dedup_keys() {
        assert_eq!(
            WakeCondition::Signal {
                kind: "connector.message".into(),
                correlation_id: "msg-1".into(),
            }
            .dedup_key(),
            "signal:connector.message:msg-1"
        );
    }
}
```

- [ ] **Step 2: Run the crate test and verify it fails**

Run: `cargo test -p local-first-execution-protocol`

Expected: FAIL because the workspace member and protocol types do not exist.

- [ ] **Step 3: Implement the dependency-light protocol**

Define these public types with `Serialize`, `Deserialize`, `Clone`, `Debug`, and equality derives where valid:

```rust
pub struct ExecutionContract {
    pub execution_id: String,
    pub parent_execution_id: Option<String>,
    pub kind: String,
    pub revision: u64,
    pub fencing_token: u64,
    pub scope: ExecutionScope,
    pub objective: Option<ObjectiveRef>,
    pub input: serde_json::Value,
    pub policy: ExecutionPolicy,
    pub resources: Vec<ResourceRequirement>,
    pub budget: ExecutionBudget,
    pub checkpoint: Option<CheckpointRef>,
    pub wake: Option<WakeDelivery>,
}

pub enum ExecutionOutcome {
    Completed { output: serde_json::Value, continuation: Option<ContinuationRef> },
    Suspended { wake: WakeCondition, checkpoint: CheckpointEnvelope },
    Cancelled { reason: CancelReason },
    Failed { failure: ExecutionFailure },
}

pub enum WakeCondition {
    At { unix_timestamp: i64 },
    Signal { kind: String, correlation_id: String },
    Resource { class: String },
    ModelAvailable { role: String },
    User { wait_ref: String },
    Approval { approval_ref: String },
    EffectResolution { receipt_ref: String },
}

pub enum FailureClass { Transient, Permanent, PolicyDenied }
pub enum CancelReason { User, Replaced, Expired, Shutdown }
pub enum ExecutionState { Ready, Running, Suspended, Completed, Cancelled, Failed }

pub struct ExecutionScope {
    pub user_id: String,
    pub workspace_id: String,
    pub thread_id: Option<String>,
}

pub struct ObjectiveRef { pub thread_id: String, pub revision: u64 }
pub struct CheckpointRef { pub checkpoint_id: String, pub schema_version: u32 }
pub struct ContinuationRef { pub execution_id: String }

pub struct ExecutionPolicy {
    pub allowed_effects: Vec<EffectClass>,
    pub approval_policy: String,
}

pub enum EffectClass {
    Read,
    FilesystemWrite,
    ArtifactCreation,
    ExternalWrite,
    RequestAuthorization,
}

pub struct ResourceRequirement { pub class: String, pub units: u32 }

pub struct ExecutionBudget {
    pub max_attempts: u32,
    pub backoff_seconds: i64,
    pub deadline_unix: Option<i64>,
}

pub struct WakeDelivery {
    pub dedup_key: String,
    pub payload: serde_json::Value,
    pub delivered_at_unix: i64,
}

pub struct CheckpointEnvelope {
    pub checkpoint_id: String,
    pub execution_id: String,
    pub revision: u64,
    pub producer_kind: String,
    pub schema_version: u32,
    pub sensitivity: PayloadSensitivity,
    pub payload: serde_json::Value,
    pub redacted_payload: serde_json::Value,
    pub secret_refs: Vec<String>,
}

pub enum PayloadSensitivity { Public, Redacted, SecretRefsOnly }
```

Implement `ExecutionContract::new(execution_id, kind, scope, input)` with revision and fencing token `1`, read-only default policy, empty resources, one-attempt budget, and no checkpoint/wake. Implement `ExecutionOutcome::completed`, `ExecutionFailure::{transient, permanent, policy_denied}`, and `CheckpointEnvelope::empty` exactly as used by the tests.

Keep references opaque strings scoped by `ExecutionScope`. Implement constructors used in the tests and `WakeCondition::dedup_key()` for every variant. Do not import engine, gateway, task-runtime, browser, Vault, or connector types.

- [ ] **Step 4: Add crate dependencies and run protocol tests**

Add the workspace member and path dependency from engine, task-runtime, and gateway. The new crate depends only on:

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

The three consumers use:

```toml
local-first-execution-protocol = { path = "../execution-protocol" }
```

Run: `cargo test -p local-first-execution-protocol`

Expected: both tests PASS with no warnings.

- [ ] **Step 5: Commit the protocol leaf**

```bash
git add Cargo.toml crates/execution-protocol crates/engine/Cargo.toml crates/task-runtime/Cargo.toml crates/desktop-gateway/Cargo.toml
git commit -m "feat: add canonical execution protocol"
```

### Task 2: Persist Executions And Commit Outcomes With Fencing

**Files:**
- Create: `crates/task-runtime/src/execution_store.rs`
- Create: `crates/task-runtime/tests/execution_store.rs`
- Modify: `crates/task-runtime/src/lib.rs`
- Modify: `crates/task-runtime/src/store.rs`

- [ ] **Step 1: Write failing store tests**

Create tests proving creation, event order, exactly-one outcome per revision, and stale-token rejection:

```rust
fn contract(id: &str, revision: u64, fence: u64) -> ExecutionContract {
    let mut contract = ExecutionContract::new(
        id,
        "chat_turn",
        ExecutionScope {
            user_id: "user".into(),
            workspace_id: "workspace".into(),
            thread_id: Some("thread".into()),
        },
        json!({"prompt": "hello"}),
    );
    contract.revision = revision;
    contract.fencing_token = fence;
    contract
}

#[test]
fn stale_fencing_token_cannot_commit_a_late_outcome() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-1", 1, 7);
    store.create_execution(&contract).unwrap();
    store.advance_execution_fence("exec-1", 1, 7, 8).unwrap();

    let late = store.commit_execution_outcome(
        "exec-1", 1, 7, &ExecutionOutcome::completed(json!({"late": true})),
    );
    assert!(matches!(late, Err(TaskRuntimeError::InvalidTransition(_))));

    let committed = store.commit_execution_outcome(
        "exec-1", 1, 8, &ExecutionOutcome::completed(json!({"ok": true})),
    ).unwrap();
    assert!(matches!(committed, OutcomeCommit::Inserted(_)));
}

#[test]
fn outcome_commit_is_idempotent_for_the_same_revision() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-1", 1, 4);
    store.create_execution(&contract).unwrap();
    let outcome = ExecutionOutcome::completed(json!({"ok": true}));
    assert!(matches!(store.commit_execution_outcome("exec-1", 1, 4, &outcome).unwrap(), OutcomeCommit::Inserted(_)));
    assert!(matches!(store.commit_execution_outcome("exec-1", 1, 4, &outcome).unwrap(), OutcomeCommit::Existing(_)));
}
```

- [ ] **Step 2: Run tests and verify missing APIs**

Run: `cargo test -p local-first-task-runtime --test execution_store`

Expected: FAIL because execution persistence APIs do not exist.

- [ ] **Step 3: Add schema version 12**

Add these tables in `TaskStore::run_migrations` and update metadata to `12`:

```sql
CREATE TABLE IF NOT EXISTS executions (
    execution_id TEXT PRIMARY KEY,
    parent_execution_id TEXT,
    kind TEXT NOT NULL,
    revision INTEGER NOT NULL,
    fencing_token INTEGER NOT NULL,
    state TEXT NOT NULL,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    thread_id TEXT,
    contract_json TEXT NOT NULL,
    outcome_json TEXT,
    outcome_committed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(execution_id, revision, seq),
    FOREIGN KEY(execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution_wakes (
    execution_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    dedup_key TEXT NOT NULL,
    condition_json TEXT NOT NULL,
    status TEXT NOT NULL,
    delivery_json TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    PRIMARY KEY(execution_id, revision, dedup_key),
    FOREIGN KEY(execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
);
```

- [ ] **Step 4: Implement transactional execution methods**

In `execution_store.rs`, add `impl TaskStore` methods:

```rust
pub fn create_execution(&self, contract: &ExecutionContract) -> TaskRuntimeResult<ExecutionRecord>;
pub fn execution(&self, execution_id: &str) -> TaskRuntimeResult<Option<ExecutionRecord>>;
pub fn append_execution_event(&self, execution_id: &str, revision: u64, kind: &str, payload: &Value) -> TaskRuntimeResult<ExecutionEvent>;
pub fn advance_execution_fence(&self, execution_id: &str, revision: u64, expected: u64, next: u64) -> TaskRuntimeResult<()>;
pub fn commit_execution_outcome(&self, execution_id: &str, revision: u64, fencing_token: u64, outcome: &ExecutionOutcome) -> TaskRuntimeResult<OutcomeCommit>;
```

Define the returned records in the same focused module:

```rust
pub struct ExecutionRecord {
    pub contract: ExecutionContract,
    pub state: ExecutionState,
    pub outcome: Option<ExecutionOutcome>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct ExecutionEvent {
    pub event_id: i64,
    pub execution_id: String,
    pub revision: u64,
    pub seq: u64,
    pub kind: String,
    pub payload: Value,
    pub created_at: i64,
}

pub enum OutcomeCommit {
    Inserted(ExecutionRecord),
    Existing(ExecutionRecord),
}
```

`commit_execution_outcome` must use one `TransactionBehavior::Immediate` transaction, verify revision and fence, return `Existing` only for byte-equivalent canonical JSON, append exactly one `outcome_committed` event, and reject a conflicting second outcome.

- [ ] **Step 5: Run store and migration tests**

Run:

```bash
cargo test -p local-first-task-runtime --test execution_store
cargo test -p local-first-task-runtime store::migration_tests
```

Expected: all PASS; schema version assertions expect `12`.

- [ ] **Step 6: Commit durable execution storage**

```bash
git add crates/task-runtime/src/lib.rs crates/task-runtime/src/store.rs crates/task-runtime/src/execution_store.rs crates/task-runtime/tests/execution_store.rs
git commit -m "feat: persist fenced execution outcomes"
```

### Task 3: Make Suspension Wakeable By Timer And Signal

**Files:**
- Create: `crates/task-runtime/tests/execution_wake.rs`
- Modify: `crates/task-runtime/src/execution_store.rs`
- Modify: `crates/task-runtime/src/scheduler.rs`
- Modify: `crates/task-runtime/src/facade.rs`

- [ ] **Step 1: Write the missing timer regression test**

```rust
fn suspended_at(
    execution_id: &str,
    revision: u64,
    unix_timestamp: i64,
) -> ExecutionOutcome {
    ExecutionOutcome::Suspended {
        wake: WakeCondition::At { unix_timestamp },
        checkpoint: CheckpointEnvelope::empty(execution_id, revision, "chat_turn"),
    }
}

#[test]
fn due_time_wake_returns_the_same_execution_to_ready() {
    let store = TaskStore::open_in_memory().unwrap();
    let now = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
    let contract = contract("exec-timer", 1, 1);
    store.create_execution(&contract).unwrap();
    store.commit_execution_outcome(
        "exec-timer", 1, 1,
        &suspended_at("exec-timer", 1, now.unix_timestamp()),
    ).unwrap();

    assert_eq!(store.wake_due_executions(now - Duration::seconds(1), 10).unwrap(), 0);
    assert_eq!(store.wake_due_executions(now, 10).unwrap(), 1);
    let resumed = store.execution("exec-timer").unwrap().unwrap();
    assert_eq!(resumed.state, ExecutionState::Ready);
    assert_eq!(resumed.revision, 2);
    assert!(resumed.contract.wake.is_some());
}
```

- [ ] **Step 2: Write signal correlation and dedup tests**

Test that a wrong `(kind, correlation_id)` wakes nothing, the matching delivery wakes once, and a duplicate delivery returns the existing receipt without incrementing revision again.

- [ ] **Step 3: Run wake tests and verify failure**

Run: `cargo test -p local-first-task-runtime --test execution_wake`

Expected: FAIL because wake persistence and delivery APIs are missing.

- [ ] **Step 4: Implement wake registration and delivery**

Add:

```rust
pub fn wake_due_executions(&self, now: OffsetDateTime, limit: usize) -> TaskRuntimeResult<usize>;
pub fn deliver_execution_signal(&self, kind: &str, correlation_id: &str, payload: &Value) -> TaskRuntimeResult<usize>;
```

Each successful wake transaction must mark the prior wake `delivered`, increment execution revision, increment fencing token, clear the committed outcome, set state `ready`, place a typed `WakeDelivery` in `contract_json`, and append `wake_delivered`. Duplicate delivery must be idempotent.

- [ ] **Step 5: Wire due wakes before ready selection**

Call `wake_due_executions(now, usize::MAX)` at the start of both `TaskRuntime::run_ready_once` and the gateway's `next_ready_task_across_workspaces`. During migration, project a due execution whose `execution_id == task_id` back to `TaskStatus::Queued`; this compatibility projection is deleted when all task kinds migrate.

- [ ] **Step 6: Run runtime tests**

Run:

```bash
cargo test -p local-first-task-runtime --test execution_wake
cargo test -p local-first-task-runtime --tests
```

Expected: all PASS, including a test named `due_time_wake_returns_the_same_execution_to_ready`.

- [ ] **Step 7: Commit wake support**

```bash
git add crates/task-runtime/src/execution_store.rs crates/task-runtime/src/scheduler.rs crates/task-runtime/src/facade.rs crates/task-runtime/tests/execution_wake.rs
git commit -m "feat: wake suspended executions by timer and signal"
```

### Task 4: Add One Pure Projection Table

**Files:**
- Create: `crates/task-runtime/src/execution_projection.rs`
- Create: `crates/task-runtime/tests/execution_projection.rs`
- Modify: `crates/task-runtime/src/lib.rs`
- Modify: `crates/task-runtime/src/types.rs`

- [ ] **Step 1: Write an exhaustive projection test**

Define one table-driven test covering completed, every suspension kind, cancelled, transient failure, permanent failure, and policy denial. Assert task status, agent-run status, terminality, and public event kind.

```rust
#[test]
fn every_canonical_outcome_has_one_projection() {
    let completed = ExecutionOutcome::completed(json!({"ok": true}));
    let timed = ExecutionOutcome::Suspended {
        wake: WakeCondition::At { unix_timestamp: 1_800_000_000 },
        checkpoint: CheckpointEnvelope::empty("timer", 1, "chat_turn"),
    };
    let model = ExecutionOutcome::Suspended {
        wake: WakeCondition::ModelAvailable { role: "chat".into() },
        checkpoint: CheckpointEnvelope::empty("model", 1, "chat_turn"),
    };
    let cases = [
        (completed, TaskStatus::Completed, Some(AgentRunStatus::Completed), true, ExecutionPublicEventKind::Completed),
        (timed, TaskStatus::WaitingTime, None, false, ExecutionPublicEventKind::Suspended),
        (model, TaskStatus::Parked, Some(AgentRunStatus::Aborted), false, ExecutionPublicEventKind::Suspended),
        (ExecutionOutcome::Cancelled { reason: CancelReason::User }, TaskStatus::Cancelled, Some(AgentRunStatus::Aborted), true, ExecutionPublicEventKind::Cancelled),
        (ExecutionOutcome::Failed { failure: ExecutionFailure::permanent("no_reply", "No reply") }, TaskStatus::Failed, Some(AgentRunStatus::Failed), true, ExecutionPublicEventKind::Failed),
    ];
    for (outcome, task_status, run_status, terminal, event_kind) in cases {
        let projection = ExecutionProjection::from_outcome(&outcome);
        assert_eq!(projection.task_status, task_status);
        assert_eq!(projection.run_status, run_status);
        assert_eq!(projection.terminal, terminal);
        assert_eq!(projection.event_kind, event_kind);
    }
}
```

- [ ] **Step 2: Run and verify the missing projection**

Run: `cargo test -p local-first-task-runtime --test execution_projection`

Expected: FAIL because `ExecutionProjection` does not exist.

- [ ] **Step 3: Implement the pure projection**

Use a single match on `ExecutionOutcome`:

```rust
pub struct ExecutionProjection {
    pub task_status: TaskStatus,
    pub run_status: Option<AgentRunStatus>,
    pub terminal: bool,
    pub event_kind: ExecutionPublicEventKind,
}

pub enum ExecutionPublicEventKind { Suspended, Completed, Cancelled, Failed }
```

Map `WakeCondition::At` to `WaitingTime`, `Signal` to `WaitingExternalEvent`, `ModelAvailable` to the existing nonterminal `Parked`, `Resource` to `WaitingResource`, `User|Approval|EffectResolution` to `WaitingUserApproval`, and terminal outcomes to their corresponding terminal status. Add explicit public event kinds for `Suspended`, `Completed`, `Cancelled`, and `Failed`; do not infer them from stream closure.

- [ ] **Step 4: Run projection tests**

Run: `cargo test -p local-first-task-runtime --test execution_projection`

Expected: all projection cases PASS.

- [ ] **Step 5: Commit the projection table**

```bash
git add crates/task-runtime/src/lib.rs crates/task-runtime/src/types.rs crates/task-runtime/src/execution_projection.rs crates/task-runtime/tests/execution_projection.rs
git commit -m "feat: project canonical execution outcomes"
```

### Task 5: Introduce The Only Gateway Execute Entry Point

**Files:**
- Create: `crates/desktop-gateway/src/execution_runtime.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/task_registry.rs`

- [ ] **Step 1: Write registry tests against adapters, not executor enums**

Replace `GatewayTaskExecutorKind` assertions with a test registry whose adapters record the received `ExecutionContract`. Assert `chat_turn`, `proactive_prompt`, and `capability.*` all enter the same `ExecutionRuntime::execute` method and preserve execution identity.

- [ ] **Step 2: Run the registry test and verify failure**

Run: `cargo test -p local-first-desktop-gateway task_registry::tests::all_kinds_use_the_same_execute_entry_point`

Expected: FAIL because the current registry returns an enum and `execute_read_only_task` dispatches separate functions.

- [ ] **Step 3: Implement the internal async adapter registry**

Create an object-safe adapter:

```rust
pub(crate) trait GatewayExecutionAdapter: Send {
    fn execute<'a>(
        &'a mut self,
        state: &'a AppState,
        contract: &'a ExecutionContract,
    ) -> futures_util::future::BoxFuture<'a, ExecutionOutcome>;
}
```

`ExecutionRuntime::execute` must be the only caller of adapters. It creates or loads the execution record, validates scope/revision/fence, appends `execution_started`, invokes the adapter, normalizes transient retry according to budget, commits the canonical outcome, and invokes the projector. No adapter receives `TaskStore` or `ChatStore` lifecycle mutation methods.

- [ ] **Step 4: Keep compatibility adapters explicit and bounded**

Add temporary adapters for non-chat task kinds that translate their existing result exactly once inside `execution_runtime.rs`. Name the function `legacy_task_outcome_to_execution_outcome` and add a deletion comment pointing to Task 8. Do not expose it from the module.

- [ ] **Step 5: Replace production dispatch**

Replace `execute_read_only_task` call sites in the worker with `execution_runtime.execute(contract)`. Build `ExecutionContract.execution_id` from the existing task ID, scope from task ownership, policy from `permission_context`, resources from task requirements, and fencing token from the acquired lease generation.

- [ ] **Step 6: Run gateway registry and task worker tests**

Run:

```bash
cargo test -p local-first-desktop-gateway task_registry::tests
cargo test -p local-first-desktop-gateway task_executor_
```

Expected: PASS; no production call to `execute_read_only_task` remains.

- [ ] **Step 7: Commit the unified entry point**

```bash
git add crates/desktop-gateway/src/execution_runtime.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/task_registry.rs
git commit -m "feat: route work through one execution entry point"
```

### Task 6: Migrate Chat Terminal Ownership

**Files:**
- Modify: `crates/engine/src/outcome.rs`
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/engine/src/browse.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Create: `crates/desktop-gateway/src/execution_projection.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Add characterization tests for all chat outcomes**

Add table tests proving these engine/gateway cases normalize exactly once:

```text
visible answer                 -> Completed
Choice/Clarify                 -> Suspended(User)
Hold approval                  -> Suspended(Approval)
steering model unavailable     -> Suspended(ModelAvailable)
manual cancel                  -> Cancelled(User)
empty/no final answer          -> Failed(Permanent:no_reply)
transient provider unavailable -> runtime Suspended(At)
```

Add a regression where a completed visible answer and a stale `Parked` task row coexist; the typed engine result must win without reading task status.

- [ ] **Step 2: Run the tests and verify current deduction fails them**

Run:

```bash
cargo test -p local-first-engine agent_loop::tests -- --nocapture
cargo test -p local-first-desktop-gateway turn_executor::tests -- --nocapture
```

Expected: new tests FAIL because `TurnDelivery`, `generated`, and task rereads still own branches.

- [ ] **Step 3: Make engine stop classification exhaustive**

Replace `TurnDelivery` with an engine-neutral stop enum that maps one-to-one to canonical outcomes without task/UI states:

```rust
pub enum TurnStop {
    Completed,
    SuspendedUser,
    SuspendedApproval,
    SuspendedModel { role: String },
    Failed { failure: ExecutionFailure },
}
```

Keep answer, structured HITL envelope, actionable approval data, memory reads, sources, plan, and other domain data in `TurnOutcome`; add `stop: TurnStop`. Cancellation remains runtime-owned because it races outside the model future. Every return from `run_turn` must set `stop` explicitly.

- [ ] **Step 4: Return canonical chat outcomes directly**

Make the chat adapter map `TurnOutcome.stop` to `ExecutionOutcome` and include the final answer and projection references in completed output/checkpoint metadata. For user or approval suspension, register the structured domain record through `ExecutionContext` under the deterministic scoped reference `<execution_id>:<revision>:user|approval`, then place only that reference in `WakeCondition`. Registration may create domain data but may not update task, run, message, objective, or event lifecycle state. Delete `ChatTurnRunBranch`, `ObjectiveTerminalProjection`, `classify_chat_turn_run`, `generated` terminal classification, and the task-status reread used to detect parked.

- [ ] **Step 5: Implement one idempotent gateway projector**

In `execution_projection.rs`, consume the committed outcome and execution output references. Apply message delivery, agent run, objective revision, activation of the pre-registered HITL/approval record, and turn event from one match. Before each mutation, check whether that projection already reflects the committed `(execution_id, revision)`; retries must be no-ops.

For suspended chat work emit a durable `TurnEventKind::Suspended` carrying only wake kind and scoped reference. For completion emit `Done`; for cancellation emit `Cancelled`; for failure emit `Error`.

- [ ] **Step 6: Remove parked transport semantics**

Replace the empty `done` used to unblock the SSE drain with a non-lifecycle transport close. The drain must finish when the canonical outcome is committed, not when it sees fabricated answer text. Delete comments and branches that describe empty `done` as parked ownership.

- [ ] **Step 7: Run engine and gateway contract tests**

Run:

```bash
cargo test -p local-first-engine
cargo test -p local-first-desktop-gateway turn_executor::tests -- --nocapture
cargo test -p local-first-desktop-gateway execution_projection -- --nocapture
```

Expected: all PASS; `rg "ChatTurnRunBranch|classify_chat_turn_run|ObjectiveTerminalProjection" crates/desktop-gateway/src` returns no matches.

- [ ] **Step 8: Commit chat migration**

```bash
git add crates/engine/src/outcome.rs crates/engine/src/agent_loop.rs crates/engine/src/browse.rs crates/desktop-gateway/src/turn_executor.rs crates/desktop-gateway/src/execution_projection.rs crates/desktop-gateway/src/main.rs
git commit -m "feat: give chat turns one terminal owner"
```

### Task 7: Prove Crash, Cancel, Wait, And Projection Convergence

**Files:**
- Create: `crates/desktop-gateway/tests/unified_execution_contract.rs`
- Modify: `crates/task-runtime/src/broker.rs`
- Modify: `crates/desktop-gateway/src/execution_projection.rs`

- [ ] **Step 1: Add restart and projection replay integration tests**

Create file-backed store tests that:

1. commit `Completed`, fail message projection, reopen stores, replay, and converge message/task/run/objective;
2. commit `Suspended(ModelAvailable)`, restart, deliver the wake, and resume the same execution ID at revision + 1;
3. race user cancellation with a late completed result and prove the stale fence cannot overwrite cancellation;
4. commit `Suspended(User)`, resolve Choice, and prove resolution calls the same `execute` entry point.

- [ ] **Step 2: Run and verify the integration failures**

Run: `cargo test -p local-first-desktop-gateway --test unified_execution_contract -- --nocapture`

Expected: FAIL until replay hooks and cancellation fence are wired.

- [ ] **Step 3: Wire startup projection replay**

At gateway startup, scan committed execution outcomes whose projection revision is behind. Replay them before accepting new work. Keep broker stale-lease recovery responsible only for fencing and requeue; it must not synthesize a competing terminal event.

- [ ] **Step 4: Run convergence tests repeatedly**

Run:

```bash
for i in 1 2 3 4 5; do cargo test -p local-first-desktop-gateway --test unified_execution_contract -- --nocapture || exit 1; done
```

Expected: five clean passes with no duplicate terminal event or status resurrection.

- [ ] **Step 5: Commit convergence recovery**

```bash
git add crates/desktop-gateway/tests/unified_execution_contract.rs crates/task-runtime/src/broker.rs crates/desktop-gateway/src/execution_projection.rs
git commit -m "test: prove unified execution convergence"
```

### Task 8: Delete First-Tranche Compatibility Paths

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Modify: `crates/desktop-gateway/src/task_registry.rs`
- Modify: `crates/task-runtime/src/executor.rs`
- Modify: `crates/task-runtime/src/facade.rs`
- Modify: `docs/superpowers/specs/2026-07-28-unified-execution-protocol-design.md`

- [ ] **Step 1: Inventory remaining bypasses**

Run:

```bash
rg -n 'execute_read_only_task|TaskExecutionOutcome|ChatTurnRunBranch|classify_chat_turn_run|mark_task_waiting_time|mark_task_waiting_external|empty `done`|persist_hitl_wait_from_parts' crates
rg -n "\.status = TaskStatus::|update_task_status\(" crates/desktop-gateway/src crates/engine/src
```

Classify each remaining match as a migrated projection, a non-chat compatibility adapter scheduled for the next plan, or an illegal production bypass. Remove every illegal/chat-owned match now.

- [ ] **Step 2: Delete chat-specific compatibility code**

Delete the old chat construction of `TaskExecutionOutcome`, marker/event-part HITL lifecycle persistence, parked status rereads, and manual message/task/run terminal branches. Keep marker parsing only as input normalization if a legacy model still emits it; it may not persist or choose lifecycle state.

- [ ] **Step 3: Add an architectural guard test**

Add a test or source guard that fails if `turn_executor.rs` writes `TaskStatus`, `AgentRunStatus`, or `MessageDeliveryState` outside `execution_projection.rs`, or if `main.rs` dispatches `chat_turn` without `ExecutionRuntime::execute`.

- [ ] **Step 4: Run formatting, warnings, and all Rust tests**

Run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

Expected: exit 0, no warnings, no ignored new failures.

- [ ] **Step 5: Run desktop tests and build**

Run the repository's existing desktop scripts from `apps/desktop`:

```bash
npm run test:electron
npm run build
```

Expected: both exit 0.

- [ ] **Step 6: Update the spec audit and commit cleanup**

Record implemented core/chat guarantees and list non-chat adapter, receipt/checkpoint, and continue-as-new work as explicit next plans.

```bash
git add crates docs/superpowers/specs/2026-07-28-unified-execution-protocol-design.md
git commit -m "refactor: remove duplicate chat lifecycle paths"
```

### Task 9: Run The Development Smoke

**Files:**
- Modify only if the smoke exposes a defect covered by this specification.

- [ ] **Step 1: Identify installed and development processes**

Run `lsof -nP -iTCP:1420 -iTCP:18765 -sTCP:LISTEN` and inspect the owning command before starting dev. Do not test `/Applications/homun.app` as though it were the worktree build.

- [ ] **Step 2: Start the development app**

Run `npm run electron:dev` from `apps/desktop`. Use a free alternate port only if the configured port is genuinely occupied by another required process.

- [ ] **Step 3: Exercise the contract matrix**

Verify in the real UI:

1. simple answer completes;
2. Choice suspends and resumes the same execution;
3. approval Hold remains waiting until approval;
4. model-unavailable park stays nonterminal and resumes;
5. cancellation beats a late result;
6. timer wake resumes automatically;
7. no answer text remains `streaming` after a committed outcome.

- [ ] **Step 4: Inspect durable state after each case**

Query execution record/events plus task, agent run, message delivery, objective, and wait rows. Their projections must agree with the single committed outcome and revision.

- [ ] **Step 5: Record verification and commit**

Add a dated verification section to the spec with commands, test counts, dev version, and observed execution IDs. Do not claim effects/checkpoint/continue-as-new migration completed in this tranche.

```bash
git add docs/superpowers/specs/2026-07-28-unified-execution-protocol-design.md
git commit -m "docs: verify unified execution core"
```
