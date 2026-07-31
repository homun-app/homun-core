# Logical Turn Terminal Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere il turno chat realmente logico: una bolla assistant stabile, tentativi osservabili, risposta visibile validata e un solo evento terminale dopo tutti i retry.

**Architecture:** L'enqueue prealloca atomicamente user message e assistant placeholder e persiste entrambi gli id nel task. L'engine restituisce un esito di consegna tipizzato; l'executor finalizza la bolla solo su risposta visibile, mentre il worker possiede retry ed errore terminale. `turn_events` resta l'unico log pubblico e porta `run_id`/`attempt` nel payload.

**Tech Stack:** Rust, Tokio, rusqlite/SQLite, Axum, React 19, TypeScript, WebSocket unificato, Node test runner.

---

## File structure

- `crates/engine/src/markers.rs`: validazione canonica della prosa visibile.
- `crates/engine/src/outcome.rs`: esito tipizzato `Delivered | NoVisibleAnswer`.
- `crates/engine/src/agent_loop.rs`: emissione `Done` soltanto per testo visibile.
- `crates/task-runtime/src/types.rs`: eventi pubblici `attempt_started` e `aborted_attempt`.
- `crates/task-runtime/src/broker.rs`: id stabili dei due messaggi e cancel terminale.
- `crates/task-runtime/src/store.rs`: test di ordine/terminalità degli eventi.
- `crates/desktop-gateway/src/lib.rs`: stato di consegna persistito del messaggio.
- `crates/desktop-gateway/src/chat_store.rs`: migrazione e transizioni della bolla assistant.
- `crates/desktop-gateway/src/turn_executor.rs`: classificazione del tentativo senza terminalizzare i retry.
- `crates/desktop-gateway/src/main.rs`: retry/errore terminale e fan-out degli eventi.
- `apps/desktop/src/lib/chatTurnState.mjs`: reducer puro del lifecycle client.
- `apps/desktop/src/lib/chatTurnState.ts`: tipi TypeScript del reducer.
- `apps/desktop/src/lib/chatTurnState.test.mjs`: contratti `retry`/terminale/replay.
- `apps/desktop/src/lib/coreBridge.ts`: subscriber vivo fino al vero terminale.
- `apps/desktop/src/components/ChatView.tsx`: preview per tentativo e stato retry.
- `docs/STATO.md`: stato verificato della fase A.

## Task 1: Risposta visibile tipizzata nell'engine

**Files:**
- Modify: `crates/engine/src/markers.rs`
- Modify: `crates/engine/src/outcome.rs`
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/engine/src/browse.rs`

- [ ] **Step 1: Write the failing visible-answer tests**

Add to `markers.rs` tests:

```rust
#[test]
fn visible_answer_rejects_display_only_text() {
    assert_eq!(visible_answer(""), None);
    assert_eq!(
        visible_answer("‹‹REASONING››hidden‹‹/REASONING››\n‹‹PLAN››- [x] done‹‹/PLAN››"),
        None,
    );
}

