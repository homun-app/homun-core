# Turn Queue Broker — Phase 1a (Broker Live) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collegare il broker (costruito in Fase 0) al flusso live dei turni chat: registrare un executor `chat_turn` nel worker pool, deviare `generate_stream` attraverso il broker (dietro `HOMUN_TURN_BROKER=on`), esporre le 5 route HTTP, lanciare la recovery al boot, e rendere `generate_stream` un thin shim quando il broker è attivo. Il browser resta gestito dal `browse_web_lock` esistente (la preemption sarà la Slice 1b).

**Architecture:** Si aggiunge un nuovo `execute_chat_turn_task` (sibling di `execute_proactive_prompt_task`) che legge `thread_id`/`prompt`/`approval` da `task.input_json`, apre un turn visibile, e chiama `run_agent_turn_into_message` estesa per fare fan-out di ogni evento su `turn_events` + un broadcast channel per-`turn_id`. Le route HTTP `POST/GET/DELETE /api/chat/turns` e `GET /turns/{id}/stream|events` vivono dietro feature flag. La recovery gira al boot dopo `bump_process_generation`. Quando il flag è off, **zero behavior change**.

**Tech Stack:** Rust, axum, tokio (broadcast, mpsc), `task-runtime` (broker primitives già pronte da Fase 0).

**Spec di riferimento:** `docs/superpowers/specs/2026-07-05-turn-queue-broker-design.md`
**Piano precedente:** `docs/superpowers/plans/2026-07-05-turn-queue-broker-phase0-foundation.md` (Fase 0, ✅ completata)

**Scope di questo piano:** SOLO Slice 1a. La Slice 1b (browser preemption: unificazione `browse_web_lock` ↔ `ResourceGovernor`, governor promosso in `AppState`, hook cooperativi nei tool handler) sarà un piano separato, perché l'esplorazione ha rivelato che richiede ristrutturazione strutturale (promuovere il governor a long-lived state + 7 tool handler hook) degna di piano dedicato.

---

## File Structure

**Create:**
- `crates/desktop-gateway/src/turn_executor.rs` — il modulo `execute_chat_turn_task` + helpers (broadcast registry per-`turn_id`, fan-out wiring). Una responsabilità: eseguire un `chat_turn` e fan-out lo stream su `turn_events` + broadcast.

**Modify:**
- `crates/desktop-gateway/src/task_registry.rs` — aggiungere `GatewayTaskExecutorKind::ChatTurn` + registrazione `"chat_turn"`.
- `crates/desktop-gateway/src/main.rs` — dispatch arm per `ChatTurn`, 5 route HTTP dietro flag, recovery al boot, `generate_stream` shim dietro flag, helper broadcast registry (se non in `turn_executor.rs`).
- `crates/desktop-gateway/src/lib.rs` o `main.rs` — body request per `POST /api/chat/turns` (`EnqueueTurnRequest`).

**Test:**
- `crates/desktop-gateway/src/turn_executor.rs` (`#[cfg(test)]`) — unit test del broadcast registry e del fan-out.
- `crates/desktop-gateway/src/task_registry.rs` (`#[cfg(test)]`) — aggiungere test per `chat_turn` resolution.

---

## Task 1: `GatewayTaskExecutorKind::ChatTurn` + registrazione

**Files:**
- Modify: `crates/desktop-gateway/src/task_registry.rs`

- [ ] **Step 1.1: Aggiungi variante `ChatTurn` all'enum**

In `crates/desktop-gateway/src/task_registry.rs`, modifica l'enum `GatewayTaskExecutorKind` (righe 2-11) aggiungendo la nuova variante prima di `LegacyShell`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayTaskExecutorKind {
    CapabilityBrowser,
    CapabilityGeneric,
    Subagent,
    /// Scheduled/recurring "do this and tell me" task: runs a full agent turn on
    /// the goal and delivers the result (proactivity).
    ProactivePrompt,
    /// Interactive or automation chat turn, owned by the persistent broker.
    /// Runs a full agent turn into a thread, fanning out events to `turn_events`
    /// + a per-turn broadcast channel for subscribers.
    ChatTurn,
    LegacyShell,
    LegacyLocal,
}
```

- [ ] **Step 1.2: Registra il pattern `"chat_turn"` in `with_defaults()`**

Nel metodo `with_defaults()` (righe 29-41), aggiungi la registrazione **prima** del fallback `"*"` (l'ordine conta: `resolve()` ritorna il primo match):

```rust
    pub fn with_defaults() -> Self {
        let mut registry = Self::new();
        registry.register(
            "capability.browser.*",
            GatewayTaskExecutorKind::CapabilityBrowser,
        );
        registry.register("capability.*", GatewayTaskExecutorKind::CapabilityGeneric);
        registry.register("subagent.*", GatewayTaskExecutorKind::Subagent);
        registry.register("proactive_prompt", GatewayTaskExecutorKind::ProactivePrompt);
        registry.register("chat_turn", GatewayTaskExecutorKind::ChatTurn);
        registry.register("local_shell_task", GatewayTaskExecutorKind::LegacyShell);
        registry.register("*", GatewayTaskExecutorKind::LegacyLocal);
        registry
    }
```

- [ ] **Step 1.3: Aggiungi test per la resolution di `chat_turn`**

Nel modulo `#[cfg(test)] mod tests` esistente (riga ~75), aggiungi due assertion al test `registry_resolves_specific_patterns_before_fallbacks`:

```rust
        assert_eq!(
            registry.resolve("chat_turn"),
            Some(GatewayTaskExecutorKind::ChatTurn)
        );
```

Posizionalo dopo l'assertion di `proactive_prompt` e prima di `browser_task`.

- [ ] **Step 1.4: Esegui i test**

Run: `cargo test -p local-first-desktop-gateway task_registry::tests -- --nocapture`
Expected: PASS (tutti i test esistenti + la nuova assertion).

- [ ] **Step 1.5: Commit**

```bash
git add crates/desktop-gateway/src/task_registry.rs
git commit -m "feat(gateway): register ChatTurn executor kind

Aggiunge GatewayTaskExecutorKind::ChatTurn e registra il pattern 'chat_turn'
nel task executor registry (prima del fallback *). Slice 1a: il dispatch
arm verrà aggiunto in un task successivo."
```

---

## Task 2: Broadcast registry per-`turn_id`

**Files:**
- Create: `crates/desktop-gateway/src/turn_executor.rs`

- [ ] **Step 2.1: Crea il modulo con il broadcast registry**

Crea `crates/desktop-gateway/src/turn_executor.rs`:

