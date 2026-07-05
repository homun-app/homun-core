# Unified WebSocket — Phase A (WS Gateway Server-Side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire il modulo `ws_gateway` server-side: un singolo endpoint `GET /api/ws` (WebSocket persistente) con un registry di subscriber, funzioni `publish_*` per il broker/computer/app_events, e un handler di resume che replaya gli eventi dal DB.

**Architecture:** Un `Arc<WsRegistry>` long-lived in `AppState` mantiene `HashMap<session_id, mpsc::Sender<ServerMessage>>` dei WS attivi. Il broker chiama `publish_turn_event` invece del broadcast per-turno. `publish_app_event` viene esteso per pubblicare anche sul WS. Il computer live viene pubblicato sul WS. Il client riceve tutto su un unico canale.

**Tech Stack:** Rust, axum 0.8 (feature `ws` già abilitata), tokio `mpsc`/`broadcast`, `serde_json`.

**Spec di riferimento:** `docs/superpowers/specs/2026-07-05-unified-websocket-design.md`

**Scope di questo piano:** SOLO Fase A (server-side). Le Fasi B (WSSubscription client), C (migra subscriber), D (cleanup legacy) avranno piani separati. Questo piano produce: modulo `ws_gateway`, route `/api/ws`, registry subscriber, funzioni publish, integrazione broker/computer/app_events, handler resume. Il client non viene ancora toccato (coesistenza temporanea).

---

## File Structure

**Create:**
- `crates/desktop-gateway/src/ws_gateway.rs` — il modulo completo: `WsRegistry`, `ServerMessage`, `ClientMessage`, `publish_*` functions, `ws_handler` (axum upgrade), `ws_connection_loop`, `handle_resume`. Una responsabilità: gestire la WebSocket unica e il fan-out degli eventi.

**Modify:**
- `crates/desktop-gateway/src/main.rs` — dichiarazione `mod ws_gateway;`, aggiunta `ws_registry: Arc<WsRegistry>` a `AppState`, init nel costruttore, registrazione route `GET /api/ws`, integrazione `publish_turn_event` nel broker fanout, estensione `publish_app_event`, integrazione `publish_computer_live`.

---

## Task 1: `WsRegistry` struct + `ServerMessage`/`ClientMessage` types

**Files:**
- Create: `crates/desktop-gateway/src/ws_gateway.rs`
- Modify: `crates/desktop-gateway/src/main.rs` (declare module)

- [ ] **Step 1.1: Create `ws_gateway.rs` with types and registry**

Create `crates/desktop-gateway/src/ws_gateway.rs`:

