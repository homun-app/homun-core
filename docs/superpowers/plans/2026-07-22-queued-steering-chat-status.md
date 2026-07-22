# Queued Steering And Chat Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrare e gestire una coda FIFO di steering modificabili fino al claim, mantenendo lo stato operativo visibile sotto la risposta e sopra il composer.

**Architecture:** `turn_steering` conserva l'envelope completo ed è il source of truth fino al claim atomico. Il model client applica lo snapshot FIFO al prossimo round e una finalization fence impedisce la race fra chiusura e nuovo input. Il desktop ricostruisce coda e turno da endpoint/eventi durevoli; Island e superfici chat condividono la stessa proiezione.

**Tech Stack:** Rust, Tokio, rusqlite/SQLite, Axum, React 19, TypeScript, CSS, i18next, Node test runner.

**Dependency:** Eseguire prima `docs/superpowers/plans/2026-07-22-logical-turn-terminal-lifecycle.md` e mantenere verdi i suoi gate.

---

## File structure

- `crates/task-runtime/src/types.rs`: envelope, status e record steering tipizzati.
- `crates/task-runtime/src/error.rs`: conflitto di revisione tipizzato.
- `crates/task-runtime/src/store.rs`: migrazione v9, FIFO CRUD, claim, hold e promozione.
- `crates/task-runtime/src/broker.rs`: enqueue-or-steer senza materializzazione prematura e finalization fence.
- `crates/engine/src/contract.rs`: hook generico per la finalization fence.
- `crates/engine/src/agent_loop.rs`: continua il round quando esiste input pendente.
- `crates/desktop-gateway/src/model_client.rs`: claim/apply dello steering e round/run identity.
- `crates/desktop-gateway/src/chat_store.rs`: materializzazione idempotente al claim.
- `crates/desktop-gateway/src/main.rs`: endpoint list/edit/delete/send-now e notifiche thread-scoped.
- `apps/desktop/src/lib/chatApi.ts`: client API e tipi steering.
- `apps/desktop/src/lib/chatSteeringState.mjs`: reducer puro FIFO/revisioni.
- `apps/desktop/src/lib/chatSteeringState.ts`: wrapper TypeScript.
- `apps/desktop/src/lib/chatSteeringState.test.mjs`: test di coda e conflitti.
- `apps/desktop/src/components/ActiveTurnStatus.tsx`: footer/fascia operativo riusabile.
- `apps/desktop/src/components/PendingSteeringQueue.tsx`: card pending/held e modifica inline.
- `apps/desktop/src/components/ChatView.tsx`: integrazione con stream, composer e Island.
- `apps/desktop/src/styles.css`: layout B approvato.
- `apps/desktop/src/i18n/locales/{it,en,fr,de,es}.json`: testi localizzati.
- `docs/STATO.md`: evidenza finale e verifica renderizzata.

## Task 1: Migrare `turn_steering` a coda durevole completa

**Files:**
- Modify: `crates/task-runtime/src/error.rs`
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/store.rs`

- [ ] **Step 1: Write failing migration and FIFO tests**

Add to `store::turn_steering_tests`:

```rust
#[test]
fn steering_envelope_round_trips_with_revision_one() {
    let store = TaskStore::open_in_memory().unwrap();
    let input = NewTurnSteering {
        source_message_id: "message-1".into(),
        prompt: "hidden context\nUser text".into(),
        visible_prompt: "User text".into(),
        images: vec!["data:image/png;base64,abc".into()],
        attachments: json!([{"display_name":"brief.pdf"}]),
        mode: Some("agent".into()),
        model: Some("provider::model".into()),
    };
    let row = store.append_turn_steering("u", "w", "thread", "turn-1", &input, 3).unwrap();
    assert_eq!(row.status, TurnSteeringStatus::Pending);
    assert_eq!(row.revision, 1);
    assert_eq!(row.visible_prompt, "User text");
    assert_eq!(row.images.len(), 1);
}