#[test]
fn visible_answer_returns_trimmed_user_prose() {
    assert_eq!(
        visible_answer("‹‹REASONING››hidden‹‹/REASONING››\n  Risposta finale.  "),
        Some("Risposta finale.".to_string()),
    );
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p local-first-engine visible_answer_ -- --nocapture
```

Expected: compilation fails because `visible_answer` does not exist.

- [ ] **Step 3: Add the canonical helper and typed delivery**

Add to `markers.rs`:

```rust
pub fn visible_answer(text: &str) -> Option<String> {
    let visible = strip_display_markers(text).trim().to_string();
    (!visible.is_empty()).then_some(visible)
}
```

Add to `outcome.rs`:

```rust
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum TurnDelivery {
    Delivered,
    #[default]
    NoVisibleAnswer,
}
```

Add `pub delivery: TurnDelivery` to `TurnOutcome`. Set `Delivered` only in branches that emit a visible final answer. Keep `NoVisibleAnswer` for image-rejection and exhausted synthesis without prose.

- [ ] **Step 4: Make both normal completion and forced synthesis use `visible_answer`**

Replace raw `trim().is_empty()` success checks with this shape:

```rust
let Some(final_answer) = visible_answer(&final_answer) else {
    break;
};
memory_answer = final_answer.clone();
event_sink.emit(GenerateStreamEvent::Done {
    text: final_answer,
    metrics: TokenMetrics::zero(),
    redacted_user_text: None,
}).await.ok();
final_done = true;
```

For post-loop synthesis, try `synth_text`, then `ls.accumulated`, through `visible_answer`. Do not create the canned English fallback. If neither is visible, return `TurnDelivery::NoVisibleAnswer` and emit no `Done`.

- [ ] **Step 5: Update direct `TurnOutcome` fixtures**

Every delivered fixture in `browse.rs` must include:

```rust
delivery: TurnDelivery::Delivered,
```

Fallback/no-answer fixtures keep `TurnDelivery::NoVisibleAnswer`.

- [ ] **Step 6: Run engine tests and verify GREEN**

Run:

```bash
cargo test -p local-first-engine visible_answer_ -- --nocapture
cargo test -p local-first-engine should_force_synthesis_on_reasoning_only -- --nocapture
cargo test -p local-first-engine agent_loop::tests -- --nocapture
```

Expected: all selected tests pass; the reasoning-only synthesis path emits no `Done` when it still has no prose.

- [ ] **Step 7: Commit**

```bash
git add crates/engine/src/markers.rs crates/engine/src/outcome.rs crates/engine/src/agent_loop.rs crates/engine/src/browse.rs
git commit -m "fix(engine): require a visible final answer"
```

## Task 2: Preallocare una sola bolla assistant per turno

**Files:**
- Modify: `crates/task-runtime/src/broker.rs`
- Modify: `crates/desktop-gateway/src/chat_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`

- [ ] **Step 1: Write the failing atomic enqueue test**

Extend `broker::atomic_tests` so the input carries a stable assistant id and the closure receives it:

```rust
#[test]
fn retryable_turn_keeps_one_assistant_message_id() {
    let store = TaskStore::open_in_memory().unwrap();
    let mut input = make_input("r1", "t1");
    input.assistant_message_id = "local_assistant_r1".into();
    let user = UserId::new("u");
    let workspace = WorkspaceId::new("w");
    let enqueued = enqueue_chat_turn_atomic(&store, &user, &workspace, &input, |_tx| Ok(())).unwrap();
    let task = store.get_task(&enqueued.task_id, &user, &workspace).unwrap().unwrap();
    assert_eq!(task.input_json["assistant_message_id"], "local_assistant_r1");
}
```

Use one local `TaskStore` variable in the real test so enqueue and read share the same database.

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-task-runtime retryable_turn_keeps_one_assistant_message_id -- --nocapture
```

Expected: `ChatTurnInput` has no `assistant_message_id`.

- [ ] **Step 3: Extend the broker input**

Add:

```rust
pub struct ChatTurnInput {
    pub thread_id: String,
    pub request_id: String,
    pub prompt: String,
    pub visible_prompt: Option<String>,
    pub images: Vec<String>,
    pub attachments: Option<serde_json::Value>,
    pub mode: Option<String>,
    pub model: Option<String>,
    pub source: ChatTurnSource,
    pub approval: TurnApproval,
    pub assistant_message_id: String,
}
```

Persist it in both enqueue JSON builders:

```rust
"assistant_message_id": input.assistant_message_id,
```

Update every constructor: interactive requests mint `local_assistant_{request_id}`; channel/automation callers also mint once before enqueue.

- [ ] **Step 4: Add an atomic linked-turn insert**

In `chat_store.rs`, add a transaction helper that inserts user then assistant and advances the leaf only to the assistant:

```rust
pub(crate) fn insert_linked_turn_messages(
    conn: &Connection,
    thread_id: &str,
    user: &ChatMessage,
    assistant: &ChatMessage,
) -> rusqlite::Result<()> {
    let parent = active_leaf_on(conn, thread_id)?;
    insert_message_on(conn, thread_id, user, parent.as_deref())?;
    insert_message_on(conn, thread_id, assistant, Some(&user.id))?;
    conn.execute(
        "UPDATE chat_threads SET active_leaf_id = ?1 WHERE thread_id = ?2",
        params![assistant.id, thread_id],
    )?;
    Ok(())
}
```

Factor `active_leaf_on` and `insert_message_on` from the existing `insert_linked_user_message`; do not duplicate SQL.

- [ ] **Step 5: Seed both messages in `insert_broker_user_message`**

Rename the helper to `insert_broker_turn_messages` and create the placeholder with the stable id:

```rust
let user = channel_chat_message_with_id("user", visible_prompt, &format!("local_user_{}", input.request_id));
let mut assistant = channel_chat_message_with_id("assistant", "", &input.assistant_message_id);
assistant.delivery_state = MessageDeliveryState::Streaming;
ChatStore::insert_linked_turn_messages(tx, &input.thread_id, &user, &assistant)
```

- [ ] **Step 6: Reuse the preseeded assistant in the executor**

Read `assistant_message_id` from `task.input_json` and pass it to `start_visible_conversation_turn`. Change that function to reuse both preseeded ids and skip insertion when both rows already exist. The second attempt must update the same row, never mint another assistant id.

- [ ] **Step 7: Run broker and chat-store tests**

```bash
cargo test -p local-first-task-runtime atomic_tests -- --nocapture
cargo test -p local-first-desktop-gateway chat_store -- --nocapture
```

Expected: one user node and one assistant node, with the assistant as active leaf after repeated executor starts.

- [ ] **Step 8: Commit**

```bash
git add crates/task-runtime/src/broker.rs crates/desktop-gateway/src/chat_store.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/turn_executor.rs
git commit -m "fix(chat): keep one assistant bubble across attempts"
```

## Task 3: Persistire lo stato di consegna e proteggere il contesto

**Files:**
- Modify: `crates/desktop-gateway/src/lib.rs`
- Modify: `crates/desktop-gateway/src/chat_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`

- [ ] **Step 1: Write failing delivery-state tests**

Add the context test to `lib.rs` and the SQLite round-trip test to the existing
`chat_store.rs` test module:

```rust
#[test]
fn only_delivered_assistant_messages_enter_model_context() {
    let mut streaming = mk_message("a1", "assistant");
    streaming.delivery_state = MessageDeliveryState::Streaming;
    assert!(chat_message_for_existing_thread_context(&streaming).is_none());

    streaming.delivery_state = MessageDeliveryState::Delivered;
    assert!(chat_message_for_existing_thread_context(&streaming).is_some());
}

#[test]
fn delivery_state_round_trips_through_sqlite() {
    let store = ChatStore::in_memory().unwrap();
    let thread = store.create_thread("default").unwrap();
    let mut assistant = mk_message("assistant_retrying", "assistant");
    assistant.delivery_state = MessageDeliveryState::Retrying;
    store
        .append_assistant_message(&thread.thread_id, &assistant)
        .unwrap();
    let snapshot = store.messages(&thread.thread_id).unwrap();
    let reloaded = snapshot
        .messages
        .iter()
        .find(|message| message.id == assistant.id)
        .unwrap();
    assert_eq!(reloaded.delivery_state, MessageDeliveryState::Retrying);
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-desktop-gateway delivery_state_ -- --nocapture
```

- [ ] **Step 3: Add the additive schema and type**

In `lib.rs`:

```rust
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageDeliveryState {
    Streaming,
    Retrying,
    WaitingUser,
    #[default]
    Delivered,
    Failed,
    Cancelled,
}

impl MessageDeliveryState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Streaming => "streaming",
            Self::Retrying => "retrying",
            Self::WaitingUser => "waiting_user",
            Self::Delivered => "delivered",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}
```

Add `delivery_state` to `ChatMessage`. In `chat_store::migrate`, add `chat_messages.delivery_state TEXT NOT NULL DEFAULT 'delivered'` when absent. Update all insert/select/mapping helpers and existing Rust fixtures.

- [ ] **Step 4: Add a compare-free state setter**

```rust
pub fn set_message_delivery_state(
    &self,
    thread_id: &str,
    message_id: &str,
    state: MessageDeliveryState,
) -> rusqlite::Result<bool> {
    Ok(self.conn.execute(
        "UPDATE chat_messages SET delivery_state = ?1 WHERE thread_id = ?2 AND id = ?3",
        params![state.as_str(), thread_id, message_id],
    )? == 1)
}
```

- [ ] **Step 5: Enforce the context firewall**

At the start of `chat_message_for_existing_thread_context`:

```rust
if message.role == "assistant" && message.delivery_state != MessageDeliveryState::Delivered {
    return None;
}
```

Current-turn ids remain skipped as defense in depth.

- [ ] **Step 6: Wire lifecycle transitions**

- enqueue/attempt start: `Streaming`;
- retry scheduled: `Retrying`;
- approval: `WaitingUser`;
- valid final answer: `Delivered`;
- attempts exhausted: `Failed`;
- Stop: `Cancelled`.

Never store `No reply generated.` as assistant text.

- [ ] **Step 7: Run focused and crate tests**

```bash
cargo test -p local-first-desktop-gateway delivery_state_ -- --nocapture
cargo test -p local-first-desktop-gateway thread_context_for_model -- --nocapture
```

Expected: provisional, retrying, failed and cancelled assistant rows are excluded from future model context.

- [ ] **Step 8: Commit**

```bash
git add crates/desktop-gateway/src/lib.rs crates/desktop-gateway/src/chat_store.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/turn_executor.rs crates/desktop-gateway/tests/linked_memory_read_only.rs
git commit -m "fix(chat): keep provisional replies out of context"
```

## Task 4: Spostare terminalità e retry sul turno logico

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing event-order tests**

Add pure tests in `turn_executor.rs` around a new decision helper:

```rust
#[test]
fn no_visible_answer_is_retryable_and_never_done() {
    assert_eq!(
        attempt_decision(false, TurnDelivery::NoVisibleAnswer),
        AttemptDecision::RetryableFailure { code: "no_visible_answer" },
    );
}

#[test]
fn delivered_answer_is_the_only_done_decision() {
    assert_eq!(
        attempt_decision(false, TurnDelivery::Delivered),
        AttemptDecision::Delivered,
    );
}
```

Add a main-worker test that seeds a two-attempt chat task, records the first failure and asserts kinds equal `attempt_started,retry`, never `done,retry`.

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-desktop-gateway no_visible_answer_is_retryable_and_never_done -- --nocapture
```

- [ ] **Step 3: Add attempt-aware public events**

Extend `TurnEventKind` with:

```rust
AttemptStarted,
AbortedAttempt,
```

Map them to `attempt_started` and `aborted_attempt` in `as_str`/`parse`; extend round-trip tests.

- [ ] **Step 4: Introduce typed attempt decisions**

In `turn_executor.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
enum AttemptDecision {
    Delivered,
    RetryableFailure { code: &'static str },
    Cancelled,
}

fn attempt_decision(cancelled: bool, delivery: TurnDelivery) -> AttemptDecision {
    if cancelled { return AttemptDecision::Cancelled; }
    match delivery {
        TurnDelivery::Delivered => AttemptDecision::Delivered,
        TurnDelivery::NoVisibleAnswer => AttemptDecision::RetryableFailure {
            code: "no_visible_answer",
        },
    }
}
```

Use it to finalize the `agent_run`. Only `Delivered` updates assistant text, mirrors channels, activates approvals and emits `done`. Retryable failure returns `completed=false` with `blocked_reason=Some("no_visible_answer")` and leaves the placeholder `Retrying`.

- [ ] **Step 5: Emit `attempt_started` after creating the run**

Payload:

```rust
json!({
    "run_id": run_id,
    "attempt": attempt,
    "model": model,
    "provider": provider,
})
```

Include the same `run_id` and `attempt` in `done`.

- [ ] **Step 6: Make the worker emit retry or terminal error**

Change `handle_failed_task_run` so a retry emits:

```rust
json!({
    "attempt": task.attempt_count,
    "next_attempt": task.attempt_count + 1,
    "max_attempts": task.retry_policy.max_attempts,
    "backoff_seconds": backoff,
    "code": reason,
})
```

When attempts are exhausted, mark `Failed`, set the assistant row to `Failed`, then emit exactly one `TurnEventKind::Error`:

```rust
json!({
    "code": reason,
    "message": localized_turn_failure_message(reason),
    "attempt": task.attempt_count + 1,
})
```

Define the localizer in the same module so technical codes never become transcript prose:

```rust
fn localized_turn_failure_message(code: &str) -> &'static str {
    match code {
        "no_visible_answer" => "Non sono riuscito a produrre una risposta completa.",
        "model_transport" => "Il modello non è raggiungibile in questo momento.",
        "tool_timeout" => "Uno strumento necessario non ha risposto in tempo.",
        "policy_denied" => "L'azione richiesta non è autorizzata.",
        "invalid_request" => "La richiesta non può essere eseguita così com'è.",
        _ => "Il turno non è stato completato.",
    }
}
```

Do not emit `Error` for non-terminal retries. `cancel_chat_turn` remains the sole writer of `cancelled`.

- [ ] **Step 7: Run ordering and retry tests**

```bash
cargo test -p local-first-task-runtime turn_event_kind_tests -- --nocapture
cargo test -p local-first-desktop-gateway attempt_decision -- --nocapture
cargo test -p local-first-desktop-gateway chat_turn_retry -- --nocapture
cargo test -p local-first-task-runtime agent_tool_receipt -- --nocapture
```

Expected: `attempt_started(1),retry(1→2),attempt_started(2),done(2)` or terminal `error`; never `done,retry`.

- [ ] **Step 8: Commit**

```bash
git add crates/task-runtime/src/types.rs crates/desktop-gateway/src/turn_executor.rs crates/desktop-gateway/src/main.rs
git commit -m "fix(chat): terminalize only the logical turn"
```

## Task 5: Rendere il bridge e la preview retry-aware

**Files:**
- Create: `apps/desktop/src/lib/chatTurnState.mjs`
- Create: `apps/desktop/src/lib/chatTurnState.ts`
- Create: `apps/desktop/src/lib/chatTurnState.test.mjs`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/components/ChatView.tsx`

- [ ] **Step 1: Write reducer tests**

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { initialChatTurnState, reduceChatTurnEvent } from "./chatTurnState.mjs";

test("retry clears only provisional text and keeps the turn active", () => {
  const started = reduceChatTurnEvent(initialChatTurnState, {
    seq: 1, kind: "attempt_started", payload: { attempt: 1, run_id: "r1" },
  });
  const writing = reduceChatTurnEvent(started, { seq: 2, kind: "delta", payload: { text: "partial" } });
  const retrying = reduceChatTurnEvent(writing, {
    seq: 3, kind: "retry", payload: { attempt: 1, next_attempt: 2, backoff_seconds: 15 },
  });
  assert.equal(retrying.terminal, false);
  assert.equal(retrying.preview, "");
  assert.equal(retrying.phase, "retrying");
});

test("only done error and cancelled are terminal", () => {
  for (const kind of ["queued", "attempt_started", "retry", "aborted_attempt"]) {
    assert.equal(reduceChatTurnEvent(initialChatTurnState, { seq: 1, kind, payload: {} }).terminal, false);
  }
  for (const kind of ["done", "error", "cancelled"]) {
    assert.equal(reduceChatTurnEvent(initialChatTurnState, { seq: 1, kind, payload: {} }).terminal, true);
  }
});
```

- [ ] **Step 2: Run and verify RED**

```bash
cd apps/desktop && node --test src/lib/chatTurnState.test.mjs
```

- [ ] **Step 3: Implement the pure reducer and typed wrapper**

State shape:

```javascript
export const initialChatTurnState = Object.freeze({
  seq: 0, phase: "idle", attempt: 0, runId: null,
  preview: "", terminal: false, terminalKind: null,
  backoffSeconds: null, errorCode: null,
});
```

Ignore stale `seq`, append `delta`, replace preview on `retry`, and terminalize only the three terminal kinds. The `.ts` wrapper exports matching interfaces and typed functions.

- [ ] **Step 4: Extend `CoreChatStreamEvent`**

Add explicit variants for `queued`, `attempt_started`, `retry`, `aborted_attempt` and `cancelled`. Remove the unsafe cast for lifecycle events.

- [ ] **Step 5: Keep the bridge subscribed across retries**

In `submitChatPromptStream`:

- reset local `text` on `retry`;
- notify the lifecycle event;
- resolve only on `done`;
- reject on terminal `error`;
- reject with a typed cancellation on `cancelled`;
- never unsubscribe on `queued`, `retry` or `aborted_attempt`.

- [ ] **Step 6: Drive `ChatView` from the reducer**

Replace retry-sensitive local assumptions with `reduceChatTurnEvent`. On retry reset `streamedText`, keep `streamingAssistantId`, set status to `Riprovo tra Ns…`, and keep Stop enabled. On `attempt_started` show `Tentativo N`; on terminal clear busy state once.

- [ ] **Step 7: Run frontend tests and typecheck**

```bash
cd apps/desktop
node --test src/lib/chatTurnState.test.mjs
npm run typecheck
npm run test:ui-contract
```

Expected: reducer tests pass, TypeScript accepts all event variants, UI contract stays green.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/lib/chatTurnState.mjs apps/desktop/src/lib/chatTurnState.ts apps/desktop/src/lib/chatTurnState.test.mjs apps/desktop/src/lib/coreBridge.ts apps/desktop/src/components/ChatView.tsx
git commit -m "fix(desktop): follow chat retries to the terminal event"
```

## Task 6: Correggere l'osservabilità degli errori MCP

**Files:**
- Modify: `crates/engine/src/execution_journal.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing structured-error tests**

```rust
#[test]
fn mcp_is_error_is_not_classified_as_success() {
    assert_eq!(classify_tool_result(r#"{"isError":true,"content":[{"type":"text","text":"boom"}]}"#), "error");
    assert_eq!(classify_tool_result(r#"{"is_error":true}"#), "error");
}
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-engine mcp_is_error_is_not_classified_as_success -- --nocapture
```

- [ ] **Step 3: Extend structured classification**

Add to the existing error predicate:

```rust
|| value.get("isError").and_then(Value::as_bool) == Some(true)
|| value.get("is_error").and_then(Value::as_bool) == Some(true)
```

In the gateway MCP path, derive `run_ok` from both transport success and semantic success; record `run_err=Some("application")` for `isError=true`.

- [ ] **Step 4: Run engine and gateway focused tests**

```bash
cargo test -p local-first-engine classify_tool_result -- --nocapture
cargo test -p local-first-desktop-gateway mcp -- --nocapture
```

- [ ] **Step 5: Commit**

```bash
git add crates/engine/src/execution_journal.rs crates/desktop-gateway/src/main.rs
git commit -m "fix(mcp): record application errors as failures"
```

## Task 7: Phase-A verification and project state

**Files:**
- Modify: `docs/STATO.md`

- [ ] **Step 1: Run formatting and focused suites**

```bash
cargo fmt --all -- --check
cargo test -p local-first-engine
cargo test -p local-first-task-runtime
cargo test -p local-first-desktop-gateway turn_executor -- --nocapture
cd apps/desktop && node --test src/lib/chatTurnState.test.mjs && npm run typecheck
```

Expected: all commands exit 0. If a broader suite hangs, report it as excluded rather than calling it green.

- [ ] **Step 2: Run the forbidden-sequence regression check**

Use the new gateway test fixture to assert:

```text
attempt_started(1)
retry(1 -> 2)
attempt_started(2)
done(2)
```

and terminal failure:

```text
attempt_started(1)
retry(1 -> 2)
attempt_started(2)
error(no_visible_answer)
```

Expected: no event follows `done|error|cancelled` for the same `turn_id`.

- [ ] **Step 3: Build the desktop**

```bash
cd apps/desktop && npm run build
```

Expected: TypeScript and Vite build succeed.

- [ ] **Step 4: Update `docs/STATO.md` with exact evidence**

Record the lifecycle contract, commands run, and any excluded/hung suite. Do not claim live-render verification until it has actually been performed.

- [ ] **Step 5: Commit**

```bash
git add docs/STATO.md
git commit -m "docs: record logical turn lifecycle verification"
```

## Completion gate

Phase A is complete only when:

- reasoning-only synthesis yields retry/error, never `done`;
- retries reuse one assistant id;
- provisional assistant content is excluded from context;
- event order has one terminal and carries attempt/run identity;
- desktop stays busy and subscribed through retry;
- MCP `isError` is not logged as success;
- focused Rust suites, frontend reducer tests, typecheck and desktop build have fresh passing output.