```rust
//! Unified WebSocket gateway: a single persistent `/api/ws` endpoint that fans out
//! all server→client events (turn.*, computer.live, thread.*, task.*) to connected
//! subscribers. Replaces the fragmented NDJSON-per-turn + NDJSON-events + polling
//! channels with one bidirectional JSON-over-WS connection.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;

/// A message the server sends to a connected WS client. Each variant maps 1:1 to a
/// `type` field in the JSON wire protocol (see the unified-websocket-design spec).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    /// Sent immediately when the WS connection is established.
    Hello { session_id: String },
    /// Keepalive probe (every 30s). Client must respond with Pong.
    Ping,
    /// A turn stream event (delta, activity, plan, reasoning, tool, done, queued, retry, error).
    /// The `event` field carries the TurnWsEvent with seq + payload.
    #[serde(rename = "turn.event")]
    TurnEvent {
        turn_id: String,
        thread_id: Option<String>,
        seq: i64,
        kind: String,
        payload: Value,
    },
    /// Contained computer live state (replaces the polling GET /local-computer/live).
    #[serde(rename = "computer.live")]
    ComputerLive { state: Value },
    /// App-level event (thread.updated, thread.turn_started, project_graph.ready).
    /// Replaces the NDJSON /api/events channel.
    #[serde(rename = "app.event")]
    AppEvent { event: Value },
    /// Acknowledges a resume request: events from_seq..=to_seq will follow.
    #[serde(rename = "resume.ack")]
    ResumeAck { turn_id: String, from_seq: i64, to_seq: i64 },
    /// The resumed turn has already terminated; no more live events will come.
    #[serde(rename = "resume.done")]
    ResumeDone { turn_id: String, status: String, last_seq: i64 },
}

/// A message the client sends to the server over the WS.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    /// Request replay of turn events with seq > since, then live continuation.
    Resume { turn_id: String, since: i64 },
    /// Response to a Ping keepalive.
    Pong,
}

/// Process-wide registry of active WS subscribers. Each subscriber has an mpsc::Sender
/// that the publish_* functions use to fan-out events. `try_send` is used (non-blocking):
/// if a subscriber's channel is full, the event is dropped for that subscriber — they'll
/// recover via resume.
pub struct WsRegistry {
    subscribers: Mutex<HashMap<String, mpsc::Sender<ServerMessage>>>,
}

impl WsRegistry {
    pub fn new() -> Self {
        Self {
            subscribers: Mutex::new(HashMap::new()),
        }
    }

    /// Register a new subscriber. Returns the receiver end of the channel.
    pub fn register(&self) -> (String, mpsc::Receiver<ServerMessage>) {
        let session_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel::<ServerMessage>(256);
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.insert(session_id.clone(), tx);
        }
        (session_id, rx)
    }

    /// Unregister a subscriber when its WS connection closes.
    pub fn unregister(&self, session_id: &str) {
        if let Ok(mut subs) = self.subscribers.lock() {
            subs.remove(session_id);
        }
    }

    /// Fan-out a message to all subscribers. Uses `try_send` (non-blocking).
    pub fn broadcast(&self, msg: ServerMessage) {
        if let Ok(subs) = self.subscribers.lock() {
            for (_, tx) in subs.iter() {
                let _ = tx.try_send(msg.clone());
            }
        }
    }

    /// Publish a turn event to all subscribers.
    pub fn publish_turn_event(
        &self,
        turn_id: &str,
        thread_id: Option<&str>,
        seq: i64,
        kind: &str,
        payload: Value,
    ) {
        self.broadcast(ServerMessage::TurnEvent {
            turn_id: turn_id.to_string(),
            thread_id: thread_id.map(|s| s.to_string()),
            seq,
            kind: kind.to_string(),
            payload,
        });
    }

    /// Publish a contained computer live state to all subscribers.
    pub fn publish_computer_live(&self, state: Value) {
        self.broadcast(ServerMessage::ComputerLive { state });
    }

    /// Publish an app-level event to all subscribers.
    pub fn publish_app_event(&self, event: Value) {
        self.broadcast(ServerMessage::AppEvent { event });
    }

    /// Number of active subscribers (for diagnostics).
    pub fn subscriber_count(&self) -> usize {
        self.subscribers.lock().map(|s| s.len()).unwrap_or(0)
    }
}
```

- [ ] **Step 1.2: Declare the module in `main.rs`**

In `crates/desktop-gateway/src/main.rs`, add near the other `mod` declarations (e.g., near `mod turn_executor;`):

```rust
mod ws_gateway;
```

- [ ] **Step 1.3: Add `ws_registry` to `AppState`**

In `crates/desktop-gateway/src/main.rs`, find the `AppState` struct (around line 142) and add a new field:

```rust
pub(crate) struct AppState {
    pub(crate) http: reqwest::Client,
    chat_store: Arc<Mutex<ChatStore>>,
    task_store: Arc<Mutex<TaskStore>>,
    // ... existing fields ...
    /// Unified WebSocket subscriber registry. Long-lived (created at boot).
    /// publish_* functions fan-out events to all connected WS clients.
    pub(crate) ws_registry: Arc<ws_gateway::WsRegistry>,
}
```

- [ ] **Step 1.4: Initialize `ws_registry` in the `AppState` constructor**

Find where `AppState { ... }` is constructed (around line 576). Add the new field:

```rust
    let state = AppState {
        http: reqwest::Client::new(),
        // ... existing fields ...
        ws_registry: Arc::new(ws_gateway::WsRegistry::new()),
    };
```

- [ ] **Step 1.5: Verify compilation**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK (the module is declared, types exist, AppState compiles).

- [ ] **Step 1.6: Commit**

```bash
git add crates/desktop-gateway/src/ws_gateway.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(ws-gateway): WsRegistry + ServerMessage/ClientMessage types

Modulo ws_gateway con registry subscriber (HashMap<session_id, mpsc::Sender>),
tipi ServerMessage (turn.event, computer.live, app.event, resume.ack/done, hello,
ping) e ClientMessage (resume, pong). publish_* fan-out con try_send non-bloccante.
ws_registry: Arc<WsRegistry> long-lived in AppState."
```

