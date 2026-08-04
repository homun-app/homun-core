//! Process-wide gateway event and registry owner.
//!
//! Owns the in-process `/api/events` broadcast, the global WebSocket registry
//! handle used by free-function publishers, and the global usage recorder handle
//! used by provider instrumentation outside request state.

use super::*;

#[test]
fn gateway_process_events_owner_smoke() {
    let before = app_events_tx().receiver_count();
    let _rx = app_events_tx().subscribe();
    assert_eq!(app_events_tx().receiver_count(), before + 1);
    let _ = global_usage_recorder();
}

/// Global fan-out for UI events (thread.upserted, thread.updated, …). One
/// process-wide broadcast; every connected /api/events client subscribes to it.
pub(crate) fn app_events_tx() -> &'static tokio::sync::broadcast::Sender<String> {
    static CELL: std::sync::OnceLock<tokio::sync::broadcast::Sender<String>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| tokio::sync::broadcast::channel::<String>(256).0)
}

/// Process-wide WS registry singleton (set at boot when `AppState` is constructed).
/// Allows free functions like `publish_app_event` to publish on the unified WS
/// without threading `&AppState` through every callsite. Clones the `Arc`, not
/// the registry, so all publishers share one subscriber map.
pub(crate) fn ws_registry() -> &'static std::sync::OnceLock<std::sync::Arc<ws_gateway::WsRegistry>>
{
    static CELL: std::sync::OnceLock<std::sync::Arc<ws_gateway::WsRegistry>> =
        std::sync::OnceLock::new();
    &CELL
}

pub(crate) fn usage_recorder_registry()
-> &'static std::sync::OnceLock<std::sync::Arc<dyn local_first_inference_usage::UsageRecorder>> {
    static CELL: std::sync::OnceLock<
        std::sync::Arc<dyn local_first_inference_usage::UsageRecorder>,
    > = std::sync::OnceLock::new();
    &CELL
}

pub(crate) fn global_usage_recorder()
-> std::sync::Arc<dyn local_first_inference_usage::UsageRecorder> {
    usage_recorder_registry()
        .get()
        .cloned()
        .unwrap_or_else(|| std::sync::Arc::new(local_first_inference_usage::NoopUsageRecorder))
}

/// Publish a UI event (JSON) to all connected /api/events listeners AND to all
/// unified-WS clients. Best-effort: silently dropped if there are no subscribers.
pub(crate) fn publish_app_event(event: serde_json::Value) {
    let line = serde_json::to_string(&event).unwrap_or_default();
    let _ = app_events_tx().send(line);
    // Also publish on the unified WS (fan-out to all connected clients).
    if let Some(registry) = ws_registry().get() {
        registry.publish_app_event(event);
    }
}

/// GET /api/events — long-lived NDJSON stream of UI events so the desktop app
/// updates in real time. E.g. an inbound Telegram/WhatsApp message creates a
/// chat thread and the app jumps to it without a manual refresh. Fire-and-forget
/// (no replay buffer): clients react to events as they arrive.
pub(crate) async fn app_events() -> Response {
    let mut rx = app_events_tx().subscribe();
    let (tx, mpsc_rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(64);
    // Greet immediately so the client knows the stream is live.
    let _ = tx.try_send(Ok(Bytes::from("{\"type\":\"hello\"}\n")));
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(line) => {
                    if tx.send(Ok(Bytes::from(format!("{line}\n")))).await.is_err() {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });
    let body = Body::from_stream(futures_util::stream::unfold(mpsc_rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    }));
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .header("cache-control", "no-cache")
        .body(body)
        .expect("valid streaming response")
}