```rust
//! Turn executor: runs a `chat_turn` task and fans out its stream events to
//! `turn_events` (durable, for resume) + a per-turn broadcast channel (live).
//! Sibling of `execute_proactive_prompt_task`, generalized for the broker.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use local_first_task_runtime::{
    broker::CancelNotify, TaskId, TaskRecord, TaskRuntimeResult, TaskStore, TurnEventKind,
};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Notify};

/// A live subscriber fan-out for a single turn_id. Created when the turn starts running,
/// dropped when it terminates. Mirrors the StreamEntry pattern (main.rs:31732) but keyed
/// by turn_id and broker-owned.
pub struct TurnBroadcast {
    pub tx: broadcast::Sender<TurnEvent>,
    pub cancel: Arc<Notify>,
}

/// One unit of the turn stream, sent over the broadcast channel and stored in turn_events.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TurnEvent {
    pub seq: i64,
    pub kind: String,
    pub payload: Value,
}

/// Process-wide registry of live turn broadcasts. Keyed by turn_id (= task_id).
pub fn turn_broadcast_registry() -> &'static Mutex<HashMap<String, Arc<TurnBroadcast>>> {
    static CELL: OnceLock<Mutex<HashMap<String, Arc<TurnBroadcast>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

const TURN_CHANNEL_CAPACITY: usize = 256;

/// Register a new turn broadcast. Call when the executor starts running a chat_turn.
/// Returns the broadcast handle. Also registers a cancel Notify (used by CancelNotify impl).
pub fn register_turn(turn_id: &str) -> Arc<TurnBroadcast> {
    let (tx, _rx) = broadcast::channel(TURN_CHANNEL_CAPACITY);
    let cancel = Arc::new(Notify::new());
    let broadcast = Arc::new(TurnBroadcast { tx, cancel });
    if let Ok(mut map) = turn_broadcast_registry().lock() {
        map.insert(turn_id.to_string(), broadcast.clone());
    }
    broadcast
}

/// Drop the turn broadcast. Call when the executor finishes (success/failure/cancel).
pub fn unregister_turn(turn_id: &str) {
    if let Ok(mut map) = turn_broadcast_registry().lock() {
        map.remove(turn_id);
    }
}

/// Look up the cancel Notify for a turn (used by the gateway's CancelNotify impl).
pub fn turn_cancel_notify(turn_id: &str) -> Option<Arc<Notify>> {
    turn_broadcast_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(turn_id).map(|b| b.cancel.clone()))
}

/// Fan-out helper: persist the event in turn_events (durable) AND broadcast it live.
/// Call from the executor for each delta/activity/plan_update/etc.
pub fn emit_turn_event(
    store: &TaskStore,
    turn_id: &str,
    kind: TurnEventKind,
    payload: Value,
) -> TaskRuntimeResult<()> {
    let event = store.insert_turn_event(turn_id, kind, payload.clone())?;
    // best-effort live broadcast: no receivers is fine (broadcast::send errors are benign)
    if let Ok(map) = turn_broadcast_registry().lock() {
        if let Some(broadcast) = map.get(turn_id) {
            let _ = broadcast.tx.send(TurnEvent {
                seq: event.seq,
                kind: kind.as_str().to_string(),
                payload,
            });
        }
    }
    Ok(())
}

/// Gateway's CancelNotify impl: signals the executor's cancel Notify for a turn.
pub struct GatewayCancelNotify;

impl CancelNotify for GatewayCancelNotify {
    fn notify_cancel(&self, turn_id: &str) {
        if let Some(n) = turn_cancel_notify(turn_id) {
            n.notify_one();
        }
    }
}
```

- [ ] **Step 2.2: Dichiara il modulo in `main.rs`**

In `crates/desktop-gateway/src/main.rs`, vicino alle altre dichiarazioni `mod` (cerca `mod task_registry;`), aggiungi:

```rust
mod turn_executor;
```

E importa i simboli pubblici dove servono (verifica che `local_first_task_runtime` sia già una dipendenza — lo è). Aggiungi in cima, vicino agli altri `use local_first_task_runtime::{...}`:

```rust
use turn_executor::{
    emit_turn_event, register_turn, turn_cancel_notify, unregister_turn, GatewayCancelNotify,
    TurnEvent as GatewayTurnEvent, TurnBroadcast,
};
```

- [ ] **Step 2.3: Test del broadcast registry**

Aggiungi un `#[cfg(test)] mod tests` in fondo a `turn_executor.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use local_first_task_runtime::TaskStore;

    #[test]
    fn register_and_unregister_turn() {
        let _ = register_turn("turn_test_reg");
        assert!(turn_broadcast_registry().lock().unwrap().contains_key("turn_test_reg"));
        assert!(turn_cancel_notify("turn_test_reg").is_some());
        unregister_turn("turn_test_reg");
        assert!(!turn_broadcast_registry().lock().unwrap().contains_key("turn_test_reg"));
        assert!(turn_cancel_notify("turn_test_reg").is_none());
    }

    #[test]
    fn emit_persists_and_broadcasts() {
        let store = TaskStore::open_in_memory().unwrap();
        let broadcast = register_turn("turn_test_emit");
        let mut rx = broadcast.tx.subscribe();
        emit_turn_event(
            &store,
            "turn_test_emit",
            TurnEventKind::Delta,
            json!({"text": "hello"}),
        )
        .unwrap();
        // persisted
        let events = store.read_turn_events("turn_test_emit", 0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, TurnEventKind::Delta);
        // broadcasted
        let received = rx.try_recv().unwrap();
        assert_eq!(received.seq, 1);
        assert_eq!(received.kind, "delta");
        unregister_turn("turn_test_emit");
    }

    #[test]
    fn cancel_notify_signals_executor() {
        let broadcast = register_turn("turn_test_cancel");
        let cancel = broadcast.cancel.clone();
        // spawn a waiter
        let wait = std::thread::spawn(move || {
            // tokio context needed for Notify; use a small runtime
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(1), cancel.notified()).await;
            });
        });
        GatewayCancelNotify.notify_cancel("turn_test_cancel");
        wait.join().unwrap();
        unregister_turn("turn_test_cancel");
    }
}
```

Per i test che usano tokio, assicurati che `tokio` sia disponibile come dev-dependency del gateway (lo è già come dependency, ma verifica).

- [ ] **Step 2.4: Verifica compilazione e test**

Run: `cargo test -p local-first-desktop-gateway turn_executor::tests -- --nocapture`
Expected: PASS (3 test).

- [ ] **Step 2.5: Commit**

```bash
git add crates/desktop-gateway/src/turn_executor.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): turn_executor module — broadcast registry + fan-out

TurnBroadcast registry per-turn_id (broadcast::Sender + cancel Notify).
emit_turn_event persiste in turn_events (durable) e fan-out live.
GatewayCancelNotify implementa CancelNotify via Notify per-turn. Slice 1a."
```

