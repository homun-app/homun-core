# Agent Loop Roadmap Completion Implementation Plan

> **Execution mode:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Homun's remaining agent-loop roadmap with a canonical runtime-plan store, resumable round checkpoints, at-most-once tool receipts, hierarchical prompt packets, a deterministic Working Ledger, and a desktop execution inspector.

**Architecture:** `local-first-task-runtime` owns all new durable control-state in schema v6. `local-first-engine` exposes serializable checkpoint/prompt contracts without knowing SQLite. `local-first-desktop-gateway` binds scope, redaction, recovery and projections, while the React Workbench consumes authenticated read-only APIs.

**Tech Stack:** Rust, rusqlite/SQLite WAL, Tokio, Axum, serde/serde_json, SHA-256, React 19, TypeScript, Vite.

---

## File map

- `crates/task-runtime/src/types.rs`: runtime plan, checkpoint and receipt records.
- `crates/task-runtime/src/store.rs`: schema v6 and scoped transactional operations.
- `crates/engine/src/loop_checkpoint.rs`: engine-safe checkpoint snapshot/restore.
- `crates/engine/src/prompt_packets.rs`: deterministic packet composition and fingerprints.
- `crates/engine/src/contract.rs`: checkpoint seam and serializable tool effects.
- `crates/engine/src/agent_loop.rs`: safe-point checkpoint emission.
- `crates/desktop-gateway/src/agent_journal.rs`: redacted checkpoint writer messages.
- `crates/desktop-gateway/src/turn_executor.rs`: recovery lookup and terminal ledger materialization.
- `crates/desktop-gateway/src/working_ledger.rs`: deterministic Markdown projection.
- `crates/desktop-gateway/src/main.rs`: canonical plan integration, receipts, prompt hierarchy and APIs.
- `apps/desktop/src/lib/chatApi.ts`: inspector API contracts.
- `apps/desktop/src/components/ExecutionInspector.tsx`: read-only execution view.
- `apps/desktop/src/components/ChatView.tsx`: Workbench tab integration.
- `apps/desktop/src/styles.css`: inspector presentation.

## Task 1: Schema v6 and canonical runtime plan

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/task-runtime/src/lib.rs`
- Test: `crates/task-runtime/src/store.rs`

- [ ] **Step 1: Write failing runtime-plan tests**

Add tests proving scope isolation, monotonic revision, settled status, stall bookkeeping and cascade through thread/workspace purge:

```rust
#[test]
fn runtime_plan_is_scoped_and_revisioned() {
    let store = TaskStore::open_in_memory().unwrap();
    let first = store.upsert_runtime_plan("u", "w", "t", &json!({"steps": []}), "open").unwrap();
    let second = store.upsert_runtime_plan("u", "w", "t", &json!({"steps": [1]}), "open").unwrap();
    assert_eq!((first.revision, second.revision), (1, 2));
    assert!(store.load_runtime_plan("u", "other", "t").unwrap().is_none());
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cargo test -p local-first-task-runtime runtime_plan_is_scoped_and_revisioned --quiet`

Expected: compile failure because the methods and record type do not exist.

- [ ] **Step 3: Add schema and typed operations**

Implement schema v6 plus:

```rust
pub fn upsert_runtime_plan(&self, user: &str, workspace: &str, thread: &str, plan: &Value, status: &str) -> TaskRuntimeResult<RuntimePlanRecord>;
pub fn load_runtime_plan(&self, user: &str, workspace: &str, thread: &str) -> TaskRuntimeResult<Option<RuntimePlanRecord>>;
pub fn bump_runtime_plan_stall(&self, user: &str, workspace: &str, thread: &str, current_done: usize) -> TaskRuntimeResult<Option<RuntimePlanRecord>>;
pub fn purge_runtime_plan_for_thread(&self, user: &str, workspace: &str, thread: &str) -> TaskRuntimeResult<usize>;
```

Use `TransactionBehavior::Immediate` for revision and stall updates.

- [ ] **Step 4: Run runtime tests and verify GREEN**

Run: `cargo test -p local-first-task-runtime runtime_plan --quiet`

Expected: all runtime-plan and migration tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/task-runtime/src/types.rs crates/task-runtime/src/store.rs crates/task-runtime/src/lib.rs
git commit -m "feat(runtime): add canonical agent control state"
```

## Task 2: Move gateway plan authority out of memory

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing gateway tests**

Create a state with no runtime-plan memory, persist a `runtime_plans` row, and assert `load_runtime_plan_from_state` and plan precedence see it. Add a second same-named thread in another workspace and prove isolation.

- [ ] **Step 2: Run and verify RED**

Run: `cargo test -p local-first-desktop-gateway runtime_plan_control_store --quiet`

Expected: test failure because loaders still query memory.

- [ ] **Step 3: Replace authoritative reads/writes**

Resolve the workspace from `ChatStore::workspace_for_thread`, then use `TaskStore` in:

```rust
fn load_runtime_plan_from_state(state: &AppState, thread_id: Option<&str>) -> Vec<Value>;
fn thread_has_active_runtime_plan(state: &AppState, thread_id: Option<&str>) -> bool;
fn plan_stall_check_and_bump(state: &AppState, thread_id: Option<&str>, plan: &[Value]) -> bool;
```

`GatewayPlanProgress::persist_plan` writes the canonical store first, then updates the legacy memory/graph projection best-effort. Thread deletion purges both plan and journal.

- [ ] **Step 4: Run gateway plan tests and verify GREEN**

Run: `cargo test -p local-first-desktop-gateway runtime_plan --quiet`

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): make task store authoritative for plans"
```

## Task 3: Round checkpoints and crash recovery

**Files:**
- Create: `crates/engine/src/loop_checkpoint.rs`
- Modify: `crates/engine/src/lib.rs`
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/loop_state.rs`
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/desktop-gateway/src/agent_journal.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Modify: `crates/desktop-gateway/src/lib.rs`