#[test]
fn claim_returns_fifo_snapshot() {
    let store = TaskStore::open_in_memory().unwrap();
    for (source_message_id, prompt) in [("m1", "first"), ("m2", "second")] {
        store.append_turn_steering(
            "u", "w", "thread", "turn-1",
            &NewTurnSteering {
                source_message_id: source_message_id.into(),
                prompt: prompt.into(),
                visible_prompt: prompt.into(),
                images: vec![],
                attachments: json!([]),
                mode: None,
                model: None,
            },
            1,
        ).unwrap();
    }
    let claimed = store.claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 2).unwrap();
    assert_eq!(claimed.iter().map(|r| r.source_message_id.as_str()).collect::<Vec<_>>(), vec!["m1", "m2"]);
    assert!(claimed.iter().all(|r| r.status == TurnSteeringStatus::Claimed));
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-task-runtime turn_steering_tests -- --nocapture
```

Expected: the new types and fields do not exist.

- [ ] **Step 3: Define statuses and envelope**

In `types.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnSteeringStatus { Pending, Claimed, Applied, Held, Cancelled, Promoted }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewTurnSteering {
    pub source_message_id: String,
    pub prompt: String,
    pub visible_prompt: String,
    pub images: Vec<String>,
    pub attachments: Value,
    pub mode: Option<String>,
    pub model: Option<String>,
}
```

Extend `TurnSteeringRecord` with the envelope fields, typed status, `revision`, `updated_at`, `claimed_run_id`, `claimed_round`, `claimed_at`, `applied_at`, `cancelled_at`.

Add to `TaskRuntimeError` and its `Display` implementation:

```rust
Conflict(String),
```

- [ ] **Step 4: Add schema version 9 migration**

Add guarded columns:

```sql
ALTER TABLE turn_steering ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE turn_steering ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE turn_steering ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turn_steering ADD COLUMN claimed_run_id TEXT;
ALTER TABLE turn_steering ADD COLUMN claimed_round INTEGER;
ALTER TABLE turn_steering ADD COLUMN claimed_at INTEGER;
ALTER TABLE turn_steering ADD COLUMN applied_at INTEGER;
ALTER TABLE turn_steering ADD COLUMN cancelled_at INTEGER;
```

Write `schema_version=9`. Backfill `payload_json` from legacy `content` and `updated_at=created_at`.

- [ ] **Step 5: Implement FIFO primitives**

Provide exact store methods:

```rust
pub fn append_turn_steering(&self, user: &str, workspace: &str, thread: &str,
    active_turn: &str, input: &NewTurnSteering, objective_revision: u64)
    -> TaskRuntimeResult<TurnSteeringRecord>;

pub fn update_turn_steering(&self, steering_id: i64, user: &str, workspace: &str,
    expected_revision: u64, input: &NewTurnSteering)
    -> TaskRuntimeResult<TurnSteeringRecord>;

pub fn cancel_turn_steering(&self, steering_id: i64, user: &str, workspace: &str,
    expected_revision: u64) -> TaskRuntimeResult<TurnSteeringRecord>;

pub fn claim_pending_turn_steering(&self, user: &str, workspace: &str, thread: &str,
    active_turn: &str, run_id: &str, round: u32)
    -> TaskRuntimeResult<Vec<TurnSteeringRecord>>;

pub fn mark_turn_steering_applied(&self, ids: &[i64], run_id: &str)
    -> TaskRuntimeResult<()>;

pub fn hold_pending_turn_steering(&self, user: &str, workspace: &str, active_turn: &str)
    -> TaskRuntimeResult<usize>;
```

Updates use `WHERE revision=? AND status IN ('pending','held')`; claim uses `BEGIN IMMEDIATE`, selects `pending ORDER BY steering_id`, and updates exactly that id snapshot.

- [ ] **Step 6: Add race tests**

```rust
#[test]
fn stale_edit_loses_to_claim() {
    let store = TaskStore::open_in_memory().unwrap();
    let original = store.append_turn_steering("u", "w", "t", "turn", &new_steering("original"), 1).unwrap();
    let claimed = store.claim_pending_turn_steering("u", "w", "t", "turn", "run", 1).unwrap();
    assert_eq!(claimed[0].steering_id, original.steering_id);
    let err = store.update_turn_steering(original.steering_id, "u", "w", original.revision, &new_steering("edited")).unwrap_err();
    assert!(matches!(err, TaskRuntimeError::Conflict(_)));
}