---

## Task 3: `execute_chat_turn_task` — l'executor

**Files:**
- Modify: `crates/desktop-gateway/src/turn_executor.rs`

- [ ] **Step 3.1: Aggiungi `execute_chat_turn_task`**

In `crates/desktop-gateway/src/turn_executor.rs`, aggiungi la funzione executor. Questa è un sibling di `execute_proactive_prompt_task` (`main.rs:33670`) ma legge i campi da `task.input_json` (dove `enqueue_chat_turn` li ha messi, vedi `broker.rs:123-133`):

```rust
use crate::{
    ChatGenerateStreamRequest, GatewayError, LocalTaskExecutionError, AppState,
    chat_role_config_for_thread, run_agent_turn_into_message_with_fanout,
    start_visible_conversation_turn, update_channel_assistant_message, publish_app_event,
};
use local_first_task_runtime::{broker::EnqueueError, TaskExecutionOutcome};

/// The chat_turn executor. Dispatched by the worker pool when a `chat_turn` task is ready.
///
/// Reads thread_id/prompt/approval from `task.input_json` (set by `broker::enqueue_chat_turn`),
/// opens a visible turn in the thread, runs the agent-loop with fan-out to `turn_events` +
/// the per-turn broadcast, and finalizes the assistant message. Returns the outcome to the
/// worker pool (which marks the task Completed/Failed + releases the lease).
pub fn execute_chat_turn_task(
    state: &AppState,
    task: &TaskRecord,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    let turn_id = task.task_id.as_str().to_string();
    let thread_id = task
        .input_json
        .get("thread_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| LocalTaskExecutionError {
            message: "chat_turn missing thread_id in input_json".to_string(),
        })?
        .to_string();
    let prompt = task
        .input_json
        .get("prompt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| LocalTaskExecutionError {
            message: "chat_turn missing prompt in input_json".to_string(),
        })?
        .to_string();
    let approval = task
        .input_json
        .get("approval")
        .and_then(|v| v.as_str())
        .unwrap_or("full");
    let tool_policy = match approval {
        "confirm" => "confirm",
        "autonomous" => "autonomous",
        "read_only" => "read_only",
        _ => "full",
    };

    // Register the turn broadcast (live subscribers + cancel Notify).
    let _broadcast = register_turn(&turn_id);

    // Open a visible turn: persist user + assistant placeholder messages.
    // Reuses the same path as execute_proactive_prompt_task (main.rs:33727).
    let workspace_id = task
        .input_json
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .unwrap_or("default");
    let visible_turn = tokio::runtime::Handle::current()
        .block_on(async {
            start_visible_conversation_turn(
                state,
                &thread_id,
                workspace_id,
                "interactive", // source
                None,          // channel
                &prompt,       // title (first prompt)
                &prompt,
            )
            .await
        })
        .map_err(|_| LocalTaskExecutionError {
            message: "could not start visible conversation turn".to_string(),
        })?;

    // Run the agent-loop with fan-out. This is run_agent_turn_into_message extended
    // to mirror each stream event into turn_events + broadcast (see Task 4).
    let answer = tokio::runtime::Handle::current()
        .block_on(run_agent_turn_into_message_with_fanout(
            state,
            &thread_id,
            &prompt,
            tool_policy,
            &visible_turn.user_message_id,
            &visible_turn.assistant_message_id,
            &turn_id,
        ))
        .unwrap_or_else(|| "No reply generated.".to_string());

    // Finalize the assistant message with the full answer.
    tokio::runtime::Handle::current()
        .block_on(async {
            update_channel_assistant_message(state, &thread_id, &visible_turn.assistant_message_id, &answer).await
        })
        .ok();
    tokio::runtime::Handle::current()
        .block_on(async { publish_app_event(state, &thread_id).await });

    // Emit a terminal `done` event so subscribers know the turn finished cleanly.
    let store = state.task_store.lock().unwrap();
    let _ = emit_turn_event(
        &store,
        &turn_id,
        TurnEventKind::Done,
        json!({
            "assistant_message_id": visible_turn.assistant_message_id,
            "user_message_id": visible_turn.user_message_id,
        }),
    );
    drop(store);

    unregister_turn(&turn_id);

    Ok(TaskExecutionOutcome::success(json!({
        "thread_id": thread_id,
        "assistant_message_id": visible_turn.assistant_message_id,
    })))
}
```

**Note importanti:**
- `run_agent_turn_into_message_with_fanout` è una **nuova funzione** che creerai nel Task 4 (estende `run_agent_turn_into_message` con il fan-out). Se non esiste ancora, il codice non compila — il Task 4 la crea.
- `start_visible_conversation_turn`, `update_channel_assistant_message`, `publish_app_event`, `chat_role_config_for_thread` sono funzioni esistenti in `main.rs`. Verifica le signature esatte adattando il codice (potrebbero avere signature leggermente diverse — controlla `main.rs:33727` e dintorni per `start_visible_conversation_turn`).
- `TaskExecutionOutcome::success(...)` — verifica il costruttore esatto in `task-runtime` (potrebbe essere `TaskExecutionOutcome::Completed { ... }` o un builder; guarda come `execute_proactive_prompt_task` costruisce il suo outcome, ~`main.rs:33752-33763`).
- I path di import `use crate::{...}` potrebbero necessitare di aggiustamenti: `start_visible_conversation_turn` ecc. sono in `main.rs` (la crate root del gateway). Se il gateway ha più moduli, verifica dove vivono. Probabilmente sono `use crate::start_visible_conversation_turn` se sono in `main.rs`.

- [ ] **Step 3.2: Verifica che il modulo compili (con placeholder per `run_agent_turn_into_message_with_fanout`)**

Se la funzione `run_agent_turn_into_message_with_fanout` non esiste ancora, il Task 3 non compila da solo. Procedi quindi al Task 4 PRIMA di eseguire i test del Task 3. **Salta lo step 3.2/3.3 per ora** e vai al Task 4, poi ritorna.

In alternativa: come primo passo del Task 3, crea un stub temporaneo di `run_agent_turn_into_message_with_fanout` in `main.rs` che chiama `run_agent_turn_into_message` (senza fan-out), così il Task 3 compila e si testa; il Task 4 rimpiazza lo stub con il fan-out reale.

**Strategia consigliata:** usa lo stub temporaneo, testa il wiring del Task 3, poi il Task 4 lo sostituisce. Per lo stub, in fondo a `main.rs` aggiungi:

```rust
/// TEMPORARY STUB — replaced by Task 4 with the real fan-out version.
async fn run_agent_turn_into_message_with_fanout(
    state: &AppState,
    thread_id: &str,
    prompt: &str,
    tool_policy: &str,
    source_user_message_id: &str,
    assistant_message_id: &str,
    _turn_id: &str,
) -> Option<String> {
    run_agent_turn_into_message(state, thread_id, prompt, tool_policy, source_user_message_id, assistant_message_id).await
}
```

- [ ] **Step 3.3: Commit (Task 3 + stub)**

```bash
git add crates/desktop-gateway/src/turn_executor.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): execute_chat_turn_task — broker executor (with stub fanout)

Sibling di execute_proactive_prompt_task, legge thread_id/prompt/approval da
task.input_json. Apre turn visibile, gira agent-loop, finalizza. Con stub
temporaneo per run_agent_turn_into_message_with_fanout (sostituito nel Task 4)."
```

---

## Task 4: `run_agent_turn_into_message_with_fanout` — il fan-out reale

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 4.1: Studia `drain_agent_stream_into_message` e `apply_agent_stream_line`**

Leggi `crates/desktop-gateway/src/main.rs` intorno a:
- `drain_agent_stream_into_message` (`main.rs:30295-30360`)
- `apply_agent_stream_line` (`main.rs:30247-30277`)

Queste sono le funzioni che consumano lo stream e accumulano testo nel messaggio assistant. **L'hook per il fan-out è in `apply_agent_stream_line`** (o in `drain_agent_stream_into_message` dove ogni linea viene processata): lì, per ogni evento `delta`/`activity`/`plan_update`/ecc., oltre ad accumulare nel messaggio, devi chiamare `emit_turn_event(store, turn_id, kind, payload)`.

- [ ] **Step 4.2: Sostituisci lo stub con la versione reale**

In `main.rs`, rimpiazza lo stub `run_agent_turn_into_message_with_fanout` con una versione che fa drain dello stream chiamando una variante di `drain_agent_stream_into_message` che accetta anche `turn_id` e fa fan-out.

**Approccio raccomandato** (minime modifiche): aggiungi un parametro `turn_id: Option<&str>` a `drain_agent_stream_into_message`. Quando `Some`, per ogni evento processato (nello stesso punto dove chiami `update_channel_assistant_message`), chiama anche `emit_turn_event`. Quando `None`, behavior invariato (così `execute_proactive_prompt_task` esistente non si rompe).

Implementazione di `run_agent_turn_into_message_with_fanout`:

```rust
/// Like run_agent_turn_into_message, but also fans out each stream event to turn_events
/// (durable) + the per-turn broadcast (live). Used by execute_chat_turn_task (broker path).
async fn run_agent_turn_into_message_with_fanout(
    state: &AppState,
    thread_id: &str,
    prompt: &str,
    tool_policy: &str,
    source_user_message_id: &str,
    assistant_message_id: &str,
    turn_id: &str,
) -> Option<String> {
    let (base_url, model, api_key) = chat_role_config_for_thread(state, Some(thread_id))?;
    let context = agent_turn_context(state, thread_id, &[source_user_message_id, assistant_message_id])?;
    let request_id = format!("broker-{turn_id}");
    let request = ChatGenerateStreamRequest {
        request_id: request_id.clone(),
        prompt: prompt.to_string(),
        thread_id: Some(thread_id.to_string()),
        context,
        max_context_chars: None,
        model: None,
        images: Vec::new(),
        attachments: Vec::new(),
        max_tokens: 2000,
        temperature: 0.3,
        wait_if_busy: true,
        request_timeout_seconds: None,
        tool_policy: Some(tool_policy.to_string()),
        mode: None,
    };
    let response = stream_chat_via_openai(state, request, base_url, model, api_key).await.ok()?;
    let entry = stream_registry().lock().ok().and_then(|map| map.get(&request_id).cloned());

    let body_task = tokio::spawn(async move {
        let _ = axum::body::to_bytes(response.into_body(), usize::MAX).await;
    });

    let result = match entry {
        Some(entry) => {
            drain_agent_stream_into_message_with_fanout(
                state, thread_id, assistant_message_id, entry, turn_id,
            )
            .await
        }
        None => {
            let _ = body_task.await;
            return None;
        }
    };
    let _ = body_task.await;
    result
}
```

- [ ] **Step 4.3: Crea `drain_agent_stream_into_message_with_fanout`**

Crea una variante di `drain_agent_stream_into_message` che accetta `turn_id: &str` e, per ogni evento, oltre ad accumulare nel messaggio chiama `emit_turn_event`. La mappatura evento → `TurnEventKind`:

| StreamEvent | TurnEventKind | Payload |
|---|---|---|
| `Delta { text }` | `Delta` | `{ "text": text }` |
| `Reasoning { text }` | `Reasoning` | `{ "text": text }` |
| `Activity { text }` | `Activity` | `{ "text": text }` |
| `PlanUpdate { markdown }` | `PlanUpdate` | `{ "markdown": markdown }` |
| `Tool { ... }` | `Tool` | `{ ... }` |
| `Error { ... }` | `Error` | `{ ... }` |

**Strategia consigliata** (DRY): refactoring minimale di `drain_agent_stream_into_message` per accettare `turn_id: Option<&str>`. Quando `Some`, emetti via `emit_turn_event`; quando `None`, salta (preserva il path automation esistente intatto). Verifica che il test di `execute_proactive_prompt_task` esistente (se presente) ancora passi.

**Importante:** `emit_turn_event` ha bisogno di un `&TaskStore`. Dentro `drain_agent_stream_into_message`, acquisiscilo con `state.task_store.lock().unwrap()` per ogni evento (o tienilo lockato per il drain — attenzione alle performance). Verifica il pattern usato altrove per accesso al task_store dentro funzioni async.

- [ ] **Step 4.4: Verifica compilazione**

Run: `cargo check -p local-first-desktop-gateway`
Expected: compila OK (lo stub è rimpiazzato dalla versione reale).

- [ ] **Step 4.5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): run_agent_turn_into_message_with_fanout — real fanout

Sostituisce lo stub. Per ogni stream event: persiste in turn_events (durable)
+ fan-out broadcast (live). Mappatura StreamEvent → TurnEventKind.
drain_agent_stream_into_message_with_fanout accumula + emette."
```

---

## Task 5: Dispatch arm in `execute_read_only_task`

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 5.1: Aggiungi l'arm `ChatTurn` al dispatch**

In `execute_read_only_task` (`main.rs:33576-33592`), aggiungi l'arm:

```rust
        GatewayTaskExecutorKind::ChatTurn => crate::turn_executor::execute_chat_turn_task(state, task),