- [ ] **Step 1: Write failing checkpoint tests**

Test stable fingerprint, no API key, data-URL removal, round ordering and recovery selection restricted to `aborted/gateway_restart`:

```rust
#[test]
fn checkpoint_roundtrip_excludes_provider_secret() {
    let mut state = LoopState::new();
    state.provider.api_key = Some("sk-secret".into());
    let cp = LoopCheckpoint::from_state(3, &state);
    assert!(!serde_json::to_string(&cp).unwrap().contains("sk-secret"));
    assert_eq!(cp.round, 3);
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test -p local-first-engine checkpoint --quiet`

- [ ] **Step 3: Implement the engine checkpoint seam**

Add serializable `LoopCheckpoint` and:

```rust
pub trait CheckpointSink: Send + Sync {
    fn save(&self, checkpoint: LoopCheckpoint);
}
```

Emit at the start of each round after pruning/compaction, before the next model call. Restore only engine-safe fields; provider credentials always come from the fresh gateway configuration.

- [ ] **Step 4: Persist checkpoints through the journal writer**

Add `WriterMessage::Checkpoint`, `TaskStore::append_agent_checkpoint`, checksum validation, and `latest_resumable_checkpoint_for_turn`. Redact with the journal policy before persistence.

- [ ] **Step 5: Load recovery into the next broker attempt**

`turn_executor` loads a checkpoint before generation and passes it as `agent_checkpoint` in `ChatGenerateStreamRequest`. The gateway restores it before seeding a fresh `LoopState`; invalid checkpoints fall back to the normal seed.

- [ ] **Step 6: Run engine/runtime/gateway checkpoint tests**

Run: `cargo test -p local-first-engine checkpoint --quiet`

Run: `cargo test -p local-first-task-runtime checkpoint --quiet`

Run: `cargo test -p local-first-desktop-gateway checkpoint --quiet`

- [ ] **Step 7: Commit**

```bash
git add crates/engine crates/task-runtime crates/desktop-gateway/src/agent_journal.rs crates/desktop-gateway/src/turn_executor.rs crates/desktop-gateway/src/lib.rs
git commit -m "feat(agent): resume from durable round checkpoints"
```

## Task 4: At-most-once receipts for effectful tools

**Files:**
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing receipt tests**

Test atomic claim, completed replay, uncertain started state and scope-safe cleanup:

```rust
#[test]
fn tool_receipt_never_reclaims_uncertain_started_action() {
    let store = TaskStore::open_in_memory().unwrap();
    assert!(matches!(store.claim_tool_receipt(&receipt()).unwrap(), ToolReceiptClaim::Execute));
    assert!(matches!(store.claim_tool_receipt(&receipt()).unwrap(), ToolReceiptClaim::Uncertain));
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test -p local-first-task-runtime tool_receipt --quiet`

- [ ] **Step 3: Add serializable effects and receipt operations**

Derive `Clone`, `Serialize` and `Deserialize` for `LoadedTool` and `ToolEffects`. Implement claim/complete/list operations with an immediate transaction and immutable `(turn_id, idempotency_key)`.

- [ ] **Step 4: Wrap the gateway capability chokepoint**

For effectful native/connector/MCP tools, hash canonical arguments before dispatch. Replay `completed`; return a visible recovery result for `started`; otherwise execute once and persist redacted result/effects. Read-only tools remain unchanged.

- [ ] **Step 5: Run receipt and executor tests**

Run: `cargo test -p local-first-task-runtime tool_receipt --quiet`

