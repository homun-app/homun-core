//! Unified WebSocket gateway: a single persistent `/api/ws` endpoint that fans out
//! all server→client events (turn.*, computer.live, thread.*, task.*) to connected
//! subscribers. Replaces the fragmented NDJSON-per-turn + NDJSON-events + polling
//! channels with one bidirectional JSON-over-WS connection.

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::AppState;

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
    #[serde(rename = "app.event")]
    AppEvent { event: Value },
    /// Acknowledges a resume request: events from_seq..=to_seq will follow.
    #[serde(rename = "resume.ack")]
    ResumeAck { turn_id: String, from_seq: i64, to_seq: i64 },
    /// The resumed turn has already terminated; no more live events will come.
    #[serde(rename = "resume.done")]
    ResumeDone {
        turn_id: String,
        status: String,
        last_seq: i64,
    },
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

    /// Register a new subscriber. Returns the session_id and the receiver end of the channel.
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

impl Default for WsRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Axum handler for `GET /api/ws`. Upgrades to a WebSocket and runs the connection loop.
pub async fn ws_handler(
    ws: axum::extract::WebSocketUpgrade,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl axum::response::IntoResponse {
    ws.on_upgrade(move |socket| ws_connection_loop(socket, state))
}

/// The main connection loop for a single WS client. Registers the subscriber,
/// spawns a sender task, and processes incoming messages (resume, pong).
async fn ws_connection_loop(socket: axum::extract::ws::WebSocket, state: AppState) {
    let subscriber_count_before = state.ws_registry.subscriber_count();
    tracing::info!(
        target: "ws::gateway",
        subscribers_before = subscriber_count_before,
        "WS client connected"
    );
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (session_id, mut msg_rx) = state.ws_registry.register();

    // Send hello
    let hello = ServerMessage::Hello {
        session_id: session_id.clone(),
    };
    let hello_json = serde_json::to_string(&hello).unwrap_or_default();
    let _ = ws_tx
        .send(axum::extract::ws::Message::Text(hello_json.into()))
        .await;

    // Spawn the sender task: forwards registry messages → WS client
    let state_for_send = state.clone();
    let session_id_for_send = session_id.clone();
    let send_task = tokio::spawn(async move {
        while let Some(msg) = msg_rx.recv().await {
            let json = serde_json::to_string(&msg).unwrap_or_default();
            if ws_tx
                .send(axum::extract::ws::Message::Text(json.into()))
                .await
                .is_err()
            {
                break;
            }
        }
        state_for_send.ws_registry.unregister(&session_id_for_send);
    });

    // Receive loop: process client messages (resume, pong, close)
    while let Some(msg_result) = ws_rx.next().await {
        match msg_result {
            Ok(axum::extract::ws::Message::Text(text)) => {
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
            Ok(axum::extract::ws::Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    // Cleanup
    state.ws_registry.unregister(&session_id);
    send_task.abort();
    tracing::info!(
        target: "ws::gateway",
        subscribers_after = state.ws_registry.subscriber_count(),
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
                tracing::warn!(
                    target: "ws::gateway",
                    turn_id = %turn_id,
                    error = %e,
                    "resume: failed to read turn_events"
                );
                return;
            }
        }
    };

    if events.is_empty() {
        let status = get_turn_status(state, turn_id);
        broadcast_resume_done(state, turn_id, status, since);
        return;
    }

    let from_seq = events.first().unwrap().seq;
    let to_seq = events.last().unwrap().seq;

    state.ws_registry.broadcast(ServerMessage::ResumeAck {
        turn_id: turn_id.to_string(),
        from_seq,
        to_seq,
    });

    for event in events {
        state.ws_registry.publish_turn_event(
            turn_id,
            None,
            event.seq,
            event.kind.as_str(),
            event.payload,
        );
    }

    let status = get_turn_status(state, turn_id);
    if let Some(ref s) = status {
        if is_terminal_status(s) {
            broadcast_resume_done(state, turn_id, status.clone(), to_seq);
        }
    }
}

fn get_turn_status(state: &AppState, turn_id: &str) -> Option<String> {
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