```

Posizionalo vicino a `ProactivePrompt`. Risultato finale:

```rust
fn execute_read_only_task(
    state: &AppState,
    task: &TaskRecord,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    match state
        .task_executor_registry
        .resolve(task.kind.as_str())
        .unwrap_or(GatewayTaskExecutorKind::LegacyLocal)
    {
        GatewayTaskExecutorKind::CapabilityBrowser => execute_capability_browser_task(state, task),
        GatewayTaskExecutorKind::CapabilityGeneric => execute_capability_generic_task(state, task),
        GatewayTaskExecutorKind::Subagent => execute_subagent_task(task),
        GatewayTaskExecutorKind::ProactivePrompt => execute_proactive_prompt_task(state, task),
        GatewayTaskExecutorKind::ChatTurn => crate::turn_executor::execute_chat_turn_task(state, task),
        GatewayTaskExecutorKind::LegacyShell => execute_shell_read_only_task(task),
        GatewayTaskExecutorKind::LegacyLocal => execute_local_read_only_task(task),
    }
}
```

- [ ] **Step 5.2: Verifica compilazione**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK.

- [ ] **Step 5.3: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): dispatch ChatTurn → execute_chat_turn_task

L'arm ChatTurn nel match di execute_read_only_task. Ora il worker pool può
eseguire chat_turn: il broker (Task 1-4) + il dispatch sono collegati."
```

---

## Task 6: Route HTTP — `POST /api/chat/turns` (enqueue)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/lib.rs` (per `EnqueueTurnRequest`)

- [ ] **Step 6.1: Aggiungi `EnqueueTurnRequest` in `lib.rs`**

In `crates/desktop-gateway/src/lib.rs`, aggiungi:

```rust
/// Body for POST /api/chat/turns. The new broker entry point.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct EnqueueTurnRequest {
    pub thread_id: String,
    pub prompt: String,
    #[serde(default)]
    pub visible_prompt: Option<String>,
    #[serde(default)]
    pub attachments: Option<serde_json::Value>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// "interactive" | "automation" | "channel" | "connector". Defaults to "interactive".
    #[serde(default)]
    pub source: Option<String>,
}
```

- [ ] **Step 6.2: Aggiungi l'handler `enqueue_turn` in `main.rs`**

Aggiungi un handler axum:

```rust
use local_first_task_runtime::broker::{self, ChatTurnInput, ChatTurnSource, EnqueueError, TurnApproval};

async fn enqueue_turn(
    State(state): State<AppState>,
    Json(req): Json<EnqueueTurnRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), GatewayError> {
    // Generate a request_id (the client may pass one; if not, generate chat_stream_* for compat).
    let request_id = format!("chat_stream_{}_{}", now_epoch_secs(), uuid::Uuid::new_v4().simple());

    let source = match req.source.as_deref().unwrap_or("interactive") {
        "automation" => ChatTurnSource::Automation,
        "channel" => ChatTurnSource::Channel,
        "connector" => ChatTurnSource::Connector,
        _ => ChatTurnSource::Interactive,
    };
    let approval = match source {
        ChatTurnSource::Interactive => TurnApproval::Full,
        _ => TurnApproval::Confirm, // automation default safe (Confirm)
    };

    let input = ChatTurnInput {
        thread_id: req.thread_id.clone(),
        request_id: request_id.clone(),
        prompt: req.prompt.clone(),
        visible_prompt: req.visible_prompt.clone(),
        attachments: req.attachments.clone(),
        mode: req.mode.clone(),
        model: req.model.clone(),
        source,
        approval,
    };

    // Resolve user_id/workspace_id from the thread (or defaults).
    let user_id = local_first_task_runtime::UserId::new("local"); // TODO: real user resolution
    let workspace_id = local_first_task_runtime::WorkspaceId::new("default"); // TODO: real workspace resolution

    let store = state.task_store.lock().map_err(|e| GatewayError::internal(format!("task store lock: {e}")))?;
    let user_id = local_first_task_runtime::UserId::new("local");
    let workspace_id = local_first_task_runtime::WorkspaceId::new("default");
    match broker::enqueue_chat_turn(&store, &user_id, &workspace_id, &input) {
        Ok(enqueued) => {
            let turn_id = enqueued.task_id.as_str().to_string();
            Ok((
                StatusCode::CREATED,
                Json(json!({
                    "turn_id": turn_id,
                    "thread_id": enqueued.thread_id,
                    "request_id": request_id,
                    "status": "queued",
                    "position_in_queue": enqueued.position_in_queue,
                })),
            ))
        }
        Err(EnqueueError::ThreadBusy { thread_id, active_turn_id }) => Ok((
            StatusCode::CONFLICT,
            Json(json!({
                "error": "thread_busy",
                "thread_id": thread_id,
                "active_turn_id": active_turn_id,
            })),
        )),
        Err(EnqueueError::Store(e)) => Err(GatewayError::internal(format!("enqueue store error: {e}"))),
    }
}
```

**Note:**
- `GatewayError::internal(...)` — verifica il costruttore esatto di `GatewayError` per errori generici (potrebbe essere `GatewayError::task(...)` o un altro; cerca `GatewayError::` nel file per il pattern corretto).
- `now_epoch_secs()` esiste già in `main.rs`.
- Lo user_id/workspace_id resolution è semplificato per la Slice 1a (usando defaults). Un task futuro lo risolverà dal thread. Documenta il TODO.

- [ ] **Step 6.3: Registra la route dietro flag**

Nel `chat_routes` builder (`main.rs:731+`, dove sono gli altri `.route("/api/chat/...")`), aggiungi in modo condizionale:

```rust
let chat_routes = Router::new()
    .route("/api/chat/threads", get(chat_threads).post(create_chat_thread))
    // ... route esistenti ...
    .route("/api/chat/generate_stream", post(generate_stream));

// Phase 1a: broker routes (gated by flag)
let chat_routes = if turn_broker_enabled() {
    chat_routes
        .route("/api/chat/turns", post(enqueue_turn))
} else {
    chat_routes
};
```

Aggiungi le altre route (`GET /turns/{id}`, `DELETE /turns/{id}`, `GET /turns/{id}/stream`, `GET /turns/{id}/events`) nei Task 7-8.

- [ ] **Step 6.4: Verifica compilazione**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK.

- [ ] **Step 6.5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/lib.rs
git commit -m "feat(gateway): POST /api/chat/turns — broker enqueue (behind flag)