#[test]
fn held_rows_can_be_edited_or_cancelled() {
    let store = TaskStore::open_in_memory().unwrap();
    let row = store.append_turn_steering("u", "w", "t", "turn", &new_steering("original"), 1).unwrap();
    store.hold_pending_turn_steering("u", "w", "turn").unwrap();
    let held = store.list_turn_steering("u", "w", "t").unwrap().remove(0);
    let edited = store.update_turn_steering(row.steering_id, "u", "w", held.revision, &new_steering("edited")).unwrap();
    assert_eq!(edited.status, TurnSteeringStatus::Held);
    assert_eq!(store.cancel_turn_steering(row.steering_id, "u", "w", edited.revision).unwrap().status, TurnSteeringStatus::Cancelled);
}
```

Define the shared test helper in the module:

```rust
fn new_steering(text: &str) -> NewTurnSteering {
    NewTurnSteering {
        source_message_id: format!("message-{text}"),
        prompt: text.into(),
        visible_prompt: text.into(),
        images: vec![],
        attachments: json!([]),
        mode: None,
        model: None,
    }
}
```

- [ ] **Step 7: Run the store suite**

```bash
cargo test -p local-first-task-runtime turn_steering_tests -- --nocapture
cargo test -p local-first-task-runtime schema_version -- --nocapture
```

- [ ] **Step 8: Commit**

```bash
git add crates/task-runtime/src/error.rs crates/task-runtime/src/types.rs crates/task-runtime/src/store.rs
git commit -m "feat(runtime): persist editable steering envelopes"
```

## Task 2: Enqueue steering senza inserirlo prematuramente nel transcript

**Files:**
- Modify: `crates/task-runtime/src/broker.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Replace the existing busy-thread test with delivery semantics**

```rust
#[test]
fn busy_interactive_turn_queues_steering_without_inserting_chat_message() {
    let store = TaskStore::open_in_memory().unwrap();
    let active = enqueue_chat_turn(&store, &UserId::new("u"), &WorkspaceId::new("w"), &make_input("r1", "t1")).unwrap();
    let inserted = Arc::new(Mutex::new(false));
    let observed = inserted.clone();
    let result = enqueue_or_steer_chat_turn_atomic(&store, &UserId::new("u"), &WorkspaceId::new("w"), &make_input("r2", "t1"), move |_tx| {
        *observed.lock().unwrap() = true;
        Ok(())
    }).unwrap();
    assert!(matches!(result, EnqueueTurnOutcome::SteeringQueued { active_turn_id, .. } if active_turn_id == active.task_id.as_str()));
    assert!(!*inserted.lock().unwrap());
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-task-runtime busy_interactive_turn_queues_steering_without_inserting_chat_message -- --nocapture
```

Expected: current code invokes the chat-message closure.

- [ ] **Step 3: Build `NewTurnSteering` from `ChatTurnInput`**

Use visible prompt fallback and serialize attachments without dropping images/mode/model. The active branch inserts only `turn_steering`; the no-active branch still calls the atomic user+assistant insertion from Phase A.

- [ ] **Step 4: Return the durable record**

Change the outcome to:

```rust
SteeringQueued {
    thread_id: String,
    active_turn_id: String,
    steering: TurnSteeringRecord,
}
```

The HTTP 202 body includes `steering_id`, `revision`, `status`, `visible_prompt`, timestamps and active turn id.

- [ ] **Step 5: Verify normal enqueue and steering are mutually exclusive**

Add a concurrent test with two connections: one result is `Enqueued`, the other is either steering bound to that turn or a subsequent ordinary turn after finalization; never neither and never both for one request id.

- [ ] **Step 6: Run broker and gateway enqueue tests**