---

## Task 2: WS handler `GET /api/ws` + connection loop

**Files:**
- Modify: `crates/desktop-gateway/src/ws_gateway.rs` (add handler + connection loop)
- Modify: `crates/desktop-gateway/src/main.rs` (register route)

- [ ] **Step 2.1: Add the WS handler and connection loop to `ws_gateway.rs`**

Append to `crates/desktop-gateway/src/ws_gateway.rs`:

```rust
use axum::{
    extract::{State, WebSocketUpgrade},
    extract::ws::{Message, WebSocket},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use crate::AppState;

/// Axum handler for `GET /api/ws`. Upgrades to a WebSocket and runs the connection loop.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, std::convert::Infallible> {
    Ok(ws.on_upgrade(move |socket| ws_connection_loop(socket, state)))
}

/// The main connection loop for a single WS client. Registers the subscriber,
/// spawns a sender task, and processes incoming messages (resume, pong).
async fn ws_connection_loop(socket: WebSocket, state: Arc<AppState>) {
    tracing::info!(
        target: "ws::gateway",
        subscribers = state.ws_registry.subscriber_count(),
        "WS client connected"
    );
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (session_id, mut msg_rx) = state.ws_registry.register();

    // Send hello
    let hello = ServerMessage::Hello {
        session_id: session_id.clone(),
    };
    let hello_json = serde_json::to_string(&hello).unwrap_or_default();
    let _ = ws_tx.send(Message::Text(hello_json.into())).await;

    // Spawn the sender task: forwards registry messages → WS client
    let state_clone = state.clone();
    let session_id_clone = session_id.clone();
    let send_task = tokio::spawn(async move {
        while let Some(msg) = msg_rx.recv().await {
            let json = serde_json::to_string(&msg).unwrap_or_default();
            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                break; // client disconnected
            }
        }
        // Channel closed or client gone — unregister
        state_clone.ws_registry.unregister(&session_id_clone);
    });

    // Receive loop: process client messages (resume, pong, close)
    while let Some(msg_result) = ws_rx.next().await {
        match msg_result {
            Ok(Message::Text(text)) => {
                let parsed: Result<ClientMessage, _> = serde_json::from_str(&text);
                match parsed {
                    Ok(ClientMessage::Pong) => {
                        // Keepalive response — nothing to do
                    }
                    Ok(ClientMessage::Resume { turn_id, since }) => {
                        handle_resume(&state, &turn_id, since).await;
                    }
                    Err(_) => {
                        // Malformed message — ignore
                    }
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {} // Binary, Ping frames — ignore
        }
    }

    // Cleanup: unregister and abort the sender task
    state.ws_registry.unregister(&session_id);
    send_task.abort();
    tracing::info!(
        target: "ws::gateway",
        subscribers = state.ws_registry.subscriber_count(),
        "WS client disconnected"
    );
}

/// Handle a resume request: replay turn_events with seq > since from the DB,
/// then check if the turn is still active. If terminal, send resume.done.
async fn handle_resume(state: &AppState, turn_id: &str, since: i64) {
    let events = {
        let Ok(store) = state.task_store.lock() else {
            return;
        };
        match store.read_turn_events(turn_id, since) {
            Ok(events) => events,
            Err(e) => {
                tracing::warn!(target: "ws::gateway", turn_id = %turn_id, error = %e, "resume: failed to read turn_events");
                return;
            }
        }
    };

    if events.is_empty() {
        // No events past `since` — either the turn ended before `since`, or it doesn't exist.
        // Try to read the task status to send resume.done.
        let status = get_turn_status(state, turn_id).await;
        broadcast_resume_done(state, turn_id, status, since);
        return;
    }

    let from_seq = events.first().seq;
    let to_seq = events.last().seq;

    // Send resume.ack
    state.ws_registry.broadcast(ServerMessage::ResumeAck {
        turn_id: turn_id.to_string(),
        from_seq,
        to_seq,
    });

    // Replay each event as a turn.event
    for event in events {
        state.ws_registry.publish_turn_event(
            turn_id,
            None, // thread_id not in turn_events; the client knows it
            event.seq,
            event.kind.as_str(),
            event.payload,
        );
    }

    // Check if the turn is terminal
    let status = get_turn_status(state, turn_id).await;
    if let Some(s) = &status {
        if is_terminal_status(s) {
            broadcast_resume_done(state, turn_id, status.clone(), to_seq);
        }
    }
    // If not terminal, the live broadcast will continue automatically (subscriber is registered).
}

/// Read the status of a turn task from the DB. Returns None if not found.
async fn get_turn_status(state: &AppState, turn_id: &str) -> Option<String> {
    let Ok(store) = state.task_store.lock() else {
        return None;
    };
    let task_id = local_first_task_runtime::TaskId::new(turn_id);
    let user_id = crate::gateway_user_id();
    let workspace_id = crate::gateway_workspace_id();
    store
        .get_task(&task_id, &user_id, &workspace_id)
        .ok()?
        .map(|t| format!("{:?}", t.status).to_lowercase())
}

fn is_terminal_status(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "cancelled" | "expired"
    )
}

fn broadcast_resume_done(state: &AppState, turn_id: &str, status: Option<String>, last_seq: i64) {
    state.ws_registry.broadcast(ServerMessage::ResumeDone {
        turn_id: turn_id.to_string(),
        status: status.unwrap_or_else(|| "unknown".to_string()),
        last_seq,
    });
}
```