Route dietro HOMUN_TURN_BROKER. Body EnqueueTurnRequest. Risolve source/approval,
genera request_id, chiama broker::enqueue_chat_turn. 201 Created o 409 Conflict."
```

---

## Task 7: Route HTTP — `GET /api/chat/turns/{id}`, `DELETE` (cancel), `GET .../events`

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 7.1: `get_turn` handler**

```rust
async fn get_turn(
    State(state): State<AppState>,
    Path(turn_id): Path<String>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    // turn_id ha la forma "turn_<request_id>"; il task_id sottostante è lo stesso.
    let store = state.task_store.lock().map_err(|e| GatewayError::internal(format!("task store lock: {e}")))?;
    let user_id = local_first_task_runtime::UserId::new("local");
    let workspace_id = local_first_task_runtime::WorkspaceId::new("default");
    let task_id = local_first_task_runtime::TaskId::new(&turn_id);
    let task = store
        .get_task(&task_id, &user_id, &workspace_id)
        .map_err(|e| GatewayError::internal(format!("get_task: {e}")))?
        .ok_or_else(|| GatewayError::not_found(&turn_id))?;
    let position_in_queue = if matches!(task.status, local_first_task_runtime::TaskStatus::Queued) {
        0u32 // semplificato: con 1-turn-per-thread la posizione è sempre 0 o 1
    } else {
        0
    };
    Ok(Json(json!({
        "turn_id": turn_id,
        "thread_id": task.input_json.get("thread_id").and_then(|v| v.as_str()),
        "request_id": task.input_json.get("request_id").and_then(|v| v.as_str()),
        "status": format!("{:?}", task.status).to_lowercase(),
        "priority": format!("{:?}", task.priority).to_lowercase(),
        "source": task.input_json.get("source").and_then(|v| v.as_str()),
        "created_at": task.created_at.unix_timestamp(),
        "updated_at": task.updated_at.unix_timestamp(),
        "position_in_queue": position_in_queue,
    })))
}
```

- [ ] **Step 7.2: `cancel_turn` handler (DELETE)**

```rust
async fn cancel_turn(
    State(state): State<AppState>,
    Path(turn_id): Path<String>,
) -> Result<StatusCode, GatewayError> {
    let store = state.task_store.lock().map_err(|e| GatewayError::internal(format!("task store lock: {e}")))?;
    let user_id = local_first_task_runtime::UserId::new("local");
    let workspace_id = local_first_task_runtime::WorkspaceId::new("default");
    let task_id = local_first_task_runtime::TaskId::new(&turn_id);
    let ok = broker::cancel_chat_turn(&store, &user_id, &workspace_id, &task_id, &GatewayCancelNotify)
        .map_err(|e| GatewayError::internal(format!("cancel: {e}")))?;
    if ok {
        Ok(StatusCode::ACCEPTED)
    } else {
        Ok(StatusCode::NOT_FOUND)
    }
}
```

- [ ] **Step 7.3: `get_turn_events` handler**

```rust
async fn get_turn_events(
    State(state): State<AppState>,
    Path(turn_id): Path<String>,
    Query(query): Query<TurnEventsQuery>,
) -> Result<Json<Vec<serde_json::Value>>, GatewayError> {
    #[derive(serde::Deserialize)]
    struct TurnEventsQuery {
        #[serde(default)]
        since: Option<i64>,
    }
    let since = query.since.unwrap_or(0);
    let store = state.task_store.lock().map_err(|e| GatewayError::internal(format!("task store lock: {e}")))?;
    let events = store
        .read_turn_events(&turn_id, since)
        .map_err(|e| GatewayError::internal(format!("read_turn_events: {e}")))?;
    let out: Vec<_> = events
        .into_iter()
        .map(|e| json!({
            "seq": e.seq,
            "kind": e.kind.as_str(),
            "payload": e.payload,
            "created_at": e.created_at,
        }))
        .collect();
    Ok(Json(out))
}
```

**Nota:** `Query` di axum richiede `use axum::extract::Query;` — verifica che sia già importato (probabilmente sì, dato che altre route lo usano). La struct `TurnEventsQuery` può stare dentro la funzione o a livello di modulo; se la metti dentro, usa `serde::Deserialize`.

- [ ] **Step 7.4: Registra le route dietro flag**

Nel blocco condizionale del Task 6.3, estendi:

```rust
let chat_routes = if turn_broker_enabled() {
    chat_routes
        .route("/api/chat/turns", post(enqueue_turn))
        .route("/api/chat/turns/{turn_id}", get(get_turn).delete(cancel_turn))
        .route("/api/chat/turns/{turn_id}/events", get(get_turn_events))
} else {
    chat_routes
};
```

- [ ] **Step 7.5: Verifica compilazione**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK.

- [ ] **Step 7.6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): GET/DELETE /turns/{id} + GET .../events (behind flag)

get_turn: stato del turno da task.status. cancel_turn: DELETE → broker::cancel
+ GatewayCancelNotify (notify istantaneo + DB flag). get_turn_events: replay
batch con ?since=."
```

---

## Task 8: Route HTTP — `GET /api/chat/turns/{id}/stream` (subscribe live)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 8.1: `subscribe_turn_stream` handler**

Questo è il subscribe live: replay degli eventi `turn_events` con `seq > since`, poi attach al broadcast channel per gli eventi live. Ritorna un NDJSON stream.

```rust
async fn subscribe_turn_stream(
    State(state): State<AppState>,
    Path(turn_id): Path<String>,
    Query(query): Query<TurnStreamQuery>,
) -> Result<Response, GatewayError> {
    #[derive(serde::Deserialize)]
    struct TurnStreamQuery {
        #[serde(default)]
        since: Option<i64>,
    }
    let since = query.since.unwrap_or(0);

    // 1) Replay: leggi gli eventi turn_events con seq > since dal DB.
    let replay: Vec<_> = {
        let store = state.task_store.lock().map_err(|e| GatewayError::internal(format!("lock: {e}")))?;
        store
            .read_turn_events(&turn_id, since)
            .map_err(|e| GatewayError::internal(format!("read_turn_events: {e}")))?
            .into_iter()
            .map(|e| json!({
                "seq": e.seq,
                "kind": e.kind.as_str(),
                "payload": e.payload,
                "created_at": e.created_at,
            }))
            .collect()
    };

    // 2) Attach al broadcast channel (se il turno è ancora live).
    let rx = turn_broadcast_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&turn_id).map(|b| b.tx.subscribe()));

    // 3) Costruisci il NDJSON stream: prima replay, poi live.
    let (tx_stream, rx_stream) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(64);

    tokio::spawn(async move {
        // Replay
        let mut last_seq = since;
        for event in replay {
            last_seq = event["seq"].as_i64().unwrap_or(last_seq).max(last_seq);
            let line = format!("{}\n", serde_json::to_string(&event).unwrap_or_default());
            if tx_stream.send(Ok(bytes::Bytes::from(line))).await.is_err() {
                return;
            }
        }
        // Live
        if let Some(mut rx) = rx {
            while let Ok(event) = rx.recv().await {
                if event.seq <= last_seq {
                    continue; // dedup: già inviato nel replay
                }
                let payload = json!({
                    "seq": event.seq,
                    "kind": event.kind,
                    "payload": event.payload,
                });
                let line = format!("{}\n", serde_json::to_string(&payload).unwrap_or_default());
                if tx_stream.send(Ok(bytes::Bytes::from(line))).await.is_err() {
                    return;
                }
            }
        }
    });

    let body = axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx_stream));
    let response = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .header("cache-control", "no-cache")
        .body(body)
        .map_err(|e| GatewayError::internal(format!("response build: {e}")))?;
    Ok(response)
}
```

