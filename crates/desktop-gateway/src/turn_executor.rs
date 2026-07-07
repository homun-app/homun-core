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
///
/// Publishes on THREE sinks:
/// 1. `turn_events` table (durable, for stream resume after reconnect).
/// 2. The per-turn broadcast channel (legacy NDJSON `/api/chat/turns/{id}/events`
///    stream — transitional, kept until the unified WS is the only client).
/// 3. The unified `WsRegistry` (fan-out to all connected WS clients).
pub fn emit_turn_event(
    state: &crate::AppState,
    store: &TaskStore,
    turn_id: &str,
    kind: TurnEventKind,
    payload: Value,
) -> TaskRuntimeResult<()> {
    let event = store.insert_turn_event(turn_id, kind, payload.clone())?;
    // Best-effort live broadcast on the per-turn channel (NDJSON stream — transitional).
    // No receivers is fine (broadcast::send errors are benign).
    if let Ok(map) = turn_broadcast_registry().lock() {
        if let Some(broadcast) = map.get(turn_id) {
            let _ = broadcast.tx.send(TurnEvent {
                seq: event.seq,
                kind: event.kind.as_str().to_string(),
                payload: payload.clone(),
            });
        }
    }
    // Publish on the unified WS (fan-out to all connected clients).
    state.ws_registry.publish_turn_event(
        turn_id,
        None,
        event.seq,
        event.kind.as_str(),
        event.payload.clone(),
    );
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

/// Executor for a `chat_turn` task. Sibling of `execute_proactive_prompt_task`
/// (in `main.rs`): reads `thread_id`/`prompt`/`approval`/`workspace_id` from
/// `task.input_json` (where `broker::enqueue_chat_turn` put them), opens a
/// visible turn, drives the agent-loop to completion, finalizes the assistant
/// message, emits a `done` turn event, and returns the outcome.
///
/// The agent-loop is async but this executor runs inside `spawn_blocking`, so
/// blocking on the current runtime handle does not stall the async workers —
/// the same pattern `execute_proactive_prompt_task` uses.
pub fn execute_chat_turn_task(
    state: &crate::AppState,
    task: &local_first_task_runtime::TaskRecord,
) -> Result<crate::TaskExecutionOutcome, crate::LocalTaskExecutionError> {
    let turn_id = task.task_id.as_str();
    tracing::info!(target: "broker::executor", turn_id = %turn_id, "executor started");

    // 1. Required inputs (set by `broker::enqueue_chat_turn`).
    let thread_id = task
        .input_json
        .get("thread_id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| crate::LocalTaskExecutionError {
            message: "chat_turn task missing thread_id".to_string(),
        })?;
    let prompt = task
        .input_json
        .get("prompt")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| crate::LocalTaskExecutionError {
            message: "chat_turn task missing prompt".to_string(),
        })?;
    // Optional inputs with defaults.
    let approval = task
        .input_json
        .get("approval")
        .and_then(|v| v.as_str())
        .unwrap_or("full");
    let workspace_id = task
        .input_json
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| task.workspace_id.as_str())
        .to_string();

    // 2. Map `approval` → agent tool_policy. Unknown values fall back to the
    //    most capable policy (`full`) — matches the interactive default.
    let tool_policy = match approval {
        "confirm" => "confirm",
        "autonomous" => "autonomous",
        "read_only" => "read_only",
        _ => "full",
    };

    // 3. Register the live turn broadcast (Task 1a.2). Cancellation + the
    //    per-turn SSE/WS fan-out key off this. Always unregistered on exit.
    let broadcast = register_turn(turn_id);

    // 4. Open the visible turn: persists user + assistant placeholder messages
    //    and emits `thread.turn_started`. Fail closed if it cannot be persisted
    //    — never run invisible background model/tool work for an interactive
    //    request the user is waiting on.
    let visible_turn = crate::start_visible_conversation_turn(
        state,
        thread_id,
        &workspace_id,
        "interactive",
        None,
        prompt,
        prompt,
    )
    .ok_or_else(|| crate::LocalTaskExecutionError {
        message: "could not start a visible conversation turn".to_string(),
    })?;

    // 5. Drive the agent-loop to completion. The real fan-out (Task 1a.4) will
    //    mirror each stream event into turn_events + the broadcast; the stub
    //    just delegates to the existing drainer.
    tracing::info!(target: "broker::executor", turn_id = %turn_id, thread_id = %thread_id, "agent-loop starting");
    let drain_started = std::time::Instant::now();
    // Race the turn against its cancel signal (fired by `cancel_chat_turn` →
    // `GatewayCancelNotify`). Dropping the turn future on cancel aborts the in-flight
    // model/tool work; on cancel we SKIP the Completed finalize below so the `Cancelled`
    // status `cancel_chat_turn` already persisted survives (the runner also guards against
    // resurrecting an externally-cancelled task). Without this select the `notify_one()` had
    // no waiter in production and the turn always ran to completion, overwriting `Cancelled`.
    let cancel = broadcast.cancel.clone();
    let run = tokio::runtime::Handle::current().block_on(async {
        tokio::select! {
            biased;
            _ = cancel.notified() => None,
            answer = crate::run_agent_turn_into_message_with_fanout(
                state,
                thread_id,
                prompt,
                tool_policy,
                &visible_turn.user_message_id,
                &visible_turn.assistant_message_id,
                turn_id,
            ) => Some(answer),
        }
    });
    let cancelled = run.is_none();
    let answer = run
        .flatten()
        .unwrap_or_else(|| "No reply generated.".to_string());
    tracing::info!(
        target: "broker::executor",
        turn_id = %turn_id,
        elapsed_ms = drain_started.elapsed().as_millis() as u64,
        answer_len = answer.len(),
        "agent-loop completed — persisting assistant message"
    );

    // 6+7. Finalize — ONLY when the turn ran to completion. On cancel we skip both the
    // assistant-message finalize and the `done` event: `cancel_chat_turn` already persisted
    // the `Cancelled` status and emitted the `Cancelled` turn event, so writing a `done`/full
    // answer here would resurrect a cancelled turn.
    if !cancelled {
        // 6. Finalize the assistant message. The legacy path persists the full
        // streamed text (which includes ‹‹ACT›› activity markers as inline deltas),
        // so the working island can parse them out of `message.text`. The broker
        // separates activity into its own event kind, so to keep the island working
        // we re-prefix the activity markers (collected from the turn_events emitted
        // during the drain) ahead of the clean answer text.
        let activity_prefix = build_activity_prefix_from_turn_events(state, turn_id);
        let full_text = if activity_prefix.is_empty() {
            answer.clone()
        } else {
            format!("{activity_prefix}\n{answer}")
        };
        crate::update_channel_assistant_message(
            state,
            thread_id,
            &visible_turn.assistant_message_id,
            &full_text,
        );

        // 7. Emit the terminal `done` turn event (durable + best-effort live).
        tracing::info!(target: "broker::executor", turn_id = %turn_id, "emitting done event");
        if let Ok(store) = state.task_store.lock() {
            let _ = emit_turn_event(
                state,
                &store,
                turn_id,
                local_first_task_runtime::TurnEventKind::Done,
                serde_json::json!({
                    "assistant_message_id": visible_turn.assistant_message_id,
                    "user_message_id": visible_turn.user_message_id,
                }),
            );
        }
    } else {
        tracing::info!(target: "broker::executor", turn_id = %turn_id, "turn cancelled mid-flight — skipping finalize + done event");
    }

    // 8. Drop the live broadcast (subscribers see the channel close).
    unregister_turn(turn_id);

    // 9. Build the outcome — same shape as `execute_proactive_prompt_task`. A cancelled
    // turn is never "completed"; the runner sees completed=false + the store's Cancelled
    // status and closes out without overwriting it.
    let completed = !cancelled
        && !answer.trim().is_empty()
        && answer.trim() != "No reply generated.";
    tracing::info!(
        target: "broker::executor",
        turn_id = %turn_id,
        completed,
        "executor finished — assistant message persisted, broadcast closed"
    );
    Ok(crate::TaskExecutionOutcome {
        completed,
        blocked_reason: if completed {
            None
        } else {
            Some("chat turn produced no final reply".to_string())
        },
        pending_approval: None,
        summary: if completed {
            "Chat turn executed.".to_string()
        } else {
            "Chat turn produced no reply.".to_string()
        },
        checkpoint_payload: serde_json::json!({
            "kind": "chat_turn",
            "thread_id": thread_id,
            "assistant_message_id": visible_turn.assistant_message_id,
            "user_message_id": visible_turn.user_message_id,
            "completed": completed,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "chat_turn",
            "completed": completed,
        }),
        chat_message: answer.clone(),
        surface: crate::SurfaceKind::Logs,
        event_kind: if completed {
            "chat_turn_completed".to_string()
        } else {
            "chat_turn_incomplete".to_string()
        },
        event_title: if completed {
            "Chat turn completed".to_string()
        } else {
            "Chat turn incomplete".to_string()
        },
        event_subtitle: if completed {
            "Interactive chat turn.".to_string()
        } else {
            "Chat turn stopped before producing a reply.".to_string()
        },
        event_payload: serde_json::json!({
            "thread_id": thread_id,
            "assistant_message_id": visible_turn.assistant_message_id,
        }),
        artifacts: vec![],
    })
}