```bash
cargo test -p local-first-task-runtime atomic_tests -- --nocapture
cargo test -p local-first-desktop-gateway enqueue_turn -- --nocapture
```

- [ ] **Step 7: Commit**

```bash
git add crates/task-runtime/src/broker.rs crates/desktop-gateway/src/main.rs
git commit -m "fix(chat): keep pending steering out of the transcript"
```

## Task 3: Claim/apply al round boundary e finalization fence

**Files:**
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/desktop-gateway/src/model_client.rs`
- Modify: `crates/desktop-gateway/src/chat_store.rs`
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/store.rs`

- [ ] **Step 1: Write failing finalization tests**

Add a pure finalization-decision test before wiring the model fixture:

```rust
#[test]
fn pending_input_prevents_final_done() {
    assert_eq!(
        finalization_decision(FinalizationFence::PendingInput),
        FinalizationDecision::Continue,
    );
    assert_eq!(
        finalization_decision(FinalizationFence::Ready),
        FinalizationDecision::Deliver,
    );
}
```

After the pure helper passes, add an async loop test using the existing `Collect`, `cfg`,
`usage_context`, `NoBrowser`, `NoPlan`, `DoneJudge`, `NoCompact` and `OpenPolicy` fixtures. Its
model returns `Prima risposta` on call 1, reports `PendingInput` once, then returns `Risposta
aggiornata`; assert two calls and one `Done` containing only `Risposta aggiornata`.

Add gateway tests asserting claimed messages appear in the request in FIFO order and `source_message_id` materializes once.

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-engine pending_input_prevents_final_done -- --nocapture
cargo test -p local-first-desktop-gateway steering_messages_for_round -- --nocapture
```

- [ ] **Step 3: Add a generic finalization hook**

In `contract.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalizationFence { Ready, PendingInput }

pub trait ModelClient {
    fn finalization_fence(&self) -> FinalizationFence { FinalizationFence::Ready }

    fn generate(
        &self,
        call: &ModelCall<'_>,
        on_delta: &(dyn Fn(&str) + Send + Sync),
    ) -> impl Future<Output = Result<ModelRoundOutput, ModelCallError>> + Send;
}
```

Before every `Done` in `agent_loop`, call the fence. On `PendingInput`, append the tentative assistant content to `ls.messages`, do not emit `Done`, and continue to another round.

Add the pure decision used by the test:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FinalizationDecision { Continue, Deliver }

fn finalization_decision(fence: FinalizationFence) -> FinalizationDecision {
    match fence {
        FinalizationFence::PendingInput => FinalizationDecision::Continue,
        FinalizationFence::Ready => FinalizationDecision::Deliver,
    }
}
```

- [ ] **Step 4: Add internal `TaskStatus::Finalizing`**

The gateway fence calls a task-store transaction that:

1. checks pending steering for `turn_id`;
2. returns `PendingInput` when present;
3. otherwise changes `Running -> Finalizing`.

Exclude `Finalizing` from `active_chat_turn_for_thread`, so input arriving after the fence becomes a normal new turn. Worker completion accepts `Finalizing -> Completed`; cancel remains valid before the fence.

- [ ] **Step 5: Claim and materialize FIFO input**

Extend `GatewaySteeringContext` with `run_id`. In `generate`, claim using `call.usage.round`, then atomically insert each user message with its stored attachments and source id before building the request. Mark records `applied` when the request is dispatched.

Return injected user messages in `ModelRoundOutput`:

```rust
pub struct ModelRoundOutput {
    pub message: Value,
    pub provider: ProviderBinding,
    pub finish_reason: Option<String>,
    pub usage: local_first_inference_usage::NormalizedUsage,
    pub latency_ms: Option<u64>,
    pub time_to_first_token_ms: Option<u64>,
    pub injected_messages: Vec<Value>,
}
```

The engine extends `ls.messages` with `injected_messages` before appending the assistant output, so later rounds retain steering context. Update all model fixtures with `injected_messages: vec![]`.

