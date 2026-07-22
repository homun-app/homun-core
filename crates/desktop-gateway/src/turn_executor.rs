//! Turn executor: runs a `chat_turn` task and fans out its stream events to
//! `turn_events` (durable, for resume) + a per-turn broadcast channel (live).
//! Sibling of `execute_proactive_prompt_task`, generalized for the broker.

use std::collections::HashMap;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};

use local_first_task_runtime::{
    AgentRunStatus, NewAgentRun, TaskRuntimeResult, TaskStore, TurnEventKind, broker::CancelNotify,
};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use tokio::sync::{Notify, broadcast};

fn finalize_agent_run(
    state: &crate::AppState,
    thread_id: &str,
    user_id: &str,
    workspace_id: &str,
    agent_run: &Option<(String, crate::agent_journal::GatewayExecutionJournal)>,
    status: AgentRunStatus,
    reason: &'static str,
    terminal_event: Option<local_first_engine::AgentExecutionEvent>,
) {
    let Some((run_id, journal)) = agent_run else {
        return;
    };
    if let Some(event) = terminal_event {
        local_first_engine::ExecutionJournal::record(journal, event);
    }
    let flushed = journal.close_and_flush();
    let dropped = journal.dropped_events();
    if !flushed || dropped > 0 {
        tracing::warn!(target: "agent::journal", %run_id, flushed, dropped, "journal completed with degraded observability");
    }
    if let Ok(store) = state.task_store.lock() {
        if let Err(error) = store.finish_agent_run(run_id, status, Some(reason)) {
            tracing::warn!(target: "agent::journal", %run_id, %error, "could not finalize agent run");
        }
        if let Ok(data_dir) = crate::gateway_data_dir() {
            if let Err(error) = crate::working_ledger::materialize(
                &store, &data_dir, user_id, workspace_id, thread_id,
            ) {
                tracing::warn!(target: "agent::ledger", %run_id, %error, "could not materialize working ledger");
            }
        }
    }
    crate::agent_journal::unregister(run_id);
}

/// A live subscriber fan-out for a single turn_id. Created when the turn starts running,
/// dropped when it terminates. Mirrors the StreamEntry pattern but keyed by turn_id
/// and broker-owned.
pub struct TurnBroadcast {
    pub tx: broadcast::Sender<TurnEvent>,
    pub cancel: Arc<TurnCancellation>,
    engine_abort: Mutex<Option<tokio::task::AbortHandle>>,
}

pub struct TurnCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl TurnCancellation {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
            if self.is_cancelled() {
                return;
            }
        }
    }
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
    let cancel = Arc::new(TurnCancellation::new());
    let broadcast = Arc::new(TurnBroadcast {
        tx,
        cancel,
        engine_abort: Mutex::new(None),
    });
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
pub fn turn_cancel_notify(turn_id: &str) -> Option<Arc<TurnCancellation>> {
    turn_broadcast_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(turn_id).map(|b| b.cancel.clone()))
}

pub fn turn_is_cancelled(turn_id: &str) -> bool {
    turn_cancel_notify(turn_id).is_some_and(|cancel| cancel.is_cancelled())
}