/// Reconstruct the `‹‹ACT››…‹‹/ACT››` activity prefix the working island parses
/// out of `message.text`. The broker separates activity into its own
/// `TurnEventKind::Activity` events during the drain; this reads them back from
/// the durable `turn_events` table and re-wraps each label as the inline marker
/// the legacy client UI expects. Returns "" if there were no activity events.
fn build_activity_prefix_from_turn_events(state: &crate::AppState, turn_id: &str) -> String {
    let Ok(store) = state.task_store.lock() else {
        return String::new();
    };
    let Ok(events) = store.read_turn_events(turn_id, 0) else {
        return String::new();
    };
    let mut labels: Vec<String> = Vec::new();
    for event in events {
        if event.kind == local_first_task_runtime::TurnEventKind::Activity {
            if let Some(text) = event.payload.get("text").and_then(|v| v.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    labels.push(format!("‹‹ACT››{trimmed}‹‹/ACT››"));
                }
            }
        }
    }
    labels.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;
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
        let state = AppState::for_tests();
        let broadcast = register_turn("turn_test_emit");
        let mut rx = broadcast.tx.subscribe();
        emit_turn_event(
            &state,
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
        // broadcasted on the per-turn channel
        let received = rx.try_recv().unwrap();
        assert_eq!(received.seq, 1);
        assert_eq!(received.kind, "delta");
        // published on the unified WS (no subscribers → noop, but must not panic)
        assert_eq!(state.ws_registry.subscriber_count(), 0);
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