- [ ] **Step 6: Handle recovery**

At boot, records `claimed` by an aborted run are materialized idempotently and marked `applied`; they are already historical user input and must not become editable again. Pending rows stay pending on the recovered active turn.

- [ ] **Step 7: Run fence, claim and recovery tests**

```bash
cargo test -p local-first-engine pending_input_prevents_final_done -- --nocapture
cargo test -p local-first-task-runtime finalization_fence -- --nocapture
cargo test -p local-first-task-runtime turn_steering_tests -- --nocapture
cargo test -p local-first-desktop-gateway steering_messages_for_round -- --nocapture
```

Expected: enqueue-before-fence continues the current logical turn; enqueue-after-fence creates a new turn; no instruction is orphaned or duplicated.

- [ ] **Step 8: Commit**

```bash
git add crates/engine/src/contract.rs crates/engine/src/agent_loop.rs crates/desktop-gateway/src/model_client.rs crates/desktop-gateway/src/chat_store.rs crates/task-runtime/src/types.rs crates/task-runtime/src/store.rs
git commit -m "feat(chat): claim steering at safe round boundaries"
```

## Task 4: Hold, edit, cancel and send-now APIs

**Files:**
- Modify: `crates/task-runtime/src/broker.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`

- [ ] **Step 1: Write failing hold/promote tests**

```rust
#[test]
fn cancel_holds_pending_before_the_terminal_event() {
    cancel_chat_turn(&store, &user, &workspace, &turn, &NoopCancelNotify).unwrap();
    let steering = store.list_turn_steering("u", "w", "thread").unwrap();
    assert_eq!(steering[0].status, TurnSteeringStatus::Held);
    assert_eq!(store.read_turn_events("turn", 0).unwrap().last().unwrap().kind, TurnEventKind::Cancelled);
}

#[test]
fn send_now_promotes_one_held_row_atomically() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("u");
    let workspace = WorkspaceId::new("w");
    let row = store.append_turn_steering("u", "w", "thread", "old-turn", &new_steering("next"), 1).unwrap();
    store.hold_pending_turn_steering("u", "w", "old-turn").unwrap();
    let held = store.list_turn_steering("u", "w", "thread").unwrap().remove(0);
    let promoted = promote_held_turn_steering(
        &store, &user, &workspace, row.steering_id, held.revision,
        |_tx, input| Ok(EnqueuedTurn {
            task_id: TaskId::new(format!("turn_{}", input.source_message_id)),
            thread_id: "thread".into(),
            position_in_queue: 0,
        }),
    ).unwrap();
    assert_eq!(promoted.steering.status, TurnSteeringStatus::Promoted);
    assert_eq!(promoted.turn.position_in_queue, 0);
}
```

Define this helper inside the broker test module as well:

```rust
fn new_steering(text: &str) -> NewTurnSteering {
    NewTurnSteering {
        source_message_id: format!("message-{text}"),
        prompt: text.into(),
        visible_prompt: text.into(),
        images: vec![],
        attachments: serde_json::json!([]),
        mode: None,
        model: None,
    }
}
```

Add the broker result and function signature before implementing it:

```rust
pub struct PromotedSteering {
    pub steering: TurnSteeringRecord,
    pub turn: EnqueuedTurn,
}

pub fn promote_held_turn_steering<F>(
    store: &TaskStore,
    user: &UserId,
    workspace: &WorkspaceId,
    steering_id: i64,
    expected_revision: u64,
    enqueue: F,
) -> Result<PromotedSteering, EnqueueError>
where
    F: FnOnce(&rusqlite::Transaction<'_>, &NewTurnSteering)
        -> TaskRuntimeResult<EnqueuedTurn>;
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-task-runtime cancel_holds_pending -- --nocapture
```

- [ ] **Step 3: Hold before terminal cancel/error**

`cancel_chat_turn` updates pending rows to `held` in the same transaction before inserting `cancelled`. Terminal error handling does the same before `error`. Retry/backoff does not hold.

- [ ] **Step 4: Implement thread-scoped APIs**

