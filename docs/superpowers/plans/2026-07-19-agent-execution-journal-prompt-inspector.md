# Agent Execution Journal and Prompt Inspector Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a durable, append-only journal for every broker-backed agent run and an authenticated API that exposes the latest redacted model-visible prompt without changing loop decisions or semantic memory.

**Architecture:** `local-first-task-runtime` owns the SQLite schema and typed read/write operations. `local-first-engine` owns provider-neutral journal events and emits them through a best-effort `ExecutionJournal` seam at control-flow boundaries. `local-first-desktop-gateway` creates one run per broker attempt, redacts and bounds prompt snapshots before enqueueing them to a background SQLite writer, finalizes the run, recovers interrupted runs, and exposes scope-checked read APIs.

**Tech Stack:** Rust, Tokio, rusqlite/SQLite WAL, Axum, serde/serde_json, SHA-256, existing Homun task broker and engine contracts.

---

## Task 1: Persist agent runs and append-only events

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/task-runtime/src/lib.rs`

- [ ] **Step 1: Write failing storage tests**

Add tests in `crates/task-runtime/src/store.rs` covering:

```rust
#[test]
fn agent_run_events_are_append_only_and_scope_filtered() {
    // create run, append seq 1 and 2, reject duplicate seq,
    // list only from the matching user/workspace and since cursor.
}

#[test]
fn latest_prompt_snapshot_returns_only_the_latest_snapshot() {
    // append two prompt_snapshot events and assert the second is returned.
}

#[test]
fn migration_v5_creates_agent_journal_tables_idempotently() {
    // open a v4-shaped database, migrate twice, assert schema_version == 5.
}
```

- [ ] **Step 2: Run the focused tests and confirm the expected failure**

Run: `cargo test -p local-first-task-runtime agent_run`

Expected: FAIL because the run/event types and store methods do not exist.

- [ ] **Step 3: Add typed journal records and migration v5**

Add serializable `AgentRun`, `AgentRunStatus`, `AgentRunEvent`, and `NewAgentRun` types. Add `agent_runs` and `agent_run_events` with the uniqueness, scope, foreign-key, and ordering indexes defined in the approved design. Bump `schema_version` from 4 to 5 while retaining guarded chat-turn migrations.

- [ ] **Step 4: Add minimal store operations**

Implement:

```rust
pub fn create_agent_run(&self, run: &NewAgentRun) -> TaskRuntimeResult<AgentRun>;
pub fn append_agent_run_event(&self, run_id: &str, seq: i64, round: Option<i64>, kind: &str, payload: &Value) -> TaskRuntimeResult<AgentRunEvent>;
pub fn finish_agent_run(&self, run_id: &str, status: AgentRunStatus, terminal_reason: Option<&str>) -> TaskRuntimeResult<()>;
pub fn list_agent_runs_for_turn(&self, turn_id: &str, user_id: &str, workspace_id: &str) -> TaskRuntimeResult<Vec<AgentRun>>;
pub fn list_agent_run_events(&self, run_id: &str, user_id: &str, workspace_id: &str, since: Option<i64>) -> TaskRuntimeResult<Vec<AgentRunEvent>>;
pub fn latest_agent_prompt_snapshot(&self, run_id: &str, user_id: &str, workspace_id: &str) -> TaskRuntimeResult<Option<AgentRunEvent>>;
pub fn abort_running_agent_runs(&self, terminal_reason: &str) -> TaskRuntimeResult<usize>;
```

Use a transaction for run creation plus the first `run_started` event so `(turn_id, attempt)` and sequence `1` become visible atomically.

- [ ] **Step 5: Run task-runtime tests**

Run: `cargo test -p local-first-task-runtime`

Expected: PASS, including migration from v4 and duplicate-sequence rejection.

- [ ] **Step 6: Commit**

```bash
git add crates/task-runtime/src/types.rs crates/task-runtime/src/store.rs crates/task-runtime/src/lib.rs
git commit -m "feat(runtime): persist agent execution journal"
```

## Task 2: Define the engine journal seam and prompt snapshots

**Files:**
- Create: `crates/engine/src/execution_journal.rs`
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/lib.rs`
- Modify: `crates/engine/src/agent_loop.rs`

- [ ] **Step 1: Write failing engine unit tests**

