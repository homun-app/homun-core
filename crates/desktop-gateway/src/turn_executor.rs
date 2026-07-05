//! Turn executor: runs a `chat_turn` task and fans out its stream events to
//! `turn_events` (durable, for resume) + a per-turn broadcast channel (live).
//! Sibling of `execute_proactive_prompt_task`, generalized for the broker.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use local_first_task_runtime::{
    broker::CancelNotify, TaskRuntimeResult, TaskStore, TurnEventKind,
};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Notify};

/// A live subscriber fan-out for a single turn_id. Created when the turn starts running,
/// dropped when it terminates. Mirrors the StreamEntry pattern but keyed by turn_id
/// and broker-owned.
pub struct TurnBroadcast {
    pub tx: broadcast::Sender<TurnEvent>,
    pub cancel: Arc<Notify>,
}

/// One unit of the turn stream, sent over the broadcast channel.
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
                kind: event.kind.as_str().to_string(),
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
        let wait = std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    cancel.notified(),
                )
                .await;
            });
        });
        GatewayCancelNotify.notify_cancel("turn_test_cancel");
        wait.join().unwrap();
        unregister_turn("turn_test_cancel");
    }
}