Register:

```rust
.route("/api/chat/threads/{thread_id}/steering", get(list_thread_steering))
.route("/api/chat/steering/{steering_id}", patch(update_steering).delete(delete_steering))
.route("/api/chat/steering/{steering_id}/send-now", post(send_steering_now))
```

Request bodies:

```rust
struct SteeringMutationRequest {
    expected_revision: u64,
    prompt: String,
    visible_prompt: String,
    images: Vec<String>,
    attachments: Value,
    mode: Option<String>,
    model: Option<String>,
}

struct SteeringRevisionRequest { expected_revision: u64 }
```

Return HTTP 409 with `{code:"steering_revision_conflict", steering:<current>}` when claim/edit wins the race.

- [ ] **Step 5: Publish thread-scoped change notifications**

After successful queue/update/cancel/hold/promote publish:

```rust
publish_app_event(json!({
    "type": "thread.steering_changed",
    "thread_id": thread_id,
    "steering_id": steering_id,
    "revision": revision,
}));
```

Do not append to the already-terminal old turn's `turn_events`.

- [ ] **Step 6: Run API and broker tests**

```bash
cargo test -p local-first-task-runtime turn_steering_tests -- --nocapture
cargo test -p local-first-desktop-gateway steering_ -- --nocapture
```

- [ ] **Step 7: Commit**

```bash
git add crates/task-runtime/src/broker.rs crates/task-runtime/src/store.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/turn_executor.rs
git commit -m "feat(chat): manage held steering instructions"
```

## Task 5: Client API and durable steering reducer

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `apps/desktop/src/lib/chatApi.ts`
- Create: `apps/desktop/src/lib/chatSteeringState.mjs`
- Create: `apps/desktop/src/lib/chatSteeringState.ts`
- Create: `apps/desktop/src/lib/chatSteeringState.test.mjs`

- [ ] **Step 1: Write reducer tests**

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSteering, applySteeringChange } from "./chatSteeringState.mjs";

test("reconciliation is FIFO and drops cancelled rows", () => {
  const rows = reconcileSteering([
    { steering_id: 2, revision: 1, status: "pending" },
    { steering_id: 1, revision: 2, status: "held" },
    { steering_id: 3, revision: 1, status: "cancelled" },
  ]);
  assert.deepEqual(rows.map((row) => row.steering_id), [1, 2]);
});