Add unit tests in `crates/engine/src/execution_journal.rs` for stable prompt fingerprints, ordered messages/tools, data-URL metadata replacement, 64 KiB truncation, and no-op recording. Add loop harness assertions that the emitted sequence includes `prompt_snapshot`, `model_response`, tool start/completion, plan update, compaction, forced synthesis, and exactly one terminal event where the exercised path applies.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cargo test -p local-first-engine execution_journal`

Expected: FAIL because `ExecutionJournal`, `AgentExecutionEvent`, and prompt snapshot construction are absent.

- [ ] **Step 3: Add provider-neutral journal types**

Implement a cloneable event enum and snapshot structs containing only engine-safe values. Compute stable SHA-256 fingerprints from canonical serialized values. Replace `data:*;base64,...` bodies with media type, encoded length, and hash before an event can leave the engine module. Bound the complete serialized snapshot to 64 KiB with explicit truncation metadata.

- [ ] **Step 4: Add the best-effort contract seam**

Add:

```rust
pub trait ExecutionJournal: Send + Sync {
    fn record(&self, event: AgentExecutionEvent);
}
```

Provide `NoopExecutionJournal`; add the journal dependency to `run_turn` without changing any branch condition or return value.

- [ ] **Step 5: Emit events at existing control-flow boundaries**

Record prompt snapshots immediately before each `ModelClient::generate`; model response metadata after it; tool start/completion around the single execution chokepoint; plan/compaction/forced-synthesis events where those state changes already occur; and one terminal event through the existing converged exit path. Journal failures remain unobservable to the loop.

- [ ] **Step 6: Run engine tests**

Run: `cargo test -p local-first-engine`

Expected: PASS with unchanged behavioral/parity tests and new journal assertions.

- [ ] **Step 7: Commit**

```bash
git add crates/engine/src/execution_journal.rs crates/engine/src/contract.rs crates/engine/src/lib.rs crates/engine/src/agent_loop.rs
git commit -m "feat(engine): emit agent execution events"
```

## Task 3: Add redaction and the bounded background writer

**Files:**
- Create: `crates/desktop-gateway/src/agent_journal.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Modify: `crates/desktop-gateway/Cargo.toml`

- [ ] **Step 1: Write failing gateway tests**

Test that prompt persistence redacts API keys, bearer tokens, common secret assignments, and nested JSON strings; never retains base64 image bodies; preserves message/tool order and hashes; drops oversize events rather than blocking; and flushes all accepted events before run finalization.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cargo test -p local-first-desktop-gateway agent_journal`

Expected: FAIL because the adapter and writer do not exist.

- [ ] **Step 3: Implement the redacting adapter**

Create `GatewayExecutionJournal`, backed by a bounded Tokio MPSC channel. `record` must use `try_send`, never wait, and update drop counters when full or closed. Recursively redact all string values before serialization and pass every prompt snapshot through the existing sensitive-text policy. Keep only metadata for data URLs.

- [ ] **Step 4: Implement the writer lifecycle**

Spawn one writer task per run. It opens a separate `TaskStore` connection to the task-runtime database, assigns monotonically increasing event sequence numbers, appends accepted events, and supports an explicit flush acknowledgement. A write error is logged and counted but never returned into engine control flow.

- [ ] **Step 5: Wire one run per broker attempt**

In `execute_chat_turn_task`, atomically create the run before opening the agent loop, pass the journal handle through `run_agent_turn_into_message_with_fanout` into `run_agent_rounds`, flush it on every terminal path, and then mark the run `completed`, `failed`, or `aborted`. Derive `attempt` from the broker task attempt and retain turn/thread/user/workspace provenance.

- [ ] **Step 6: Run gateway and integration tests**

Run: `cargo test -p local-first-desktop-gateway agent_journal`

Run: `cargo test -p local-first-desktop-gateway turn_executor`

Expected: PASS; a journal storage failure does not fail the chat turn.

- [ ] **Step 7: Commit**

```bash
git add crates/desktop-gateway/src/agent_journal.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/turn_executor.rs crates/desktop-gateway/Cargo.toml
git commit -m "feat(gateway): journal broker-backed agent runs"
```

## Task 4: Recover and retain journal data safely

**Files:**
- Modify: `crates/task-runtime/src/broker.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing recovery and purge tests**