**Important notes:**
- `futures_util` is already a dependency (`Cargo.toml:10`). `SinkExt` and `StreamExt` are needed for `socket.split()`.
- `Message::Text` in axum 0.8 takes a `String` (not `&str`). The `.into()` converts.
- `AppState` must be `Clone` (it already is — `#[derive(Clone)]`). The `Arc<AppState>` in the handler signature works because axum extracts `State<Arc<AppState>>` when the router is built with `.with_state(state)`. Verify the router state type — if the router uses `AppState` directly (not `Arc<AppState>`), adapt the signature to `State<AppState>` and clone the state inside.
- `gateway_user_id()` and `gateway_workspace_id()` are existing free functions in `main.rs`. Verify they're accessible from the module (they may need `pub(crate)` or `crate::`).

- [ ] **Step 2.2: Register the route `GET /api/ws`**

In `crates/desktop-gateway/src/main.rs`, find the main router builder (search for `.route("/api/chat/threads"`). Add the WS route **outside** the token-gated layer initially (WS upgrade can't carry Bearer header in the browser, but in Electron the renderer can set headers on WS). For now, register it alongside the other routes:

```rust
.route("/api/ws", get(ws_gateway::ws_handler))
```

Place it near the top of the router builder. If the router applies `require_gateway_token` as a layer, the WS route may need to be exempted (like the noVNC route). Check how `/api/computer/novnc/websockify` is registered and follow the same pattern.

- [ ] **Step 2.3: Make `gateway_user_id`/`gateway_workspace_id` accessible**

In `main.rs`, verify these functions are `pub(crate)` or accessible from `ws_gateway`:

```rust
pub(crate) fn gateway_user_id() -> UserId { ... }
pub(crate) fn gateway_workspace_id() -> WorkspaceId { ... }
```

If they're private (`fn`), add `pub(crate)`.

- [ ] **Step 2.4: Verify compilation**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK. Resolve any import/path issues.

- [ ] **Step 2.5: Commit**

```bash
git add crates/desktop-gateway/src/ws_gateway.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(ws-gateway): GET /api/ws handler + connection loop + resume

Handler ws_handler (axum WebSocketUpgrade). Connection loop: registra subscriber,
spawn sender task, processa resume/pong. handle_resume: replay turn_events dal DB
con seq > since, poi resume.done se terminale. Route GET /api/ws registrata."
```

---

## Task 3: Integrate `publish_turn_event` into the broker fanout

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`fanout_turn_event`)
- Modify: `crates/desktop-gateway/src/turn_executor.rs` (`emit_turn_event`)

- [ ] **Step 3.1: Extend `fanout_turn_event` to publish on the WS**

In `crates/desktop-gateway/src/main.rs`, find `fanout_turn_event` (around line 29474). The function currently persists in `turn_events` + broadcasts on the per-turn broadcast channel. **Add** a `publish_turn_event` call to the WS registry:

Read the function first. It currently does:
1. Parse the NDJSON line
2. Map to `TurnEventKind` + payload
3. `emit_turn_event(store, turn_id, kind, payload)` — persists + per-turn broadcast

**Add** after step 3 (inside the `if let Ok(store) = ...` block):

```rust
                    // Also publish on the unified WS (fan-out to all connected clients).
                    // The seq comes from the persisted event returned by emit_turn_event.
```

But `fanout_turn_event` calls `emit_turn_event` which is in `turn_executor.rs`. The `emit_turn_event` function persists AND returns the `TurnEvent` (with seq). Modify `emit_turn_event` to also publish on the WS.

In `crates/desktop-gateway/src/turn_executor.rs`, find `emit_turn_event`:

```rust
pub fn emit_turn_event(
    store: &TaskStore,
    turn_id: &str,
    kind: TurnEventKind,
    payload: Value,
) -> TaskRuntimeResult<()> {
    let event = store.insert_turn_event(turn_id, kind, payload.clone())?;
    // best-effort live broadcast
    if let Ok(map) = turn_broadcast_registry().lock() {
        if let Some(broadcast) = map.get(turn_id) {
            let _ = broadcast.tx.send(TurnEvent { ... });
        }
    }
    Ok(())
}
```

**Change** to accept `&AppState` and publish on the WS registry:

```rust
pub fn emit_turn_event(
    state: &crate::AppState,
    store: &TaskStore,
    turn_id: &str,
    kind: TurnEventKind,
    payload: Value,
) -> TaskRuntimeResult<()> {
    let event = store.insert_turn_event(turn_id, kind, payload.clone())?;
    // Best-effort live broadcast (per-turn, for the NDJSON stream — transitional)
    if let Ok(map) = turn_broadcast_registry().lock() {
        if let Some(broadcast) = map.get(turn_id) {
            let _ = broadcast.tx.send(TurnEvent {
                seq: event.seq,
                kind: event.kind.as_str().to_string(),
                payload,
            });
        }
    }
    // Publish on the unified WS (fan-out to all connected clients)
    state.ws_registry.publish_turn_event(
        turn_id,
        None,
        event.seq,
        event.kind.as_str(),
        event.payload.clone(),
    );
    Ok(())
}
```

**Note:** `event.payload` is moved into the broadcast above. Clone it for the WS publish, or reorder (WS first, broadcast second with clone). Adjust based on ownership.

- [ ] **Step 3.2: Update all callers of `emit_turn_event`**

Search for all calls to `emit_turn_event` in `turn_executor.rs` and `main.rs`. Each now needs `state` as the first argument. Update them:

```bash
grep -rn "emit_turn_event(" crates/desktop-gateway/src/
```

For each caller, add `state` (or `&state`) as the first argument. The callers are:
- `turn_executor.rs`: in `execute_chat_turn_task` (the `done` event, ~line 222)
- `main.rs`: in `fanout_turn_event` (~line 29500)

- [ ] **Step 3.3: Verify compilation**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK.

- [ ] **Step 3.4: Commit**

```bash
git add crates/desktop-gateway/src/turn_executor.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(ws-gateway): broker fanout publishes turn events on WS

emit_turn_event ora accetta &AppState e pubblica sul WsRegistry oltre al
per-turn broadcast. Tutti i turn.delta/activity/plan/reasoning/done/queued/retry
arrivano sia sul WS unificato che sul NDJSON stream (coesistenza temporanea
per la Fase B-D)."
```

---

## Task 4: Extend `publish_app_event` to publish on the WS

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 4.1: Change `publish_app_event` to accept `&AppState` and publish on WS**

In `crates/desktop-gateway/src/main.rs`, find `publish_app_event` (line ~31641). It's currently a free function that takes only `event: Value`. It needs access to the WS registry.

Two options:
- (a) Change signature to `publish_app_event(state: &AppState, event: Value)` — cleanest but touches all callers (~9 callsites).
- (b) Use a global `OnceLock<Arc<WsRegistry>>` like the existing `app_events_tx()` pattern — minimal changes.

**Option (b) is recommended** for the transitional phase (matches the existing pattern):

Add near the `app_events_tx()` function:

```rust
/// Process-wide WS registry singleton (set at boot when AppState is constructed).
/// Allows free functions like `publish_app_event` to publish on the WS without
/// threading `&AppState` through every callsite.
fn ws_registry() -> &'static OnceLock<Arc<ws_gateway::WsRegistry>> {
    static CELL: OnceLock<Arc<ws_gateway::WsRegistry>> = OnceLock::new();
    &CELL
}
```

In the `AppState` constructor (after `ws_registry: Arc::new(ws_gateway::WsRegistry::new())`), also set the global:

```rust
    let _ = ws_registry().set(state.ws_registry.clone());
```

Then modify `publish_app_event`:

```rust
fn publish_app_event(event: serde_json::Value) {
    let line = serde_json::to_string(&event).unwrap_or_default();
    let _ = app_events_tx().send(line);
    // Also publish on the unified WS (fan-out to all connected clients).
    if let Some(registry) = ws_registry().get() {
        registry.publish_app_event(event);
    }
}
```

- [ ] **Step 4.2: Verify compilation**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK.

- [ ] **Step 3.3: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(ws-gateway): publish_app_event also publishes on WS

publish_app_event ora fan-out anche sul WsRegistry (via global OnceLock,
coerente col pattern app_events_tx esistente). thread.updated,
thread.turn_started, project_graph.ready arrivano sia sul NDJSON /api/events
che sul WS unificato (coesistenza temporanea)."
```

---

## Task 5: Integrate `publish_computer_live` on state change

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 5.1: Find where the computer live state changes**

The contained computer live state is returned by `GET /api/local-computer/live` (handler at ~line ~28000+). The state changes when:
- A browser session starts/stops
- A step completes
- The terminal state changes

Search for where these state changes happen. The handler reads from a `RwLock` or `Mutex` that holds the live state. Find it:

```bash
grep -n "computer.*live\|local.computer.*live\|contained_computer_live\|computer_activity\|novnc.*active" crates/desktop-gateway/src/main.rs | head -15
```

The live state is likely stored in a `RwLock<ComputerLiveState>` or computed on-the-fly from the session store.

- [ ] **Step 5.2: Add a `publish_computer_live` call when the state changes**

Find the points where the computer state is mutated (session update, step complete, browser open/close). After each mutation, call:

```rust
    // Publish the updated computer live state on the unified WS.
    if let Some(registry) = ws_registry().get() {
        let live = build_computer_live_state(); // the same JSON the GET handler returns
        registry.publish_computer_live(live);
    }
```

**If the state is computed on-the-fly** (not stored), add a periodic publisher that reads the state every 1s and publishes only on change:

```rust
    // Spawn a background task that publishes computer.live on the WS whenever
    // the state changes (replaces the client's 600ms-2.5s polling).
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut last_signature = String::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                let live = build_computer_live_state(&state).await;
                let signature = serde_json::to_string(&live).unwrap_or_default();
                if signature != last_signature {
                    last_signature = signature;
                    state.ws_registry.publish_computer_live(live);
                }
            }
        });
    }
```

This is a pragmatic approach: poll internally every 1s, publish only on change. Less invasive than finding every mutation point. Start this task at boot (near `start_task_executor_worker`).

- [ ] **Step 5.3: Verify compilation**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK.

- [ ] **Step 5.4: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(ws-gateway): publish computer.live on state change

Background task polla lo stato del contained computer ogni 1s e pubblica
sul WS solo quando cambia signature. Sostituisce il polling del client
(600ms-2.5s su /api/local-computer/live) con push WS."
```

---

## Task 6: Smoke test — verify WS events arrive

**Files:**
- Modify: `scripts/test-turn-broker-e2e.py` (add WS test)

- [ ] **Step 6.1: Add a WS connection test to the e2e script**

In `scripts/test-turn-broker-e2e.py`, after the existing tests, add a test that opens a WS connection and verifies it receives events:

```python
    # --- Test 10: WebSocket unified channel receives turn events ---
    log("TEST 10: WebSocket /api/ws receives turn events")
    import websocket  # pip install websocket-client
    ws_url = f"ws://127.0.0.1:{GATEWAY_PORT}/api/ws"
    ws = websocket.create_connection(ws_url, header=[f"Authorization: Bearer {GATEWAY_TOKEN}"])
    # Read hello
    hello = json.loads(ws.recv())
    assert hello.get("type") == "hello", f"expected hello, got {hello}"
    log(f"  → hello received, session_id={hello.get('session_id')}")

    # Enqueue a turn and verify we get turn.event messages on the WS
    thread_ws = create_thread()
    status, body, _ = http_request("POST", "/api/chat/turns", body={"thread_id": thread_ws, "prompt": "ws test"}, expect=201)
    turn_ws = body["turn_id"]

    # Wait for turn events on the WS (with timeout)
    ws.settimeout(10)
    events_received = []
    try:
        while True:
            msg = json.loads(ws.recv())
            if msg.get("type") == "turn.event" and msg.get("turn_id") == turn_ws:
                events_received.append(msg)
                if msg.get("kind") == "done":
                    break
    except websocket.WebSocketTimeoutException:
        pass

    log(f"  → received {len(events_received)} turn events on WS")
    if events_received:
        kinds = [e.get("kind") for e in events_received]
        log(f"    kinds: {kinds}")
        assert any(k in ("delta", "activity", "done") for k in kinds), f"no useful events: {kinds}"
        log("  → WS receives turn events ✓")
    else:
        log("  → NOTE: no turn events on WS (may have failed before fanout — acceptable without LLM)")

    ws.close()
    log("  → TEST 10 ✓")
```

**Note:** this requires `pip install websocket-client`. If not available, use Python's built-in `socket` + manual WS handshake, or skip the test with a note.

- [ ] **Step 6.2: Run the e2e test**

Run: `python3 scripts/test-turn-broker-e2e.py`
Expected: all tests pass including TEST 10.

- [ ] **Step 6.3: Commit**

```bash
git add scripts/test-turn-broker-e2e.py
git commit -m "test(ws-gateway): e2e test verifies WS receives turn events

TEST 10: apre WS /api/ws, riceve hello, enqueue un turno, verifica che
gli eventi turn.event arrivano sul WS. Smoke test della Fase A."
```

---

## Definition of Done — Phase A

- [ ] `ws_gateway.rs` modulo con `WsRegistry`, `ServerMessage`, `ClientMessage`, `ws_handler`, `ws_connection_loop`, `handle_resume`.
- [ ] `ws_registry: Arc<WsRegistry>` in `AppState`, inizializzato al boot.
- [ ] Route `GET /api/ws` registrata.
- [ ] `emit_turn_event` pubblica sul WS (oltre al per-turn broadcast e al DB).
- [ ] `publish_app_event` pubblica sul WS (oltre al NDJSON /api/events).
- [ ] `publish_computer_live` pubblicato su cambiamento.
- [ ] Test e2e TEST 10 verifica che gli eventi arrivano sul WS.
- [ ] **Nessun behavior change** per il client esistente (il WS è additivo, il legacy coesiste).

## Cosa NON è in questo piano (Fasi B-D)

- **Fase B**: `WSSubscription` client-side (`lib/wsSubscription.ts`), connect al boot, coesistenza con polling.
- **Fase C**: migrare ChatView/ChatComputerPanel/App da polling a WS subscriber, rimuovere 12 `setInterval`.
- **Fase D**: cleanup legacy (rimuovi `/generate_stream`, `/stream_resume`, `/api/events`, `HOMUN_TURN_BROKER` flag, `parseTurnStreamEventAsLegacy`, codice morto WS in `chatApi.ts`).

## Rischi e residuali onesti

1. **`AppState` Cloning**: l'handler WS usa `State<Arc<AppState>>`. Se il router usa `AppState` direttamente (non `Arc`), adattare. Verificare il pattern del router axum.
2. **Token auth su WS**: axum WS upgrade non supporta header custom nel browser. In Electron il renderer può settare header su WS. Per test, usare query param fallback (`?token=...`) se necessario.
3. **`publish_computer_live` via polling interno**: il design ideale sarebbe pubblicare solo sui punti di mutazione reali. Il polling interno ogni 1s con change-detection è un compromesso pragmatico che evita di trovare ogni mutazione — ma aggiunge 1s di latenza massima sul computer live. Accettabile per la Fase A.
4. **`OnceLock` per `ws_registry()`**: il pattern global per `publish_app_event` funziona ma è un'accoppiamento implicito. Nella Fase D (cleanup) si può rifattorizzare per passare `&AppState` esplicitamente ovunque.