test("older revisions cannot replace a claimed card", () => {
  const current = [{ steering_id: 1, revision: 3, status: "claimed" }];
  assert.deepEqual(applySteeringChange(current, { steering_id: 1, revision: 2, status: "pending" }), current);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
cd apps/desktop && node --test src/lib/chatSteeringState.test.mjs
```

- [ ] **Step 3: Add typed API methods**

First extend the durable thread projection in Rust:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveTurnProjection {
    pub turn_id: String,
    pub status: String,
    pub attempt: u32,
    pub max_attempts: u32,
    pub not_before: Option<i64>,
    pub blocked_reason: Option<String>,
    pub updated_at: i64,
}
```

Add `active_turn: Option<ActiveTurnProjection>` to `ThreadActivityProjection` and populate it
only for non-terminal, non-`finalizing` turns. Extend `project_thread_activity` tests with a
retrying task and assert its attempt/backoff survive reload.

Define `TurnSteeringRecord`, `SteeringMutation`, and functions:

```typescript
fetchThreadSteering(threadId): Promise<TurnSteeringRecord[]>
updateSteering(id, mutation): Promise<TurnSteeringRecord>
deleteSteering(id, expectedRevision): Promise<TurnSteeringRecord>
sendSteeringNow(id, expectedRevision): Promise<QueuedTurnResponse>
```

Parse 409 responses into `SteeringConflictError` carrying the current record.

- [ ] **Step 4: Implement reducer and wrapper**

Keep rows sorted by `steering_id`, ignore stale revisions, hide `cancelled|promoted`, retain `pending|held|claimed` until the next server refresh, and expose `canEdit`, `canDelete`, `canSendNow` selectors.

- [ ] **Step 5: Run tests and typecheck**

```bash
cd apps/desktop
node --test src/lib/chatSteeringState.test.mjs
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/chatApi.ts apps/desktop/src/lib/chatSteeringState.mjs apps/desktop/src/lib/chatSteeringState.ts apps/desktop/src/lib/chatSteeringState.test.mjs
git add crates/task-runtime/src/types.rs crates/task-runtime/src/store.rs
git commit -m "feat(desktop): model the durable steering queue"
```

## Task 6: Layout B — stato vicino alla risposta e coda sopra il composer

**Files:**
- Create: `apps/desktop/src/components/ActiveTurnStatus.tsx`
- Create: `apps/desktop/src/components/PendingSteeringQueue.tsx`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`

- [ ] **Step 1: Add a UI contract test for required affordances**

Extend `apps/desktop/scripts/check-ui-contract.mjs` assertions to require:

```javascript
assertSource("src/components/ActiveTurnStatus.tsx", ["Attività", "onStop", "attempt"]);
assertSource("src/components/PendingSteeringQueue.tsx", ["onEdit", "onDelete", "onSendNow"]);
assertSource("src/components/ChatView.tsx", ["active-turn-tail", "pendingSteering"]);
```

- [ ] **Step 2: Run and verify RED**

```bash
cd apps/desktop && npm run test:ui-contract
```

- [ ] **Step 3: Implement `ActiveTurnStatus`**

Props:

```typescript
interface ActiveTurnStatusProps {
  phase: string;
  detail?: string;
  elapsedSeconds: number;
  attempt: number;
  activityCount: number;
  variant: "assistant-footer" | "composer-bar";
  onOpenActivity(): void;
  onStop(): void;
}
```

Render a flat row, not a nested card. Both variants consume the same `ChatTurnState` instance.

- [ ] **Step 4: Implement `PendingSteeringQueue`**

Render FIFO cards with:

- `In attesa` for `pending`;
- `Applicata` for `claimed`;
- `Attività fermata` plus `Invia ora` for `held`;
- inline textarea during edit;
- revision-aware save/delete/send-now callbacks;
- attachment names without exposing local paths.

- [ ] **Step 5: Integrate durable hydration and events**

In `ChatView`:

- fetch steering on thread change/reload;
- refresh on `thread.steering_changed` for the current thread;
- replace `pendingSteeringMessagesRef` optimistic bubbles with the reducer queue;
- place assistant-footer under the active assistant message;
- place composer-bar and queue immediately before `<Composer>`;
- keep the Island unchanged and open it from `Attività`.

- [ ] **Step 6: Change composer semantics during active work**

Keep textarea enabled. When a turn is active:

- Enter/send calls enqueue and receives a steering record;
- button label/title becomes localized `Metti in coda`;
- composer clears only after HTTP 202;
- enqueue failure preserves the draft;
- model/attachments/images remain in the durable envelope.

- [ ] **Step 7: Add localized strings in all five locales**

Keys:

```json
{
  "stillWorking": "Homun sta ancora lavorando",
  "queueInstruction": "Metti in coda",
  "steeringPending": "In attesa",
  "steeringApplied": "Applicata",
  "steeringHeld": "Attività fermata",
  "sendNow": "Invia ora",
  "editInstruction": "Modifica",
  "deleteInstruction": "Elimina",
  "attemptN": "Tentativo {{count}}"
}
```

Translate equivalently in en/fr/de/es; do not leave Italian strings outside `it.json`.

- [ ] **Step 8: Run frontend gates**

```bash
cd apps/desktop
node --test src/lib/chatTurnState.test.mjs src/lib/chatSteeringState.test.mjs
npm run test:ui-contract
npm run typecheck
npm run build
```

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/components/ActiveTurnStatus.tsx apps/desktop/src/components/PendingSteeringQueue.tsx apps/desktop/src/components/ChatView.tsx apps/desktop/src/styles.css apps/desktop/src/i18n/locales apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(chat): surface active work and queued steering"
```

## Task 7: Recovery, Stop ed end-to-end contract

**Files:**
- Modify: `crates/task-runtime/src/broker.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/components/ChatView.tsx`

- [ ] **Step 1: Add end-to-end state tests**

Cover these exact scenarios in Rust integration-style fixtures:

```text
running + pending + retry       -> pending remains editable
running + pending + cancel      -> held before cancelled
running + pending + fatal error -> held before error
held + send-now                 -> one new turn + promoted
claimed + gateway restart       -> applied once, not pending again
pending + reload                -> same FIFO order/revisions
```

- [ ] **Step 2: Run and verify RED where recovery is missing**

```bash
cargo test -p local-first-task-runtime steering_recovery -- --nocapture
cargo test -p local-first-desktop-gateway steering_end_to_end -- --nocapture
```

- [ ] **Step 3: Close recovery gaps minimally**

- preserve pending rows on active-turn boot recovery;
- move them to held only when recovery makes the turn terminal;
- replay claimed rows through their stored `run_id` without a second transcript insert;
- refresh desktop queue after reconnect and after terminal state.

- [ ] **Step 4: Run both plan regression suites**

```bash
cargo test -p local-first-engine
cargo test -p local-first-task-runtime
cargo test -p local-first-desktop-gateway turn_executor -- --nocapture
cargo test -p local-first-desktop-gateway steering_ -- --nocapture
cd apps/desktop && node --test src/lib/chatTurnState.test.mjs src/lib/chatSteeringState.test.mjs && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add crates/task-runtime/src/broker.rs crates/task-runtime/src/store.rs crates/desktop-gateway/src/main.rs apps/desktop/src/components/ChatView.tsx
git commit -m "fix(chat): recover steering without loss or replay"
```

## Task 8: Rendered-app verification and project state

**Files:**
- Modify: `docs/STATO.md`

- [ ] **Step 1: Launch the real desktop target**

Run the normal development app using the repository's supported command. Exercise a test provider/fixture that delays completion long enough to queue steering; do not substitute a static HTML mockup for this gate.

- [ ] **Step 2: Verify the approved layout at target widths**

Check at approximately 1280px and 900px content widths:

- footer remains attached to the active assistant response;
- stable bar remains above the composer;
- FIFO cards do not cover the composer or Island;
- Modifica/Elimina work before claim;
- after claim the card becomes non-editable;
- Stop turns pending cards into held cards with `Invia ora`;
- retry does not remove working status or create a second assistant bubble.

Capture screenshots only for transient QA; do not store them in memory.

- [ ] **Step 3: Verify reload and reconnect live**

Reload once with pending steering and once during attempt 2. Expected: same assistant bubble, same queue order/revisions, same busy status, no duplicate deltas.

- [ ] **Step 4: Run final automated gates**

```bash
cargo fmt --all -- --check
cargo test -p local-first-engine
cargo test -p local-first-task-runtime
cargo test -p local-first-desktop-gateway
cd apps/desktop && npm run test:ui-contract && npm run typecheck && npm run build
```

Expected: all commands exit 0. If the full gateway suite hangs or cannot be interrogated, exclude it from proof and report the exact focused commands that completed.

- [ ] **Step 5: Update `docs/STATO.md`**

Record automated commands, live scenarios, widths, screenshots inspected, and any excluded suite. Mark the feature complete only after both automated and rendered-app evidence exist.

- [ ] **Step 6: Commit**

```bash
git add docs/STATO.md
git commit -m "docs: verify queued steering chat lifecycle"
```

## Completion gate

Phase B is complete only when:

- multiple steering instructions survive reload in FIFO order;
- each remains editable/cancellable until atomic claim;
- attachments/images/mode/model reach the claimed round;
- a finalization race assigns input to the current or a new turn, never neither/both;
- Stop/error hold unclaimed instructions without auto-running them;
- assistant footer and composer bar remain visible through retry/reconnect;
- live rendering at both widths matches layout B;
- all non-excluded gates have fresh passing output.