pub fn attach_turn_engine_abort(turn_id: &str, abort: tokio::task::AbortHandle) {
    if let Ok(map) = turn_broadcast_registry().lock() {
        if let Some(turn) = map.get(turn_id) {
            if let Ok(mut slot) = turn.engine_abort.lock() {
                if turn.cancel.is_cancelled() {
                    abort.abort();
                } else {
                    *slot = Some(abort);
                }
            }
        }
    }
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
        if let Ok(map) = turn_broadcast_registry().lock() {
            if let Some(turn) = map.get(turn_id) {
                turn.cancel.cancel();
                if let Ok(slot) = turn.engine_abort.lock() {
                    if let Some(abort) = slot.as_ref() {
                        abort.abort();
                    }
                }
            }
        }
        crate::abort_stream_generation(&format!("broker-{turn_id}"));
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
    let visible_prompt = task
        .input_json
        .get("visible_prompt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(prompt);
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
    let request_id = task
        .input_json
        .get("request_id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string)
        .or_else(|| turn_id.strip_prefix("turn_").map(str::to_string));
    let preseeded_user_message_id = request_id
        .as_ref()
        .map(|request_id| format!("local_user_{request_id}"));
    let preseeded_assistant_message_id = task
        .input_json
        .get("assistant_message_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let existing_objective = state
        .task_store
        .lock()
        .ok()
        .and_then(|store| {
            store
                .load_objective_contract(task.user_id.as_str(), &workspace_id, thread_id)
                .ok()
                .flatten()
        })
        .filter(|objective| objective.status == "active");
    let routing_binding = crate::active_routing_binding(state, Some(thread_id));
    let semantic_decision = crate::resolve_semantic_decision(
        state,
        Some(thread_id),
        prompt,
        existing_objective.as_ref(),
        routing_binding.as_ref(),
    );
    let project_root = crate::effective_thread_folder(thread_id);
    let projection = crate::semantic_decision::objective_contract_projection(
        &semantic_decision,
        existing_objective.as_ref(),
        thread_id,
        &workspace_id,
        project_root.as_deref(),
    );
    let objective = state.task_store.lock().ok().and_then(|store| {
        store
            .upsert_objective_contract(
                task.user_id.as_str(),
                &workspace_id,
                thread_id,
                preseeded_user_message_id.as_deref().unwrap_or(turn_id),
                &projection.objective,
                projection.mode,
                &projection.scope_json,
                &projection.allowed_actions_json,
                &projection.completion_json,
                "active",
            )
            .ok()
    });
    if objective.is_none() {
        tracing::warn!(target: "objective::contract", turn_id, "objective contract unavailable; execution policy will fail closed from the prompt");
    }
    // Legacy tasks have no attachment fields; defaulting keeps boot recovery
    // compatible while new broker turns retain their original composer input.
    let images = task
        .input_json
        .get("images")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
        .unwrap_or_default();
    let attachments = task
        .input_json
        .get("attachments")
        .cloned()
        .and_then(|value| {
            serde_json::from_value::<Vec<local_first_desktop_gateway::AttachmentInput>>(value).ok()
        })
        .unwrap_or_default();

    // 2. Map `approval` → agent tool_policy. Unknown values fall back to the
    //    most capable policy (`full`) — matches the interactive default.
    let tool_policy = match approval {
        "confirm" => "confirm",
        "autonomous" => "autonomous",
        "read_only" => "read_only",
        _ => "full",
    };

    // Operational journal setup is best-effort: an observability failure must never prevent the
    // user-visible turn. Run creation still preserves the exact broker attempt and scope when the
    // task-runtime database is available.
    let agent_run = crate::gateway_task_database_path()
        .ok()
        .and_then(|database_path| {
            let run_id = format!("agent_run_{}", uuid::Uuid::new_v4());
            let new_run = NewAgentRun {
                run_id: run_id.clone(),
                turn_id: turn_id.to_string(),
                thread_id: thread_id.to_string(),
                user_id: task.user_id.as_str().to_string(),
                workspace_id: task.workspace_id.as_str().to_string(),
                model: None,
                provider: None,
                prompt_fingerprint: None,
            };
            let created = state
                .task_store
                .lock()
                .ok()
                .and_then(|store| store.create_agent_run(&new_run).ok())
                .is_some();
            if !created {
                tracing::warn!(target: "agent::journal", turn_id, "could not create agent run");
                return None;
            }
            let Some(journal) =
                crate::agent_journal::GatewayExecutionJournal::start(run_id.clone(), database_path)
            else {
                if let Ok(store) = state.task_store.lock() {
                    let _ = store.finish_agent_run(
                        &run_id,
                        AgentRunStatus::Failed,
                        Some("journal_writer_spawn_failed"),
                    );
                }
                tracing::warn!(target: "agent::journal", %run_id, "could not spawn journal writer");
                return None;
            };
            crate::agent_journal::register(&run_id, journal.clone());
            Some((run_id, journal))
        });
    if let Some((_, journal)) = &agent_run {
        local_first_engine::ExecutionJournal::record(
            journal,
            local_first_engine::AgentExecutionEvent::SemanticDecision {
                payload: crate::semantic_decision::bounded_observability_payload(
                    &semantic_decision,
                ),
            },
        );
    }

    // 3. Register the live turn broadcast (Task 1a.2). Cancellation + the
    //    per-turn SSE/WS fan-out key off this. Always unregistered on exit.
    let broadcast = register_turn(turn_id);

    // 4. Open the visible turn: persists user + assistant placeholder messages
    //    and emits `thread.turn_started`. Fail closed if it cannot be persisted
    //    — never run invisible background model/tool work for an interactive
    //    request the user is waiting on.
    //
    //    Reuse the id the atomic enqueue already inserted (`local_user_{request_id}`)
    //    so we don't mint a SECOND user message for the same prompt. The atomic
    //    enqueue always writes `request_id` into input_json; fall back to deriving it
    //    from the turn_id (`turn_{request_id}`) if an older task is missing it.
    let visible_turn = crate::start_visible_conversation_turn(
        state,
        thread_id,
        &workspace_id,
        "interactive",
        None,
        visible_prompt,
        visible_prompt,
        preseeded_user_message_id.as_deref(),
        preseeded_assistant_message_id,
        // Advertise the broker turn id so any client with this thread open can attach to the
        // live stream (island + transcript) — the whole point of routing channel turns through
        // the broker instead of an invisible inline run.
        Some(turn_id),
    );
    let Some(visible_turn) = visible_turn else {
        finalize_agent_run(
            state,
            thread_id,
            task.user_id.as_str(),
            &workspace_id,
            &agent_run,
            AgentRunStatus::Failed,
            "visible_turn_start_failed",
            Some(local_first_engine::AgentExecutionEvent::RunFailed {
                reason: "visible_turn_start_failed".to_string(),
            }),
        );
        unregister_turn(turn_id);
        return Err(crate::LocalTaskExecutionError {
            message: "could not start a visible conversation turn".to_string(),
        });
    };

    // 4b. Channel turns: show a "typing…" indicator on the origin channel for the WHOLE turn.
    // The broker runs the turn in a worker (the inbound handler already returned), so unlike the
    // inline ApproveReply path the keepalive is tied to the turn lifecycle here. No-op for
    // non-channel threads; aborted right after the agent-loop finishes below.
    let typing_keepalive = crate::start_channel_typing_keepalive(state, thread_id);

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
            _ = cancel.cancelled() => None,
            answer = crate::run_agent_turn_into_message_with_fanout(
                state,
                thread_id,
                prompt,
                tool_policy,
                images,
                attachments,
                &visible_turn.user_message_id,
                &visible_turn.assistant_message_id,
                turn_id,
                agent_run.as_ref().map(|(run_id, _)| run_id.as_str()),
            ) => Some(answer),
        }
    });
    // Stop the typing indicator now the model is done — covers both the completed and the
    // cancelled path. Abort halts the refresh; the explicit "paused" clears WhatsApp, which
    // (unlike Telegram's self-expiring action) would otherwise stay "typing" on a cancelled turn.
    if let Some(handle) = typing_keepalive {
        handle.abort();
        tokio::runtime::Handle::current()
            .block_on(crate::clear_channel_typing(state, thread_id));
    }
    let cancelled = run.is_none();
    let answer = run.flatten().unwrap_or_default();
    let generated = !cancelled && !answer.trim().is_empty();
    if cancelled {
        if let Ok(store) = state.chat_store.lock() {
            let partial = store
                .message(thread_id, &visible_turn.assistant_message_id)
                .ok()
                .flatten()
                .map(|message| crate::strip_chat_markers(&message.text))
                .filter(|text| !text.trim().is_empty())
                .unwrap_or_else(|| "Operazione interrotta.".to_string());
            let _ = store.set_message_text(
                thread_id,
                &visible_turn.assistant_message_id,
                partial.trim(),
            );
            let _ = store.set_message_delivery_state(
                thread_id,
                &visible_turn.assistant_message_id,
                local_first_desktop_gateway::MessageDeliveryState::Cancelled,
            );
        }
        finalize_agent_run(
            state,
            thread_id,
            task.user_id.as_str(),
            &workspace_id,
            &agent_run,
            AgentRunStatus::Aborted,
            "cancelled",
            Some(local_first_engine::AgentExecutionEvent::RunAborted {
                reason: "cancelled".to_string(),
            }),
        );
    } else if generated {
        finalize_agent_run(
            state,
            thread_id,
            task.user_id.as_str(),
            &workspace_id,
            &agent_run,
            AgentRunStatus::Completed,
            "delivered",
            Some(local_first_engine::AgentExecutionEvent::RunCompleted {
                reason: "delivered".to_string(),
            }),
        );
    } else {
        finalize_agent_run(
            state,
            thread_id,
            task.user_id.as_str(),
            &workspace_id,
            &agent_run,
            AgentRunStatus::Failed,
            "no_reply_generated",
            Some(local_first_engine::AgentExecutionEvent::RunFailed {
                reason: "no_reply_generated".to_string(),
            }),
        );
    }
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
    if generated {
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
        let assistant_message = crate::channel_chat_message_with_id(
            "assistant",
            &full_text,
            &visible_turn.assistant_message_id,
        );
        tokio::runtime::Handle::current().block_on(
            crate::activate_remote_approvals_from_message(
                state,
                thread_id,
                &assistant_message,
            ),
        );

        // Channel convergence: mirror the CLEAN answer out to Telegram/WhatsApp when this
        // thread is a channel conversation (no-op otherwise). The OUTPUT adapter — a channel
        // message runs the SAME broker/engine turn (island/turn_events) and still gets a reply.
        // This executor is sync (block_on, like the engine call above), so block on the send.
        tokio::runtime::Handle::current()
            .block_on(crate::mirror_reply_to_channel_if_any(state, thread_id, &answer));

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
        tracing::info!(target: "broker::executor", turn_id = %turn_id, cancelled, "turn did not produce a final reply — skipping finalization + done event");
    }

    // 8. Drop the live broadcast (subscribers see the channel close).
    unregister_turn(turn_id);

    // 9. Build the outcome — same shape as `execute_proactive_prompt_task`. A cancelled
    // turn is never "completed"; the runner sees completed=false + the store's Cancelled
    // status and closes out without overwriting it.
    let completed = generated;
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
        GatewayCancelNotify.notify_cancel("turn_test_cancel");
        assert!(cancel.is_cancelled());
        assert!(turn_is_cancelled("turn_test_cancel"));
        let wait = std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(async {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    cancel.cancelled(),
                )
                .await
                .expect("latched cancellation must wake a late waiter");
            });
        });
        wait.join().unwrap();
        unregister_turn("turn_test_cancel");
    }

    #[tokio::test]
    async fn cancel_notify_aborts_attached_engine_task() {
        register_turn("turn_test_abort");
        let task = tokio::spawn(async {
            std::future::pending::<()>().await;
        });
        attach_turn_engine_abort("turn_test_abort", task.abort_handle());

        GatewayCancelNotify.notify_cancel("turn_test_abort");

        let error = task.await.expect_err("engine task must be aborted");
        assert!(error.is_cancelled());
        unregister_turn("turn_test_abort");
    }
}
