# Provider Usage Phase A: Ledger and Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every known model attempt in a metadata-only append-only ledger and expose trusted usage aggregates.

**Architecture:** A new lightweight `inference-usage` crate defines contexts, normalized measurements and a recorder port shared by engine and structured inference. The desktop gateway implements a bounded fail-open writer plus a query store on the unified `homun.sqlite`; callers supply explicit purposes and transport adapters record actual retry/fallback attempts.

**Tech Stack:** Rust, serde, rusqlite/SQLite WAL, std sync channel, Axum, reqwest.

---

## File map

- Create `crates/inference-usage/Cargo.toml`: lightweight shared contract crate with serde only.
- Create `crates/inference-usage/src/lib.rs`: purpose, context, attempt event, normalized usage and recorder trait.
- Modify `Cargo.toml`: add the new workspace member.
- Modify `crates/engine/Cargo.toml`, `crates/inference/Cargo.toml`, `crates/subagents/Cargo.toml`, `crates/desktop-gateway/Cargo.toml`: depend on the shared crate.
- Create `crates/desktop-gateway/src/usage_store.rs`: SQLite schema, append/query/recovery/purge and bounded recorder.
- Modify `crates/desktop-gateway/src/main.rs`: state wiring, startup recovery, usage routes and purpose propagation.
- Modify `crates/desktop-gateway/src/lib.rs`: export the store module for integration tests.
- Modify `crates/engine/src/contract.rs`, `crates/engine/src/agent_loop.rs`: require `UsageContext` on every streaming round.
- Modify `crates/desktop-gateway/src/model_client.rs`: record every actual HTTP attempt, including retry and fallback.
- Create `crates/desktop-gateway/src/inference_transport.rs`: centralize and record non-streaming OpenAI-compatible and Ollama embedding sends.
- Modify `crates/desktop-gateway/src/turn_executor.rs`: build the chat/run context once and pass it through.
- Modify `crates/subagents/src/types.rs`: require explicit usage context on text/JSON/classification requests.
- Modify `crates/inference/src/provider.rs`, `router.rs`, `openai_compat.rs`, `anthropic.rs`, `mistralrs_provider.rs`: record structured inference attempts.
- Modify structured-request call sites in `crates/orchestrator`, `crates/subagents` and `crates/desktop-gateway` using the purpose map in Task 5.
- Modify `crates/desktop-gateway/src/document_content.rs` and `crates/desktop-gateway/src/vision.rs`: route document and vision model sends through the recorded transport.
- Modify `crates/desktop-gateway/src/workspace_delete.rs`: purge workspace-owned usage.
- Create `crates/desktop-gateway/tests/usage_ledger.rs`: file-backed integration coverage.

### Task 1: Add the shared usage contracts

**Files:**
- Create: `crates/inference-usage/Cargo.toml`
- Create: `crates/inference-usage/src/lib.rs`
- Modify: `Cargo.toml`
- Modify: `crates/engine/Cargo.toml`
- Modify: `crates/inference/Cargo.toml`
- Modify: `crates/subagents/Cargo.toml`
- Modify: `crates/desktop-gateway/Cargo.toml`

- [ ] **Step 1: Write contract tests before the implementation**

Add `#[cfg(test)] mod tests` in the new `lib.rs` with these assertions:

```rust
#[test]
fn purpose_round_trips_without_prompt_inference() {
    let encoded = serde_json::to_string(&InferencePurpose::MemoryExtraction).unwrap();
    assert_eq!(encoded, "\"memory_extraction\"");
}

#[test]
fn attempt_event_contains_no_content_fields() {
    let event = UsageAttemptEvent::started(
        UsageContext::new("call-1", InferencePurpose::ChatResponse, "local"),
        "attempt-1",
        "openrouter",
        "model-a",
        Locality::Cloud,
        100,
    );
    let value = serde_json::to_value(event).unwrap();
    assert!(value.get("prompt").is_none());
    assert!(value.get("response").is_none());
    assert!(value.get("api_key").is_none());
}
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `cargo test -p local-first-inference-usage`

Expected: FAIL because the crate and its contract types do not exist.

- [ ] **Step 3: Implement the minimal shared contract**

Define these public types in `crates/inference-usage/src/lib.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InferencePurpose {
    ChatResponse,
    TitleGeneration,
    IntentRouting,
    Planning,
    MemoryExtraction,
    MemoryRecall,
    MemoryCompaction,
    Embedding,
    Subagent,
    Automation,
    ArtifactGeneration,
    VisionAnalysis,
    Evaluation,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Locality { Local, Cloud }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UsageContext {
    pub call_id: String,
    pub purpose: InferencePurpose,
    pub purpose_detail: Option<String>,
    pub user_id: String,
    pub workspace_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub round: Option<u32>,
}

impl UsageContext {
    pub fn new(call_id: impl Into<String>, purpose: InferencePurpose, user_id: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(), purpose, purpose_detail: None, user_id: user_id.into(),
            workspace_id: None, thread_id: None, turn_id: None, run_id: None,
            task_id: None, round: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NormalizedUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptEventKind { AttemptStarted, AttemptCompleted, AttemptFailed, AttemptAborted }

pub trait UsageRecorder: Send + Sync {
    fn record(&self, event: UsageAttemptEvent);
}

#[derive(Default)]
pub struct NoopUsageRecorder;
impl UsageRecorder for NoopUsageRecorder {
    fn record(&self, _event: UsageAttemptEvent) {}
}
```

`UsageAttemptEvent` must contain only the columns approved in the design, use `Option` for unknown metrics, and provide `started`, `completed`, `failed` and `aborted` constructors. Constructors receive timestamps from the caller so tests stay deterministic.

- [ ] **Step 4: Run contract tests for GREEN**

Run: `cargo test -p local-first-inference-usage`

Expected: both tests PASS.

- [ ] **Step 5: Commit the shared contract**

```bash
git add Cargo.toml Cargo.lock crates/inference-usage crates/engine/Cargo.toml \
  crates/inference/Cargo.toml crates/subagents/Cargo.toml crates/desktop-gateway/Cargo.toml
git commit -m "feat(usage): add shared inference accounting contracts"
```

### Task 2: Build the append-only UsageStore and fail-open writer

**Files:**
- Create: `crates/desktop-gateway/src/usage_store.rs`
- Modify: `crates/desktop-gateway/src/lib.rs`
- Test: `crates/desktop-gateway/src/usage_store.rs`

- [ ] **Step 1: Write failing store tests**

Cover all canonical invariants:

```rust
#[test]
fn events_are_append_only_idempotent_and_scope_filtered() {
    let store = UsageStore::open_in_memory().unwrap();
    let start = fixture_start("event-start", "attempt-1", "user-a", "workspace-a");
    assert_eq!(store.append(&start).unwrap(), AppendOutcome::Inserted);
    assert_eq!(store.append(&start).unwrap(), AppendOutcome::Duplicate);
    assert_eq!(store.events_for_scope("user-a", Some("workspace-a")).unwrap().len(), 1);
    assert!(store.events_for_scope("user-b", Some("workspace-a")).unwrap().is_empty());
}

#[test]
fn recovery_appends_abort_without_rewriting_start() {
    let store = UsageStore::open_in_memory().unwrap();
    store.append(&fixture_start("start", "orphan", "local", "workspace-a")).unwrap();
    assert_eq!(store.abort_orphaned_attempts(200).unwrap(), 1);
    let events = store.events_for_attempt("orphan").unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].event_kind, AttemptEventKind::AttemptStarted);
    assert_eq!(events[1].event_kind, AttemptEventKind::AttemptAborted);
}

#[test]
fn null_usage_is_not_coerced_to_zero() {
    let store = UsageStore::open_in_memory().unwrap();
    store.append(&fixture_completed_without_usage()).unwrap();
    let summary = store.summary("local", UsageWindow::All, 300).unwrap();
    assert_eq!(summary.known_usage_attempts, 0);
    assert_eq!(summary.unknown_usage_attempts, 1);
}

#[test]
fn daily_rollups_are_rebuildable_from_the_append_only_ledger() {
    let store = UsageStore::open_in_memory().unwrap();
    store.append(&completed_fixture("attempt-a", 100, 25, 86_400)).unwrap();
    store.rebuild_daily_rollups().unwrap();
    assert_eq!(store.daily_rows().unwrap().len(), 1);
    store.clear_daily_rollups_for_test().unwrap();
    store.rebuild_daily_rollups().unwrap();
    assert_eq!(store.daily_rows().unwrap()[0].input_tokens, 100);
}
```

Define `fixture_start`, `fixture_completed_without_usage` and `completed_fixture` in the test module with fixed IDs, timestamps and token values; they are test builders, not production APIs.

- [ ] **Step 2: Run the store tests for RED**

Run: `cargo test -p local-first-desktop-gateway usage_store::tests --lib`

Expected: FAIL because `UsageStore` does not exist.

- [ ] **Step 3: Implement schema, queries and recovery**

Create `UsageStore { conn: rusqlite::Connection }`. `open` and `open_in_memory` must call one idempotent `migrate` function that creates `inference_usage_events`, its unique `(attempt_id,event_kind)` index and scope/time indexes. Implement:

```rust
pub fn append(&self, event: &UsageAttemptEvent) -> rusqlite::Result<AppendOutcome>;
pub fn events_for_attempt(&self, attempt_id: &str) -> rusqlite::Result<Vec<UsageAttemptEvent>>;
pub fn events_for_scope(&self, user_id: &str, workspace_id: Option<&str>) -> rusqlite::Result<Vec<UsageAttemptEvent>>;
pub fn abort_orphaned_attempts(&self, now: i64) -> rusqlite::Result<usize>;
pub fn purge_workspace(&self, user_id: &str, workspace_id: &str) -> rusqlite::Result<usize>;
pub fn summary(&self, user_id: &str, window: UsageWindow, now: i64) -> rusqlite::Result<UsageSummary>;
pub fn rebuild_daily_rollups(&self) -> rusqlite::Result<usize>;
pub fn vacuum(&self) -> rusqlite::Result<()>;
```

`append` must use `INSERT OR IGNORE`; it must never update an existing ledger row. Create `inference_usage_daily` as a derived table keyed by date, user, workspace, provider, model, locality and purpose. When a new terminal event is inserted, update its derived daily row in the same transaction; a duplicate event changes neither table. Rebuild the whole derived table transactionally from terminal ledger events at startup and on explicit repair, and add a deterministic corruption/rebuild test. Summary queries count only terminal events, preserve NULL as unknown and may use the daily table only where its granularity is sufficient.

The migration must not read or reinterpret historical `metrics_json`, chat messages or agent journal rows. `coverage_started_at` is the minimum `recorded_at` present in the new ledger, so Phase A deliberately performs no historical backfill.

- [ ] **Step 4: Add the bounded recorder**

Implement `BufferedUsageRecorder::start(path, capacity)` using `std::sync::mpsc::sync_channel`. `record` uses `try_send`, never blocks and increments an `AtomicU64` dropped counter on full/disconnected. The worker owns a separate file-backed `UsageStore` and logs storage failures without propagating them to inference. Expose:

```rust
pub fn dropped_events(&self) -> u64;
pub fn shutdown(&self, timeout: std::time::Duration);
```

Add a unit test with capacity `1` and a paused test consumer proving that `record` returns and the dropped counter increases.

- [ ] **Step 5: Run focused store tests for GREEN**

Run: `cargo test -p local-first-desktop-gateway usage_store::tests --lib`

Expected: all usage store and recorder tests PASS.

- [ ] **Step 6: Commit the store**

```bash
git add crates/desktop-gateway/src/usage_store.rs crates/desktop-gateway/src/lib.rs
git commit -m "feat(usage): persist append-only inference attempts"
```

### Task 3: Instrument streaming retry and fallback attempts

**Files:**
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/desktop-gateway/src/model_client.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Test: `crates/desktop-gateway/src/model_client.rs`

- [ ] **Step 1: Write failing parser and attempt-sequence tests**

Add pure tests for OpenAI/OpenRouter and Ollama terminal usage:

```rust
#[test]
fn openai_usage_keeps_reasoning_and_cache_tokens() {
    let usage = parse_openai_usage(&serde_json::json!({
        "prompt_tokens": 100,
        "completion_tokens": 40,
        "completion_tokens_details": {"reasoning_tokens": 12},
        "prompt_tokens_details": {"cached_tokens": 60},
        "cost": 0.00125
    }));
    assert_eq!(usage.tokens.reasoning_tokens, Some(12));
    assert_eq!(usage.tokens.cache_read_tokens, Some(60));
    assert_eq!(usage.provider_cost_microusd, Some(1250));
}

#[tokio::test]
async fn retry_records_each_transport_attempt_under_one_call() {
    let recorder = RecordingUsageRecorder::default();
    let result = run_scripted_attempts(&recorder, [Scripted::Timeout, Scripted::Success]);
    assert!(result.await.is_ok());
    let events = recorder.events();
    assert_eq!(terminal_attempts(&events), 2);
    assert_eq!(unique_call_ids(&events), 1);
    assert_eq!(unique_attempt_ids(&events), 2);
}
```

Define `RecordingUsageRecorder`, `Scripted`, `run_scripted_attempts`, `terminal_attempts` and the ID helpers inside the test module as deterministic fakes with no network dependency.

- [ ] **Step 2: Run focused tests for RED**

Run: `cargo test -p local-first-desktop-gateway model_client::tests`

Expected: FAIL because normalized parsers and recorder injection do not exist.

- [ ] **Step 3: Extend the engine contract**

Add `pub usage: &'a UsageContext` to `ModelCall`. Add `pub usage: NormalizedUsage` and measured latency/TTFT fields to `ModelRoundOutput`; do not put provider secrets into either type. In `agent_loop.rs`, clone the turn context per round and set `round` before constructing `ModelCall`. Forced synthesis uses the same call ID family but a new logical call ID and `purpose_detail = "forced_synthesis"`.

- [ ] **Step 4: Record each actual transport attempt**

Extend `GatewayModelClient`:

```rust
pub(crate) struct GatewayModelClient<'a> {
    pub http: &'a reqwest::Client,
    pub tx: &'a StreamSink,
    pub usage: &'a dyn UsageRecorder,
}
```

Inside the existing retry loop, generate a fresh `attempt_id`, emit `attempt_started` immediately before `send_with_headers_timeout`, and emit exactly one terminal event for every branch. When a fallback changes `model/base_url`, the next attempt start must use the new effective provider and model. Classify error bodies only as `http_status`, `transport`, `headers_timeout`, `first_token_timeout`, `idle_timeout`, `cancelled` or `decode`; never persist the body.

- [ ] **Step 5: Normalize terminal usage, limits and safe estimates**

Change `collect_openai_stream` and `collect_ollama_native_stream` to return an assembled response plus `NormalizedUsage`. Parse only provider terminal fields. Measure start, first content/reasoning delta and completion with `Instant`.

Prefer provider-reported token fields. When a successful provider response omits usage, transiently count serialized input characters and assembled output characters, calculate `chars.div_ceil(4).max(1)` using the existing Homun convention, persist only the counts and mark `usage_provenance = homun_estimated`. Never persist the serialized input or output. Parse recognized rate-limit headers into normalized numeric observations, discard all other headers, and never store authorization, cookie, request ID or raw-header values.

- [ ] **Step 6: Build the turn UsageContext once**

In `turn_executor.rs`, create the base context from broker values already present on `task` and `task.input_json`:

```rust
let source = task.input_json.get("source").and_then(serde_json::Value::as_str).unwrap_or("interactive");
let mode = task.input_json.get("mode").and_then(serde_json::Value::as_str).unwrap_or("agent");
let usage_context = UsageContext {
    call_id: uuid::Uuid::new_v4().to_string(),
    purpose: if source == "automation" { InferencePurpose::Automation } else { InferencePurpose::ChatResponse },
    purpose_detail: Some(mode.to_string()),
    user_id: task.user_id.as_str().to_string(),
    workspace_id: Some(workspace_id.clone()),
    thread_id: Some(thread_id.to_string()),
    turn_id: Some(turn_id.to_string()),
    run_id: agent_run.as_ref().map(|(run_id, _)| run_id.clone()),
    task_id: Some(task.task_id.as_str().to_string()),
    round: None,
};
```

Pass it into `run_agent_rounds`, browser sub-turns with `purpose = Subagent` and `purpose_detail = "browse"`, and both `GatewayModelClient` constructors.

- [ ] **Step 7: Run focused engine/gateway tests for GREEN**

Run:

```bash
cargo test -p local-first-engine
cargo test -p local-first-desktop-gateway model_client::tests
```

Expected: all tests PASS; existing retry/fallback behavior remains unchanged.

- [ ] **Step 8: Commit streaming instrumentation**

```bash
git add crates/engine/src/contract.rs crates/engine/src/agent_loop.rs \
  crates/desktop-gateway/src/model_client.rs crates/desktop-gateway/src/main.rs \
  crates/desktop-gateway/src/turn_executor.rs
git commit -m "feat(usage): record streaming retries and fallbacks"
```

### Task 4: Make structured inference usage explicit and recordable

**Files:**
- Modify: `crates/subagents/src/types.rs`
- Modify: `crates/inference/src/provider.rs`
- Modify: `crates/inference/src/router.rs`
- Modify: `crates/inference/src/openai_compat.rs`
- Modify: `crates/inference/src/anthropic.rs`
- Modify: `crates/inference/src/mistralrs_provider.rs`
- Modify: `crates/inference/src/json_runtime_provider.rs`
- Test: provider module tests in the same files

- [ ] **Step 1: Write failing structured-provider recorder tests**

For OpenAI-compatible strict-schema fallback, assert two attempts share a call ID. For Anthropic success, assert reported input/output tokens. For MistralRS, assert locality `local` and cost provenance `not_billed`.

- [ ] **Step 2: Run structured inference tests for RED**

Run: `cargo test -p local-first-inference`

Expected: FAIL because providers have no recorder or usage context.

- [ ] **Step 3: Require context on every request**

Add `pub usage: UsageContext` to `GenerateRequest`, `GenerateJsonRequest` and `IntentClassifyRequest`. This is intentionally non-optional: missing attribution must be a compile error. Update `InferenceProvider::generate_json` to accept the request containing this context.

- [ ] **Step 4: Inject a recorder into concrete providers**

Each provider constructor receives `Arc<dyn UsageRecorder>`. For every real `.send()` or local runtime invocation, record start and one terminal event. The OpenAI strict-schema 400 retry creates a second attempt; JSON repair that only parses the already-returned body does not.

- [ ] **Step 5: Run structured inference tests for GREEN**

Run: `cargo test -p local-first-inference`

Expected: provider parsing, routing and new recorder tests PASS.

- [ ] **Step 6: Commit provider instrumentation**

```bash
git add crates/subagents/src/types.rs crates/inference/src
git commit -m "feat(usage): instrument structured inference providers"
```

### Task 5: Attribute every structured call site

**Files:**
- Modify: `crates/orchestrator/src/brain.rs`
- Modify: `crates/orchestrator/src/agentic.rs`
- Modify: `crates/orchestrator/src/step_executor.rs`
- Modify: `crates/orchestrator/tests/brain.rs`
- Modify: `crates/orchestrator/tests/audit.rs`
- Modify: `crates/subagents/src/runner.rs`
- Modify: `crates/subagents/tests/runtime_client.rs`
- Create: `crates/desktop-gateway/src/inference_transport.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/document_content.rs`
- Modify: `crates/desktop-gateway/src/vision.rs`
- Modify: all compiler-reported `GenerateJsonRequest`, `GenerateRequest` and `IntentClassifyRequest` constructors

- [ ] **Step 1: Add a request-attribution test**

Create a test in `crates/orchestrator/tests/audit.rs` proving the planner request carries `Planning`, and a subagent runner test proving its request carries `Subagent` with the task ID.

- [ ] **Step 2: Run cargo check for RED and capture the complete constructor list**

Run: `cargo check --workspace`

Expected: FAIL at every request constructor missing `usage`.

- [ ] **Step 3: Apply the explicit purpose map**

Use this exact mapping; do not infer from prompt text:

| Caller | Purpose | Detail |
|---|---|---|
| orchestrator plan proposal/repair | `Planning` | `plan_proposal` / `plan_repair` |
| orchestrator completion judge | `Evaluation` | `completion_judge` |
| subagent runner | `Subagent` | agent ID |
| memory extraction/consolidation/decision | `MemoryExtraction` | operation name |
| memory query embedding or semantic helper | `MemoryRecall` or `Embedding` | operation name |
| title endpoint | `TitleGeneration` | `thread_title` |
| prompt improvement | `Other` | `prompt_improvement` |
| provider profile generation | `Evaluation` | `model_profile_generation` |
| artifact/document/deck generation | `ArtifactGeneration` | artifact kind |
| vision fallback/description | `VisionAnalysis` | `attachment_fallback` |
| automation-owned planner/subagent | `Automation` | nested operation |
| test-only request | `Evaluation` | test name |

Use `Uuid::new_v4()` for each logical call and propagate available user/workspace/thread/turn/run/task IDs. Tests use stable literal IDs.

- [ ] **Step 4: Consolidate and instrument direct non-streaming transports**

Move executable OpenAI-compatible `/chat/completions` and Ollama `/api/embed` request sends out of `main.rs`, `document_content.rs` and `vision.rs` into `inference_transport.rs`. Provide two recorded entry points: one for JSON/chat responses and one for embedding responses. Both receive `&dyn UsageRecorder` and a required `&UsageContext`, generate a fresh attempt ID immediately before each real send, and append exactly one terminal event.

Preserve each caller's existing timeout, response parsing, fail-open/fail-closed behavior and retry count. A caller retry invokes the helper again with the same logical call ID and therefore produces a new attempt ID. Route `GatewayLlmClient`, `call_memory_json`, prompt improvement, follow-up suggestions, title generation, privacy guard classification, completion judges, context compaction, deck/document generation, channel reply, contact-memory extraction and vision description through this adapter with the exact purpose map above.

Move `embed_text` into the same adapter and pass explicit contexts from `GatewayEmbeddingClient`, memory recall, dense tool ranking and every compiler-reported embedding caller. Record locality `local`, purpose `Embedding` or `MemoryRecall`, the effective `HOMUN_EMBED_MODEL`, latency and Homun-estimated input tokens; record `not_billed` cost provenance. Cache hits do not create model attempts, while cache misses do.

- [ ] **Step 5: Add an inventory guard**

Add a test in `crates/desktop-gateway/src/main.rs` that scans known Rust sources from `CARGO_MANIFEST_DIR/../..` and rejects direct model HTTP endpoint strings outside approved transport adapters. The allowlist is exactly:

```rust
const INFERENCE_TRANSPORT_FILES: &[&str] = &[
    "crates/desktop-gateway/src/model_client.rs",
    "crates/desktop-gateway/src/inference_transport.rs",
    "crates/inference/src/openai_compat.rs",
    "crates/inference/src/anthropic.rs",
    "crates/inference/src/mistralrs_provider.rs",
];
```

The test searches executable endpoint-construction expressions for `/chat/completions`, `/v1/messages`, `/api/embed` and local runtime generation calls and reports the violating path. Comments and test fixtures are excluded explicitly; do not weaken the check by allowlisting `main.rs`, `document_content.rs` or `vision.rs`.

- [ ] **Step 6: Run attribution tests and workspace check for GREEN**

Run:

```bash
cargo test -p local-first-orchestrator
cargo test -p local-first-subagents
cargo test -p local-first-desktop-gateway inference_transport_inventory
cargo check --workspace
```

Expected: all commands exit 0; no constructor can omit usage context.

- [ ] **Step 7: Commit call-site attribution**

```bash
git add crates/orchestrator crates/subagents crates/desktop-gateway/src/main.rs \
  crates/desktop-gateway/src/inference_transport.rs \
  crates/desktop-gateway/src/document_content.rs crates/desktop-gateway/src/vision.rs Cargo.lock
git commit -m "feat(usage): attribute internal model calls"
```

### Task 6: Wire store lifecycle, recovery, purge and aggregate API

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/workspace_delete.rs`
- Create: `crates/desktop-gateway/tests/usage_ledger.rs`

- [ ] **Step 1: Write failing API and purge integration tests**

The file-backed test must seed two users, two workspaces, one completed attempt with usage and one without. Assert:

```rust
assert_eq!(summary.logical_calls, 2);
assert_eq!(summary.known_usage_attempts, 1);
assert_eq!(summary.unknown_usage_attempts, 1);
assert_eq!(summary.usage_coverage_percent, 50);
assert_eq!(summary.input_tokens, 120);
assert_eq!(summary.output_tokens, 30);
```

Then purge one workspace and prove the other user/workspace remains unchanged.

- [ ] **Step 2: Run integration tests for RED**

Run: `cargo test -p local-first-desktop-gateway --test usage_ledger`

Expected: FAIL because AppState and routes are not wired.

- [ ] **Step 3: Wire AppState and startup**

Add to `AppState`:

```rust
usage_store: Arc<Mutex<usage_store::UsageStore>>,
usage_recorder: Arc<dyn UsageRecorder>,
```

Production opens the query store on `gateway_database_path()` and starts the buffered recorder on the same path. Tests default to an in-memory store plus `NoopUsageRecorder`, with usage-specific tests injecting a recording fake. Immediately after open, call `abort_orphaned_attempts(now_epoch_secs())`, then `rebuild_daily_rollups()` so a prior crash cannot leave projections stale.

- [ ] **Step 4: Add aggregate routes**

Register authenticated routes:

```text
GET /api/usage/summary?window=7d|30d|all
GET /api/usage/models?window=7d|30d|all
GET /api/usage/providers?window=7d|30d|all
GET /api/usage/processes?window=7d|30d|all
```

Implement typed `UsageWindowQuery`; invalid windows return `400 usage_window_invalid`. All handlers pass `gateway_user_id()` and never accept a user ID from the query.

- [ ] **Step 5: Integrate workspace purge and vacuum**

Add `Usage(String)` to `WorkspaceDeleteError`, an `usage_events` count to `GatewayWorkspacePurgeReport`, and a `purge_usage` closure before graph-cache removal. Extend the existing coordination tests to prove registry save is skipped on a usage purge failure. Add `usage_store.vacuum()` to `vacuum_all_stores`.

- [ ] **Step 6: Run integration tests for GREEN**

Run:

```bash
cargo test -p local-first-desktop-gateway --test usage_ledger
cargo test -p local-first-desktop-gateway workspace_delete
```

Expected: all tests PASS and the scope/purge assertions hold.

- [ ] **Step 7: Commit lifecycle and APIs**

```bash
git add crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/workspace_delete.rs \
  crates/desktop-gateway/tests/usage_ledger.rs
git commit -m "feat(usage): expose scoped usage aggregates"
```

### Task 7: Phase A verification gate

**Files:**
- Verify only; no expected source edits.

- [ ] **Step 1: Check formatting and diff hygiene**

Run:

```bash
cargo fmt --all -- --check
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 2: Run the complete Rust gate**

Run:

```bash
cargo test -p local-first-inference-usage
cargo test -p local-first-inference
cargo test -p local-first-engine
cargo test -p local-first-orchestrator
cargo test -p local-first-subagents
cargo test -p local-first-desktop-gateway
cargo test --workspace
```

Expected: all suites PASS; ignored tests remain explicitly reported, not counted as passed.

- [ ] **Step 3: Inspect a real temporary ledger for privacy**

Run the gateway integration fixture with sentinel prompt `USAGE_SECRET_SENTINEL_47`, then inspect SQLite:

```bash
sqlite3 "$USAGE_QA_DB" ".schema inference_usage_events"
if sqlite3 "$USAGE_QA_DB" ".dump inference_usage_events" | rg -q "USAGE_SECRET_SENTINEL_47"; then
  exit 1
fi
```

Expected: schema is present and the sentinel search exits without a match.

- [ ] **Step 4: Record the phase gate commit if verification required fixes**

If and only if verification produced source corrections:

```bash
git add crates Cargo.toml Cargo.lock
git commit -m "fix(usage): close phase A verification gaps"
```

Otherwise leave the last feature commit as the phase-A boundary.
