//! Live chat stream registry and transport owner.
//!
//! Owns the server-side stream buffer, broadcast fan-out, reattach endpoint,
//! abort registry, and legacy marker expansion for NDJSON stream events. The
//! broker and durable turn persistence remain outside this module.

use super::*;
use local_first_desktop_gateway::markers::{
    body as legacy_marker_body, json_body as legacy_marker_json,
};

#[test]
fn chat_streams_owner_smoke() {
    assert!(stream_event_is_terminal(r#"{"type":"done"}"#));
    assert!(stream_event_is_terminal(r#"{"type":"error"}"#));
    assert!(!stream_event_is_terminal(r#"{"type":"delta","text":"x"}"#));
    assert_eq!(
        agent_turn_stream_request_id("assistant-1"),
        "agentturn-assistant-1"
    );
    assert_eq!(broker_turn_stream_request_id("turn-1"), "broker-turn-1");
    let _streaming_client = chat_streaming_http_client(&reqwest::Client::new());
}

/// A live chat stream, kept in a server-side registry so a client that reloads
/// mid-answer can REATTACH (replay the buffered events + continue live) instead
/// of losing the in-flight response. The generation writes here regardless of
/// whether any HTTP client is currently attached.
pub(crate) struct StreamEntry {
    /// NDJSON lines emitted so far (replayed to a late/reattaching reader).
    pub(crate) lines: std::sync::Mutex<Vec<String>>,
    /// Live fan-out to currently-attached readers.
    pub(crate) tx: tokio::sync::broadcast::Sender<String>,
    pub(crate) finished: std::sync::atomic::AtomicBool,
    /// Last event emitted to this stream. Used only to suppress stale sidebar
    /// activity when a generation loses its terminal event.
    pub(crate) last_event_at: std::sync::atomic::AtomicU64,
    /// The chat thread this generation belongs to, so the sidebar can show the
    /// "working" dots on EVERY thread with an in-flight answer (not just the one
    /// currently on screen). `None` for a first-message thread without an id yet.
    pub(crate) thread_id: Option<String>,
    /// The assistant bubble this stream is being drained into. The engine outcome
    /// arrives outside the drain, so this records the durable message id once known.
    pub(crate) assistant_message_id: std::sync::Mutex<Option<String>>,
    /// Typed engine stop for broker-owned turns. Transport consumers wait on
    /// this value instead of interpreting an empty terminal stream event.
    pub(crate) outcome: std::sync::Mutex<Option<local_first_engine::TurnOutcome>>,
    pub(crate) outcome_ready: tokio::sync::Notify,
}

pub(crate) fn publish_stream_outcome(
    entry: &StreamEntry,
    outcome: local_first_engine::TurnOutcome,
) {
    if let Ok(mut slot) = entry.outcome.lock() {
        *slot = Some(outcome);
    }
    entry.outcome_ready.notify_waiters();
}

pub(crate) async fn wait_for_stream_outcome(
    entry: std::sync::Arc<StreamEntry>,
) -> local_first_engine::TurnOutcome {
    loop {
        let notified = entry.outcome_ready.notified();
        if let Some(outcome) = entry.outcome.lock().ok().and_then(|slot| slot.clone()) {
            return outcome;
        }
        notified.await;
    }
}

/// Sink the generation emits to: tees every event to the ORIGINAL live response
/// (mpsc, unchanged behaviour) AND to the resume registry (buffer + broadcast).
pub(crate) struct StreamSink {
    pub(crate) mpsc: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
    pub(crate) entry: std::sync::Arc<StreamEntry>,
}

pub(crate) struct ChatStreamTransport {
    pub(crate) sink: StreamSink,
    pub(crate) receiver: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>,
    pub(crate) resume_id: String,
}

pub(crate) fn open_chat_stream_transport(
    request_id: String,
    thread_id: Option<String>,
) -> ChatStreamTransport {
    let (mpsc_tx, receiver) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    let (broadcast_tx, _) = tokio::sync::broadcast::channel::<String>(512);
    let stream_entry = std::sync::Arc::new(StreamEntry {
        lines: std::sync::Mutex::new(Vec::new()),
        tx: broadcast_tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(now_epoch_secs()),
        thread_id,
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    });
    if let Ok(mut map) = stream_registry().lock() {
        map.insert(request_id.clone(), stream_entry.clone());
    }
    ChatStreamTransport {
        sink: StreamSink {
            mpsc: mpsc_tx,
            entry: stream_entry,
        },
        receiver,
        resume_id: request_id,
    }
}

fn chat_stream_body(receiver: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>) -> Body {
    Body::from_stream(futures_util::stream::unfold(
        receiver,
        |mut receiver| async move { receiver.recv().await.map(|item| (item, receiver)) },
    ))
}

pub(crate) fn chat_streaming_http_client(default: &reqwest::Client) -> reqwest::Client {
    // Streaming responses are sensitive to stale pooled connections and CDN HTTP/2 resets.
    // Keep this transport policy beside the stream owner, with shared-client fallback.
    reqwest::Client::builder()
        .http1_only()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap_or_else(|_| default.clone())
}

pub(crate) fn chat_stream_response(
    receiver: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>,
) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .body(chat_stream_body(receiver))
        .expect("valid streaming response")
}

pub(crate) fn chat_stream_response_with_effective_model(
    receiver: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>,
    effective_model: impl AsRef<str>,
) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .header("x-effective-model", effective_model.as_ref())
        .body(chat_stream_body(receiver))
        .expect("valid streaming response")
}

// The engine's output seam (ADR 0024 inc 5b): the future loop-in-the-engine emits every stream
// event through `EventSink`; the gateway fans it onto the transport here (NDJSON body + WS mirror).
impl local_first_engine::EventSink for StreamSink {
    async fn emit(&self, event: GenerateStreamEvent) {
        let _ = emit_stream_event(self, event).await;
    }
}

pub(crate) fn stream_registry()
-> &'static std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<StreamEntry>>> {
    static CELL: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<StreamEntry>>>,
    > = std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub(crate) fn stream_abort_registry()
-> &'static std::sync::Mutex<std::collections::HashMap<String, tokio::task::AbortHandle>> {
    static CELL: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, tokio::task::AbortHandle>>,
    > = std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub(crate) fn abort_stream_generation(resume_id: &str) {
    let abort = stream_abort_registry()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(resume_id));
    if let Some(abort) = abort {
        abort.abort();
    }
    if let Ok(mut map) = stream_registry().lock() {
        map.remove(resume_id);
    }
}

pub(crate) fn agent_turn_stream_request_id(assistant_message_id: &str) -> String {
    format!("agentturn-{assistant_message_id}")
}

pub(crate) fn broker_turn_stream_request_id(turn_id: &str) -> String {
    format!("broker-{turn_id}")
}

fn stream_event_is_terminal(line: &str) -> bool {
    line.contains("\"type\":\"done\"") || line.contains("\"type\":\"error\"")
}

pub(crate) fn expand_legacy_delta_to_chat_events_with_mode(
    text: &str,
    include_legacy_delta: bool,
) -> Vec<GenerateStreamEvent> {
    let mut events = Vec::new();
    if let Some(body) = legacy_marker_body(text, "‹‹ACT››", "‹‹/ACT››") {
        events.push(GenerateStreamEvent::Activity {
            text: body.to_string(),
        });
    } else if let Some(body) = legacy_marker_body(text, "‹‹PLAN››", "‹‹/PLAN››") {
        events.push(GenerateStreamEvent::PlanUpdate {
            markdown: body.to_string(),
        });
    } else if let Some(body) = legacy_marker_body(text, "‹‹REASONING››", "‹‹/REASONING››")
    {
        events.push(GenerateStreamEvent::Reasoning {
            text: body.to_string(),
        });
    } else if let Some(payload) = legacy_marker_json(text, "‹‹CHOICES››", "‹‹/CHOICES››")
    {
        events.push(GenerateStreamEvent::ChoicePrompt { payload });
    } else if let Some(payload) =
        legacy_marker_json(text, "‹‹VAULT_PROPOSE››", "‹‹/VAULT_PROPOSE››")
    {
        events.push(GenerateStreamEvent::VaultPropose { payload });
    } else if let Some(payload) = legacy_marker_json(text, "‹‹VAULT_REVEAL››", "‹‹/VAULT_REVEAL››")
    {
        events.push(GenerateStreamEvent::VaultReveal { payload });
    } else if let Some(payload) =
        legacy_marker_json(text, "‹‹PAYMENT_APPROVAL››", "‹‹/PAYMENT_APPROVAL››")
    {
        events.push(GenerateStreamEvent::PaymentApproval { payload });
    } else if let Some(payload) = legacy_marker_json(text, "‹‹DIFF››", "‹‹/DIFF››")
    {
        // Piano UI D3: marker diff → evento strutturato Diff.
        if let Ok(diff) =
            serde_json::from_value::<local_first_subagents::DiffStreamPayload>(payload)
        {
            events.push(GenerateStreamEvent::Diff { payload: diff });
        }
    }
    if !events.is_empty() && !include_legacy_delta {
        return events;
    }
    events.push(GenerateStreamEvent::Delta {
        text: text.to_string(),
    });
    events
}

fn stream_legacy_marker_deltas_enabled() -> bool {
    std::env::var("HOMUN_STREAM_LEGACY_MARKER_DELTAS")
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "on"
            )
        })
        .unwrap_or(false)
}