**Note:**
- Verifica che `tokio_stream` sia una dipendenza (probabilmente sì; `ReceiverStream` è usato altrove). Se non lo è, usa il pattern già usato per altri stream NDJSON nel file (cerca `Body::from_stream` per vedere l'approccio esistente — potrebbe usare `tokio::sync::mpsc::Receiver` direttamente con un adapter diverso).
- `bytes::Bytes` — verifica l'import.
- `axum::body::Body::from_stream` è il pattern già usato (vedi `stream_chat_via_openai`).

- [ ] **Step 8.2: Registra la route dietro flag**

Nel blocco condizionale:

```rust
let chat_routes = if turn_broker_enabled() {
    chat_routes
        .route("/api/chat/turns", post(enqueue_turn))
        .route("/api/chat/turns/{turn_id}", get(get_turn).delete(cancel_turn))
        .route("/api/chat/turns/{turn_id}/events", get(get_turn_events))
        .route("/api/chat/turns/{turn_id}/stream", get(subscribe_turn_stream))
} else {
    chat_routes
};
```

- [ ] **Step 8.3: Verifica compilazione**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK.

- [ ] **Step 8.4: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): GET /turns/{id}/stream — replay + live NDJSON (behind flag)

Replay degli eventi turn_events con seq > ?since=, poi attach al broadcast
per- turn_id per gli eventi live. NDJSON stream. Dedup via seq. Subscribe
non possessivo: la chiusura del client NON interrompe il turno."
```

---

## Task 9: Recovery al boot + `generate_stream` shim

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 9.1: Recovery al boot dietro flag**

Nel `main` (vicino alla riga `eprintln!("turn broker: ...", turn_broker_enabled())`, `main.rs:718`), aggiungi il recovery quando il flag è on:

```rust
if turn_broker_enabled() {
    let store = state.task_store.lock().expect("task store lock at boot");
    let generation = store.bump_process_generation().expect("bump process generation");
    let user_id = local_first_task_runtime::UserId::new("local");
    let workspace_id = local_first_task_runtime::WorkspaceId::new("default");
    let recovered = local_first_task_runtime::broker::recover_chat_turns_at_boot(
        &store, &user_id, &workspace_id, generation,
    )
    .unwrap_or_else(|e| {
        eprintln!("turn broker: recovery error: {e}");
        Vec::new()
    });
    eprintln!("turn broker: recovery generation={generation} recovered={} turns", recovered.len());
    drop(store);
}
```

Posizionalo **dopo** l'apertura del task_store ma **prima** di `start_task_executor_worker(state.clone())` (così i turni recoverati sono già in coda quando i worker partono).

- [ ] **Step 9.2: `generate_stream` shim dietro flag**

Nel handler `generate_stream` (`main.rs:13650`), aggiungi un branch in cima che, quando il flag è on, reinstrada via broker:

```rust
async fn generate_stream(
    State(state): State<AppState>,
    Json(request): Json<ChatGenerateStreamRequest>,
) -> Result<Response, GatewayError> {
    // Phase 1a: when the broker is enabled, redirect through the broker.
    if turn_broker_enabled() {
        return generate_stream_via_broker(State(state), Json(request)).await;
    }
    // ... existing code unchanged ...
}
```

E crea la funzione shim `generate_stream_via_broker` che:
1. Costruisce un `ChatTurnInput` dal `ChatGenerateStreamRequest` (mappando `request_id`, `thread_id`, `prompt`, `source = Interactive`).
2. Chiama `broker::enqueue_chat_turn`. Se `ThreadBusy`, ritorna 409 in formato compatibile. Se ok, ritorna 201 con `turn_id` nello stesso formato che il client si aspetta (per retrocompatibilità, puoi ritornare un body che indica di reindirizzarsi a `/turns/{id}/stream`).
3. **Per la Slice 1a**, lo shim può essere minimale: enqueue + redirect response. Il flusso "enqueue + stream nella stessa response" è possibile ma complesso; per ora ritorna 201 con il `turn_id` e lascia che il client si abboni separatamente.

```rust
async fn generate_stream_via_broker(
    State(state): State<AppState>,
    Json(request): Json<ChatGenerateStreamRequest>,
) -> Result<Response, GatewayError> {
    let thread_id = request.thread_id.clone().unwrap_or_else(|| format!("thread_{}", now_epoch_secs()));
    let request_id = request.request_id.clone();
    let input = ChatTurnInput {
        thread_id: thread_id.clone(),
        request_id: request_id.clone(),
        prompt: request.prompt.clone(),
        visible_prompt: None,
        attachments: None,
        mode: None,
        model: request.model.clone(),
        source: ChatTurnSource::Interactive,
        approval: TurnApproval::Full,
    };
    let store = state.task_store.lock().map_err(|e| GatewayError::internal(format!("lock: {e}")))?;
    let user_id = local_first_task_runtime::UserId::new("local");
    let workspace_id = local_first_task_runtime::WorkspaceId::new("default");
    match broker::enqueue_chat_turn(&store, &user_id, &workspace_id, &input) {
        Ok(enqueued) => {
            let turn_id = enqueued.task_id.as_str().to_string();
            // Tell the client to subscribe to the broker stream.
            let body = axum::body::Body::from(serde_json::to_vec(&json!({
                "turn_id": turn_id,
                "request_id": request_id,
                "thread_id": thread_id,
                "status": "queued",
                "stream_url": format!("/api/chat/turns/{turn_id}/stream"),
            })).unwrap_or_default());
            Ok(Response::builder()
                .status(StatusCode::CREATED)
                .header("content-type", "application/json")
                .body(body)
                .map_err(|e| GatewayError::internal(format!("response: {e}")))?)
        }
        Err(EnqueueError::ThreadBusy { thread_id, active_turn_id }) => {
            let body = axum::body::Body::from(serde_json::to_vec(&json!({
                "error": "thread_busy",
                "thread_id": thread_id,
                "active_turn_id": active_turn_id,
            })).unwrap_or_default());
            Ok(Response::builder()
                .status(StatusCode::CONFLICT)
                .header("content-type", "application/json")
                .body(body)
                .map_err(|e| GatewayError::internal(format!("response: {e}")))?)
        }
        Err(EnqueueError::Store(e)) => Err(GatewayError::internal(format!("enqueue: {e}"))),
    }
}
```

- [ ] **Step 9.3: Verifica compilazione**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK.

- [ ] **Step 9.4: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): boot recovery + generate_stream shim (behind flag)

Recovery lease-aware al boot dietro flag: bump_process_generation +
recover_chat_turns_at_boot. generate_stream shim: quando il broker è on,
reinstrada via broker (enqueue + 201 con stream_url) invece del path diretto."
```