Run: `cargo test -p local-first-desktop-gateway tool_receipt --quiet`

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/contract.rs crates/task-runtime/src crates/desktop-gateway/src/main.rs
git commit -m "feat(agent): prevent duplicate effectful tool execution"
```

## Task 5: Prompt packets and project instruction hierarchy

**Files:**
- Create: `crates/engine/src/prompt_packets.rs`
- Modify: `crates/engine/src/execution_journal.rs`
- Modify: `crates/engine/src/lib.rs`
- Modify: `crates/engine/src/loop_state.rs`
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing packet tests**

Cover stable ordering for equal priority, fingerprint changes, 32 KiB project cap and rejection of paths outside the linked root.

- [ ] **Step 2: Run and verify RED**

Run: `cargo test -p local-first-engine prompt_packet --quiet`

- [ ] **Step 3: Implement packet composition**

Add `PromptPacketSource`, `PromptPacket`, `PromptPacketMetadata` and `compose_prompt_packets`. Store metadata in `LoopState` and include it in every `PromptSnapshot`.

- [ ] **Step 4: Load project hierarchy**

Read root `AGENTS.md` followed by `.homun/instructions.md` from the authorized project directory, cap each input, and compose them after the existing core packet. Add route/runtime policy as the highest-priority packet.

- [ ] **Step 5: Run packet and prompt-inspector tests**

Run: `cargo test -p local-first-engine prompt --quiet`

Run: `cargo test -p local-first-desktop-gateway prompt --quiet`

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src crates/desktop-gateway/src/main.rs
git commit -m "feat(prompt): compose hierarchical instruction packets"
```

## Task 6: Working Ledger and thread-scoped APIs

**Files:**
- Create: `crates/desktop-gateway/src/working_ledger.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Modify: `crates/task-runtime/src/store.rs`

- [ ] **Step 1: Write failing ledger tests**

Seed a plan, two runs, events, checkpoint and receipt; assert deterministic Markdown, redaction, regeneration after file deletion and foreign-scope `404`.

- [ ] **Step 2: Run and verify RED**

Run: `cargo test -p local-first-desktop-gateway working_ledger --quiet`

- [ ] **Step 3: Add scoped read models and renderer**

Implement recent runs by thread, latest checkpoint, receipts and runtime-plan projection. Render fixed sections and stable ordering without raw payloads.

- [ ] **Step 4: Materialize and expose APIs**

Write `ledgers/<sha256(thread_id)>.md` after run finalization. Add thread runs, runtime-plan, ledger and latest checkpoint endpoints under the existing bearer-auth router. Delete the file during thread purge.

- [ ] **Step 5: Run ledger/API tests**

Run: `cargo test -p local-first-desktop-gateway working_ledger --quiet`

Run: `cargo test -p local-first-desktop-gateway agent_run_api --quiet`

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/working_ledger.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/turn_executor.rs crates/task-runtime/src/store.rs
git commit -m "feat(agent): generate deterministic working ledger"
```

## Task 7: Desktop Execution Inspector

**Files:**
- Create: `apps/desktop/src/components/ExecutionInspector.tsx`
- Create: `apps/desktop/src/lib/executionInspector.mjs`
- Create: `apps/desktop/src/lib/executionInspector.test.mjs`
- Modify: `apps/desktop/src/lib/chatApi.ts`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write failing view-model test**

Test ordering, selected latest run, packet labels, terminal state and empty data using Node's built-in test runner.

- [ ] **Step 2: Run and verify RED**

Run: `node --test apps/desktop/src/lib/executionInspector.test.mjs`

Expected: module-not-found before the view-model is created.

- [ ] **Step 3: Implement API types and view model**

Add typed fetchers for thread runs, events, prompt, checkpoint and ledger. Normalize them into a stable inspector model without using `any`.

- [ ] **Step 4: Implement the Workbench tab**

Add `execution` to `WorkbenchTab`, panel metadata and rendering. The component loads when opened, allows selecting an attempt, and displays status, timeline, packet metadata, redacted messages/tools and ledger.

- [ ] **Step 5: Run UI tests and build**

Run: `node --test apps/desktop/src/lib/executionInspector.test.mjs`

Run: `npm --prefix apps/desktop run typecheck`

Run: `npm --prefix apps/desktop run build`

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src apps/desktop/package.json
git commit -m "feat(desktop): add agent execution inspector"
```

## Task 8: Final migration and whole-branch verification

**Files:**
- Modify only if verification exposes a regression.

- [ ] **Step 1: Run focused security scans**

Run journal/checkpoint/receipt fixtures and assert persisted/API/ledger output omits `sk-test`, bearer values and base64 bodies.

- [ ] **Step 2: Run all relevant Rust suites**

Run:

```bash
cargo check -p local-first-task-runtime -p local-first-engine -p local-first-desktop-gateway
cargo test -p local-first-task-runtime -p local-first-engine -p local-first-desktop-gateway --quiet
```

Expected: exit code `0` and no failed tests.

- [ ] **Step 3: Run desktop gates**

Run:

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:ui-contract
```

- [ ] **Step 4: Run repository hygiene checks**

Run: `git diff --check main...HEAD`

Confirm the worktree is clean and the main checkout's unrelated `homun-tablet-full.png` remains untouched.

- [ ] **Step 5: Commit final documentation/status changes**

```bash
git add docs/superpowers/specs/2026-07-19-agent-loop-roadmap-completion-design.md docs/superpowers/plans/2026-07-19-agent-loop-roadmap-completion.md
git commit -m "docs: complete agent loop roadmap status"
```