pub(crate) fn stream_entry_has_terminal_event(entry: &StreamEntry) -> bool {
    entry
        .lines
        .lock()
        .map(|lines| lines.iter().any(|line| stream_event_is_terminal(line)))
        .unwrap_or(false)
}

pub(crate) fn schedule_stream_registry_cleanup(resume_id: String) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        if let Ok(mut map) = stream_registry().lock() {
            map.remove(&resume_id);
        }
        if let Ok(mut map) = stream_abort_registry().lock() {
            map.remove(&resume_id);
        }
    });
}

pub(crate) const STREAM_ACTIVITY_IDLE_STALE_SECS: u64 = 180;
pub(crate) const STREAM_SILENT_IDLE_STALE_SECS: u64 = 30;

pub(crate) fn stream_entry_is_activity_stale(entry: &StreamEntry, now: u64) -> bool {
    let last = entry
        .last_event_at
        .load(std::sync::atomic::Ordering::Relaxed);
    if last == 0 {
        return false;
    }
    let has_events = entry
        .lines
        .lock()
        .map(|lines| !lines.is_empty())
        .unwrap_or(false);
    let stale_after = if has_events {
        STREAM_ACTIVITY_IDLE_STALE_SECS
    } else {
        STREAM_SILENT_IDLE_STALE_SECS
    };
    now.saturating_sub(last) > stale_after
}