---

## Task 10: Smoke test finale + Definition of Done

- [ ] **Step 10.1: Verifica che tutto compili**

Run: `cargo build --workspace`
Expected: OK, no new errors.

- [ ] **Step 10.2: Verifica che il crate task-runtime sia ancora verde**

Run: `cargo test -p local-first-task-runtime`
Expected: tutti i test PASS (la Fase 0 non deve regredire).

- [ ] **Step 10.3: Verifica i test del gateway**

Run: `cargo test -p local-first-desktop-gateway task_registry::tests turn_executor::tests -- --nocapture`
Expected: PASS.

- [ ] **Step 10.4: Smoke test manuale (HOMUN_TURN_BROKER=off → behavior invariato)**

Avvia il gateway con `HOMUN_TURN_BROKER` non impostato (default off). Verifica:
- Il log di boot dice `turn broker: enabled=false`.
- `POST /api/chat/generate_stream` funziona come prima (path diretto).
- Le route `/api/chat/turns` non sono registrate (404).

Questo conferma che la Slice 1a è invisibile quando il flag è off.

- [ ] **Step 10.5: Smoke test manuale (HOMUN_TURN_BROKER=on → broker path)**

Avvia con `HOMUN_TURN_BROKER=on`. Verifica:
- Il log di boot dice `turn broker: enabled=true` e la recovery gira (anche se la coda è vuota: `recovered=0`).
- `POST /api/chat/turns` con un body `{"thread_id":"...","prompt":"ciao"}` ritorna 201 con `turn_id`.
- Un secondo POST sullo stesso thread ritorna 409.
- `GET /api/chat/turns/{id}` ritorna lo stato (inizialmente `queued`, poi `running`, poi `completed`).
- `GET /api/chat/turns/{id}/stream` ritorna NDJSON con gli eventi (delta, done).
- `DELETE /api/chat/turns/{id}` ritorna 202 e il turno viene cancellato.

(Se non puoi avviare il gateway in questo ambiente, documenta questo step come "verifica manuale da fare in produzione" e procedi.)

- [ ] **Step 10.6: Commit finale**

```bash
git add -A
git commit -m "test(gateway): smoke checks for Phase 1a broker live

Verifica: build workspace OK, task-runtime non regredisce, gateway compila.
Smoke manuale off/on documentato. Slice 1a completa: broker live dietro flag."
```

---

## Definition of Done — Slice 1a

- [ ] `GatewayTaskExecutorKind::ChatTurn` registrato (`task_registry.rs`).
- [ ] Modulo `turn_executor.rs` con `TurnBroadcast` registry, `emit_turn_event`, `GatewayCancelNotify`, `execute_chat_turn_task`.
- [ ] `run_agent_turn_into_message_with_fanout` (fan-out stream → `turn_events` + broadcast).
- [ ] Dispatch arm `ChatTurn => execute_chat_turn_task` in `execute_read_only_task`.
- [ ] 5 route HTTP dietro `HOMUN_TURN_BROKER`: `POST /turns`, `GET /turns/{id}`, `DELETE /turns/{id}`, `GET /turns/{id}/events`, `GET /turns/{id}/stream`.
- [ ] Recovery al boot (`bump_process_generation` + `recover_chat_turns_at_boot`) dietro flag.
- [ ] `generate_stream` shim: quando flag on, reinstrada via broker.
- [ ] **Behavior invariato quando `HOMUN_TURN_BROKER=off`** (default).
- [ ] Tutti i test PASS, workspace compila.

## Cosa NON è in questo piano (Slice 1b e Fasi successive)

- **Slice 1b (browser preemption)**: unificazione `browse_web_lock` ↔ `ResourceGovernor`, governor promosso in `AppState`, `BrowserSession` resource requirement nei turni interattivi, hook cooperativi di release nei 7 tool handler del browser, preemption basata su `TaskPriority`. Sarà un piano separato.
- **Fase 2**: migrazione client (desktop) al nuovo path `POST /turns` + subscribe separato, rimozione di `promptSubmitting` come source of truth, working island alimentata da `turn_events`, cleanup di `turn_priority`/`turn_status`/`browse_web_lock`/`wait_if_busy`.
- **Fase 3**: multi-process, WebSocket multiplex, backpressure, working island multi-thread.

## Rischi e residuali onesti (Slice 1a)

1. **User/workspace resolution semplificata**: gli handler usano `UserId::new("local")`/`WorkspaceId::new("default")` hardcoded. Per ora funziona (single-user local-first), ma un task futuro deve risolverli dal thread. Documentato con TODO.
2. **`run_agent_turn_into_message_with_fanout` duplica logica**: invece di duplicare `drain_agent_stream_into_message`, l'approccio raccomandato è aggiungere un parametro `turn_id: Option<&str>` alla funzione esistente. Se la duplicazione è inevitabile, documentare il debito.
3. **Browser non gestito dal governor**: in questa slice, i turni broker usano ancora `acquire_browse_lock_queued` (via `stream_chat_via_openai` → tool browser). Il governor non li vede. Questo significa che la concorrenza del browser resta FIFO (non priority-aware) fino alla Slice 1b. Onestamente dichiarato.
4. **Shim `generate_stream` ritorna JSON, non stream**: la Slice 1a fa enqueue + 201 con `stream_url`. Il client deve adattarsi per subscribe separato. Questo è intenzionale (lo streaming nella stessa response è la Fase 2); per ora i client vecchi continuano a usare il path diretto (flag off).
5. **Cancel latency**: l'executor polla il cancel via `Notify` (istantaneo in-process). Documentare che il cancel funziona solo quando il turno è attivo nel worker pool locale (multi-process = Fase 3).