Cover startup conversion of stale `running` runs to `aborted` with reason `gateway_restart`, preservation of prior events, deletion through the owning chat/thread purge flow, and retention cleanup that deletes complete runs/events together without touching active runs.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cargo test -p local-first-task-runtime agent_run_recovery`

Expected: FAIL because recovery and cleanup do not include journal records.

- [ ] **Step 3: Integrate startup recovery**

Extend broker boot recovery to mark all unfinished agent runs aborted before their chat tasks are requeued. Do not synthesize missing internal events; keep the durable prefix exactly as written.

- [ ] **Step 4: Integrate purge and retention**

Delete journal rows transactionally through their run foreign key when the owning chat data is purged. Add a bounded cleanup method for terminal runs older than the configured retention window; exclude `running` rows.

- [ ] **Step 5: Run task-runtime and gateway recovery tests**

Run: `cargo test -p local-first-task-runtime`

Run: `cargo test -p local-first-desktop-gateway recovery`

Expected: PASS, including boot recovery and purge ownership checks.

- [ ] **Step 6: Commit**

```bash
git add crates/task-runtime/src/broker.rs crates/task-runtime/src/store.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(runtime): recover and retain agent journals"
```

## Task 5: Expose the authenticated Prompt Inspector APIs

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `docs/superpowers/specs/2026-07-19-agent-execution-journal-prompt-inspector-design.md`

- [ ] **Step 1: Write failing route tests**

Add route tests for:

```text
GET /api/chat/turns/{turn_id}/runs
GET /api/chat/runs/{run_id}/events?since={seq}
GET /api/chat/runs/{run_id}/prompt/latest
```

Assert deterministic ordering/cursors, `404` for missing or foreign-scope runs, no raw/unredacted endpoint, and a prompt response containing fingerprint, truncation/redaction metadata, ordered messages, and ordered tool schemas.

- [ ] **Step 2: Run route tests and confirm failure**

Run: `cargo test -p local-first-desktop-gateway agent_run_api`

Expected: FAIL with route not found.

- [ ] **Step 3: Implement scope-checked handlers**

Use the same authenticated user/workspace context as existing chat routes. Resolve every read through store methods that join `agent_run_events` to `agent_runs` on the requested scope. Return metadata-only `404` for cross-scope IDs to avoid existence leaks.

- [ ] **Step 4: Update the design document with implemented limits**

Record the concrete retention default, queue capacity, truncation behavior, event schema version, and API response shapes. Do not widen scope to checkpoints, prompt packets, or Markdown ledgers.

- [ ] **Step 5: Run route and package tests**

Run: `cargo test -p local-first-desktop-gateway agent_run_api`

Run: `cargo test -p local-first-task-runtime -p local-first-engine -p local-first-desktop-gateway`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs docs/superpowers/specs/2026-07-19-agent-execution-journal-prompt-inspector-design.md
git commit -m "feat(api): expose agent prompt inspector"
```

## Task 6: Final quality and security gate

**Files:**
- Verify only; modify only if a failing check identifies an in-scope defect.

- [ ] **Step 1: Format and compile**

Run: `cargo fmt --all -- --check`

Run: `cargo check -p local-first-task-runtime -p local-first-engine -p local-first-desktop-gateway`

Expected: PASS.

- [ ] **Step 2: Run the complete targeted suite fresh**

Run: `cargo test -p local-first-task-runtime -p local-first-engine -p local-first-desktop-gateway`

Expected: PASS with no ignored or filtered failure described as green.

- [ ] **Step 3: Audit security invariants from persisted fixtures**

Inspect test databases and assert that seeded secret literals and base64 image payloads are absent from `agent_run_events.payload_json`; assert foreign-scope reads return no data; assert repeated prompt/event inserts do not create duplicates.

- [ ] **Step 4: Review the complete branch diff**

Run: `git diff --check main...HEAD`

Run: `git status --short`

Run: `git log --oneline main..HEAD`

Expected: no whitespace errors, only intentional files changed, and cohesive commits without co-author trailers.

- [ ] **Step 5: Commit any verification-only corrections**

If corrections were required, commit them as:

```bash
git add <corrected-files>
git commit -m "fix(agent-journal): address verification findings"
```

If no correction was required, do not create an empty commit.