/// Thread ids that currently have a live (not-yet-finished) in-flight generation.
/// Lets the sidebar show the "working" dots on EVERY busy thread, including chats
/// generating in the background while another is on screen. Finished entries are
/// evicted by their own grace-window logic, but entries that already buffered a
/// terminal event are marked finished here so the UI cannot show phantom work.
pub(crate) fn active_stream_thread_ids() -> Vec<String> {
    let Ok(mut map) = stream_registry().lock() else {
        return Vec::new();
    };
    let now = now_epoch_secs();
    map.retain(|_, entry| {
        if entry.finished.load(std::sync::atomic::Ordering::Relaxed) {
            return true;
        }
        if stream_entry_has_terminal_event(entry) || stream_entry_is_activity_stale(entry, now) {
            entry
                .finished
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        true
    });
    let mut ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in map.values() {
        if entry.finished.load(std::sync::atomic::Ordering::Relaxed) {
            continue;
        }
        if let Some(tid) = &entry.thread_id {
            ids.insert(tid.clone());
        }
    }
    ids.into_iter().collect()
}

/// GET /api/chat/active_streams — thread ids with an in-flight chat answer right now.
pub(crate) async fn active_streams() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "thread_ids": active_stream_thread_ids() }))
}

/// Builds an NDJSON response body for a reattaching reader: replays the buffered
/// events, then forwards live ones until a terminal (done/error) event.
fn ndjson_body_for_entry(entry: std::sync::Arc<StreamEntry>) -> Body {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(64);
    tokio::spawn(async move {
        // Snapshot + subscribe under the same lock so no event is missed/duplicated.
        let (snapshot, mut brx) = {
            let buf = entry.lines.lock().expect("stream lines lock");
            (buf.clone(), entry.tx.subscribe())
        };
        for line in &snapshot {
            if tx.send(Ok(Bytes::from(format!("{line}\n")))).await.is_err() {
                return;
            }
            if stream_event_is_terminal(line) {
                return;
            }
        }
        loop {
            match brx.recv().await {
                Ok(line) => {
                    let terminal = stream_event_is_terminal(&line);
                    if tx.send(Ok(Bytes::from(format!("{line}\n")))).await.is_err() {
                        return;
                    }
                    if terminal {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });
    Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    }))
}

/// Reattach to an in-flight (or just-finished) chat stream by request id.
pub(crate) async fn resume_stream(
    Path(request_id): Path<String>,
) -> Result<Response, GatewayError> {
    let entry = stream_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&request_id).cloned());
    match entry {
        Some(entry) => Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/x-ndjson")
            .body(ndjson_body_for_entry(entry))
            .expect("valid streaming response")),
        None => Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "stream_not_found",
            message: "No active stream for this request.".to_string(),
        }),
    }
}

async fn emit_single_stream_event(sink: &StreamSink, event: GenerateStreamEvent) -> Result<(), ()> {
    let line = serde_json::to_string(&event).map_err(|_| ())?;
    let terminal = stream_event_is_terminal(&line);
    sink.entry
        .last_event_at
        .store(now_epoch_secs(), std::sync::atomic::Ordering::Relaxed);
    if terminal {
        sink.entry
            .finished
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    // Tee to the resume registry (buffer + broadcast) under one lock so a
    // reattaching reader never misses or duplicates an event.
    if let Ok(mut buf) = sink.entry.lines.lock() {
        buf.push(line.clone());
        let _ = sink.entry.tx.send(line.clone());
    }
    // Original live response; ignored if the client already disconnected (the
    // generation keeps running and recording into the registry).
    let _ = sink.mpsc.send(Ok(Bytes::from(format!("{line}\n")))).await;
    Ok(())
}

pub(crate) async fn emit_stream_event(
    sink: &StreamSink,
    event: GenerateStreamEvent,
) -> Result<(), ()> {
    match event {
        GenerateStreamEvent::Delta { text } => {
            for expanded in expand_legacy_delta_to_chat_events_with_mode(
                &text,
                stream_legacy_marker_deltas_enabled(),
            ) {
                emit_single_stream_event(sink, expanded).await?;
            }
            Ok(())
        }
        other => emit_single_stream_event(sink, other).await,
    }
}
