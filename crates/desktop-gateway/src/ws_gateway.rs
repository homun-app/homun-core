//! Unified WebSocket gateway: a single persistent `/api/ws` endpoint that fans out
//! all server→client events (turn.*, computer.live, thread.*, task.*) to connected
//! subscribers. Replaces the fragmented NDJSON-per-turn + NDJSON-events + polling
//! channels with one bidirectional JSON-over-WS connection.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
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
