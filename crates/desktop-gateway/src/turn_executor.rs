//! Turn executor: runs a `chat_turn` task and fans out its stream events to
//! `turn_events` (durable, for resume) + a per-turn broadcast channel (live).
//! Sibling of `execute_proactive_prompt_task`, generalized for the broker.

use std::collections::HashMap;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};

use local_first_execution_protocol::{
    CancelReason, CheckpointDataRef, CheckpointEnvelope, DurableDataRef, EffectReceiptRef,
    ExecutionFailure, ExecutionOutcome, ObjectiveRef, ValidatedExecutionContract, WakeCondition,
};
use local_first_task_runtime::{
    NewAgentRun, TaskRuntimeResult, TaskStatus, TaskStore, TurnEventKind, broker::CancelNotify,
};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use sha2::Digest;
use tokio::sync::{Notify, broadcast};

fn checkpoint_store_id(data_ref: &CheckpointDataRef) -> Option<&str> {
    let encoded = match data_ref {
        CheckpointDataRef::Public { record_ref } | CheckpointDataRef::Redacted { record_ref } => {
            record_ref.as_ref()
        }
        CheckpointDataRef::Encrypted { .. } => return None,
    };
    encoded.strip_prefix("durable:v1:32:")
}

#[derive(Debug)]
struct EffectiveChatAttemptInput {
    prompt: String,
    visible_prompt: String,
    user_message_id: Option<String>,
    images: Vec<String>,
    attachments: Vec<local_first_desktop_gateway::AttachmentInput>,
}

fn effective_chat_attempt_input(
    task: &local_first_task_runtime::TaskRecord,
    wake: Option<&local_first_execution_protocol::WakeDelivery>,
) -> Result<EffectiveChatAttemptInput, crate::LocalTaskExecutionError> {
    let wake_payload = wake.map(|delivery| &delivery.payload);
    let task_prompt = task
        .input_json
        .get("prompt")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| crate::LocalTaskExecutionError {
            message: "chat_turn task missing prompt".to_string(),
        })?;
    let prompt = wake_payload
        .and_then(|payload| payload.get("prompt"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(task_prompt)
        .to_string();
    let visible_prompt = wake_payload
        .and_then(|payload| payload.get("visible_prompt"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            task.input_json
                .get("visible_prompt")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or(&prompt)
        .to_string();
    let user_message_id = wake_payload
        .and_then(|payload| payload.get("source_message_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            task.input_json
                .get("request_id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(|request_id| format!("local_user_{request_id}"))
        });

    let images_value = wake_payload
        .and_then(|payload| payload.get("images"))
        .or_else(|| task.input_json.get("images"));
    let images = images_value
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| crate::LocalTaskExecutionError {
            message: format!("chat_turn images are invalid: {error}"),
        })?
        .unwrap_or_default();
    let attachments_value = wake_payload
        .and_then(|payload| payload.get("attachments"))
        .filter(|value| !value.is_null())
        .or_else(|| task.input_json.get("attachments"));
    let attachments = attachments_value
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| crate::LocalTaskExecutionError {
            message: format!("chat_turn attachments are invalid: {error}"),
        })?
        .unwrap_or_default();

    Ok(EffectiveChatAttemptInput {
        prompt,
        visible_prompt,
        user_message_id,
        images,
        attachments,
    })
}

fn agent_resume_state(
    state: &crate::AppState,
    task: &local_first_task_runtime::TaskRecord,
    contract: &ValidatedExecutionContract,
) -> Option<Value> {
    let store = state.task_store.lock().ok()?;
    if contract.as_ref().revision > 1 {
        let prior = store
            .execution_revision(
                &contract.as_ref().execution_id,
                contract.as_ref().revision - 1,
            )
            .ok()??;
        let prior_outcome = prior.outcome?;
        let data_ref = match prior_outcome.as_ref() {
            ExecutionOutcome::Suspended { checkpoint, .. } => &checkpoint.data_ref,
            _ => return None,
        };
        let checkpoint = store
            .checkpoint(
                checkpoint_store_id(data_ref)?,
                &task.task_id,
                &task.user_id,
                &task.workspace_id,
            )
            .ok()??;
        let agent_state = checkpoint.payload.get("agent_state")?.clone();
        let expected = checkpoint
            .payload
            .get("agent_state_fingerprint")?
            .as_str()?;
        let actual = format!(
            "{:x}",
            sha2::Sha256::digest(serde_json::to_vec(&agent_state).ok()?)
        );
        return (actual == expected).then_some(agent_state);
    }

    store
        .latest_resumable_checkpoint_for_turn(
            task.task_id.as_str(),
            task.user_id.as_str(),
            task.workspace_id.as_str(),
        )
        .ok()?
        .and_then(|checkpoint| {
            let actual = format!(
                "{:x}",
                sha2::Sha256::digest(serde_json::to_vec(&checkpoint.state_json).ok()?)
            );
            (actual == checkpoint.fingerprint).then_some(checkpoint.state_json)
        })
}

pub(crate) fn canonical_chat_outcome(
    execution_id: &str,
    revision: u64,
    producer_kind: &str,
    turn: &local_first_engine::TurnOutcome,
    checkpoint_ref: Option<CheckpointDataRef>,
    objective: Option<ObjectiveRef>,
    effect_receipts: Vec<EffectReceiptRef>,
) -> Result<ExecutionOutcome, crate::LocalTaskExecutionError> {
    let suspended = |wake: WakeCondition| {
        let data_ref = checkpoint_ref
            .clone()
            .ok_or_else(|| crate::LocalTaskExecutionError {
                message: "suspended chat turn has no durable checkpoint reference".to_string(),
            })?;
        Ok(ExecutionOutcome::Suspended {
            wake: wake.clone(),
            checkpoint: CheckpointEnvelope::new(execution_id, revision, producer_kind, 1, data_ref)
                .with_resume_context(objective.clone(), wake, effect_receipts.clone()),
        })
    };

    match &turn.stop {
        local_first_engine::TurnStop::Completed => {
            Ok(ExecutionOutcome::completed(serde_json::json!({
                "kind": "chat_turn",
                "answer": turn.memory_answer,
            })))
        }
        local_first_engine::TurnStop::SuspendedUser => suspended(WakeCondition::User {
            wait_ref: format!("{execution_id}:{revision}:user"),
        }),
        local_first_engine::TurnStop::SuspendedApproval => suspended(WakeCondition::Approval {
            approval_ref: format!("{execution_id}:{revision}:approval"),
        }),
        local_first_engine::TurnStop::SuspendedEffect { receipt_ref } => {
            suspended(WakeCondition::EffectResolution {
                receipt_ref: receipt_ref.clone(),
            })
        }
        local_first_engine::TurnStop::SuspendedModel { role } => {
            suspended(WakeCondition::ModelAvailable { role: role.clone() })
        }
        local_first_engine::TurnStop::Failed { failure } => Ok(ExecutionOutcome::Failed {
            failure: failure.clone(),
        }),
    }
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

fn apply_persisted_cancellation(
    broadcast: &TurnBroadcast,
    persisted_status: Option<TaskStatus>,
) -> bool {
    if persisted_status == Some(TaskStatus::Cancelled) {
        broadcast.cancel.cancel();
        return true;
    }
    false
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
    if let Ok(map) = turn_broadcast_registry().lock()
        && let Some(turn) = map.get(turn_id)
        && let Ok(mut slot) = turn.engine_abort.lock()
    {
        if turn.cancel.is_cancelled() {
            abort.abort();
        } else {
            *slot = Some(abort);
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
    let event = if matches!(
        kind,
        TurnEventKind::Done | TurnEventKind::Error | TurnEventKind::Cancelled
    ) {
        match store.insert_terminal_event_once(turn_id, kind, payload.clone())? {
            local_first_task_runtime::TerminalWrite::Inserted(event) => event,
            local_first_task_runtime::TerminalWrite::Existing(_) => return Ok(()),
        }
    } else {
        store.insert_turn_event(turn_id, kind, payload.clone())?
    };
    // Best-effort live broadcast on the per-turn channel (NDJSON stream — transitional).
    // No receivers is fine (broadcast::send errors are benign).
    if let Ok(map) = turn_broadcast_registry().lock()
        && let Some(broadcast) = map.get(turn_id)
    {
        let _ = broadcast.tx.send(TurnEvent {
            seq: event.seq,
            kind: event.kind.as_str().to_string(),
            payload: payload.clone(),
        });
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
        if let Ok(map) = turn_broadcast_registry().lock()
            && let Some(turn) = map.get(turn_id)
        {
            turn.cancel.cancel();
            if let Ok(slot) = turn.engine_abort.lock()
                && let Some(abort) = slot.as_ref()
            {
                abort.abort();
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
    contract: &ValidatedExecutionContract,
) -> Result<ExecutionOutcome, crate::LocalTaskExecutionError> {
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
    let effective = effective_chat_attempt_input(task, contract.as_ref().wake.as_ref())?;
    let prompt = effective.prompt;
    let visible_prompt = effective.visible_prompt;
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
    let preseeded_user_message_id = effective.user_message_id;
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
        &prompt,
        existing_objective.as_ref(),
        routing_binding.as_ref(),
    );
    let project_root = crate::effective_thread_folder(thread_id);
    let projection = crate::semantic_decision::objective_contract_projection_for_request(
        &semantic_decision,
        existing_objective.as_ref(),
        thread_id,
        &workspace_id,
        project_root.as_deref(),
        &visible_prompt,
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
    if let (Some(previous), Some(current)) = (existing_objective.as_ref(), objective.as_ref())
        && previous.revision != current.revision
    {
        let secret_refs = state
            .task_store
            .lock()
            .ok()
            .and_then(|store| {
                store
                    .delete_browser_checkpoints_for_objective(
                        task.user_id.as_str(),
                        &workspace_id,
                        thread_id,
                        previous.revision,
                    )
                    .ok()
            })
            .unwrap_or_default();
        let cleared_secret_count = secret_refs.len();
        for reference in secret_refs {
            let _ = state.browser_checkpoint_secret_store.delete(&reference);
        }
        tracing::info!(
            target: "browser::checkpoint",
            event = "browser_checkpoint_cleared",
            reason = "objective_superseded",
            revision = previous.revision,
            cleared_secret_count,
            "browser checkpoint lifecycle cleanup"
        );
    }
    if objective.is_none() {
        tracing::warn!(target: "objective::contract", turn_id, "objective contract unavailable; execution policy will fail closed from the prompt");
    }
    // Legacy tasks have no attachment fields; defaulting keeps boot recovery
    // compatible while new broker turns retain their original composer input.
    let images = effective.images;
    let attachments = effective.attachments;

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
    // A worker owns the resource reservation before it reaches register_turn. If the
    // user cancels inside that short window, the in-process notify has no receiver yet.
    // Re-read the durable status after registration: either this observes Cancelled,
    // or a later cancellation sees the registered broadcast and signals it directly.
    let persisted_status = state
        .task_store
        .lock()
        .ok()
        .and_then(|store| {
            store
                .get_task(&task.task_id, &task.user_id, &task.workspace_id)
                .ok()
                .flatten()
        })
        .map(|stored| stored.status);
    if apply_persisted_cancellation(&broadcast, persisted_status) {
        tracing::info!(target: "broker::executor", turn_id = %turn_id, "latched cancellation registered before executor startup");
    }

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
        &visible_prompt,
        &visible_prompt,
        preseeded_user_message_id.as_deref(),
        preseeded_assistant_message_id,
        // Advertise the broker turn id so any client with this thread open can attach to the
        // live stream (island + transcript) — the whole point of routing channel turns through
        // the broker instead of an invisible inline run.
        Some(turn_id),
        Some(turn_id),
    );
    let Some(visible_turn) = visible_turn else {
        if let Some((run_id, journal)) = &agent_run {
            journal.close_and_flush();
            crate::agent_journal::unregister(run_id);
        }
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
    // Race the turn against its cancel signal (fired by `cancel_chat_turn` →
    // `GatewayCancelNotify`). Dropping the turn future on cancel aborts the in-flight
    // model/tool work; on cancel we SKIP the Completed finalize below so the `Cancelled`
    // status `cancel_chat_turn` already persisted survives (the runner also guards against
    // resurrecting an externally-cancelled task). Without this select the `notify_one()` had
    // no waiter in production and the turn always ran to completion, overwriting `Cancelled`.
    let cancel = broadcast.cancel.clone();
    let resume_state = agent_resume_state(state, task, contract);
    let run = tokio::runtime::Handle::current().block_on(async {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            answer = crate::run_agent_turn_into_message_with_fanout(
                state,
                thread_id,
                &prompt,
                tool_policy,
                images,
                attachments,
                &visible_turn.user_message_id,
                &visible_turn.assistant_message_id,
                turn_id,
                agent_run.as_ref().map(|(run_id, _)| run_id.as_str()),
                resume_state,
                local_first_desktop_gateway::MessageDeliveryState::Streaming,
            ) => Some(answer),
        }
    });
    // Stop the typing indicator now the model is done — covers both the completed and the
    // cancelled path. Abort halts the refresh; the explicit "paused" clears WhatsApp, which
    // (unlike Telegram's self-expiring action) would otherwise stay "typing" on a cancelled turn.
    if let Some(handle) = typing_keepalive {
        handle.abort();
        tokio::runtime::Handle::current().block_on(crate::clear_channel_typing(state, thread_id));
    }
    let mut canonical = match run {
        None => ExecutionOutcome::Cancelled {
            reason: CancelReason::User,
        },
        Some(Err(error)) => ExecutionOutcome::Failed {
            failure: ExecutionFailure::transient(
                "chat_transport_unavailable",
                crate::redact_sensitive_text(&error),
            ),
        },
        Some(Ok(result)) => {
            let turn = result.outcome;
            let (checkpoint_ref, effect_receipts) = if matches!(
                turn.stop,
                local_first_engine::TurnStop::SuspendedUser
                    | local_first_engine::TurnStop::SuspendedApproval
                    | local_first_engine::TurnStop::SuspendedEffect { .. }
                    | local_first_engine::TurnStop::SuspendedModel { .. }
            ) {
                let stop_kind = match &turn.stop {
                    local_first_engine::TurnStop::SuspendedUser => "user",
                    local_first_engine::TurnStop::SuspendedApproval => "approval",
                    local_first_engine::TurnStop::SuspendedEffect { .. } => "effect_resolution",
                    local_first_engine::TurnStop::SuspendedModel { .. } => "model",
                    local_first_engine::TurnStop::Completed
                    | local_first_engine::TurnStop::Failed { .. } => unreachable!(),
                };
                let store =
                    state
                        .task_store
                        .lock()
                        .map_err(|error| crate::LocalTaskExecutionError {
                            message: error.to_string(),
                        })?;
                let agent_checkpoint = agent_run.as_ref().and_then(|(run_id, _)| {
                    store
                        .latest_agent_checkpoint(
                            run_id,
                            task.user_id.as_str(),
                            task.workspace_id.as_str(),
                        )
                        .ok()
                        .flatten()
                });
                let checkpoint = store
                    .append_checkpoint(
                        &task.task_id,
                        &task.user_id,
                        &task.workspace_id,
                        serde_json::json!({
                            "kind": "chat_turn",
                            "stop": stop_kind,
                            "thread_id": thread_id,
                            "assistant_message_id": visible_turn.assistant_message_id,
                            "user_message_id": visible_turn.user_message_id,
                            "agent_run_id": agent_run.as_ref().map(|(run_id, _)| run_id),
                            "objective_revision": objective.as_ref().map(|record| record.revision),
                            "agent_state": agent_checkpoint.as_ref().map(|checkpoint| &checkpoint.state_json),
                            "agent_state_fingerprint": agent_checkpoint.as_ref().map(|checkpoint| &checkpoint.fingerprint),
                            "awaiting_user": turn.awaiting_user,
                            "answer": turn.memory_answer,
                        }),
                        serde_json::json!({
                            "kind": "chat_turn",
                            "stop": stop_kind,
                            "thread_id": thread_id,
                            "assistant_message_id": visible_turn.assistant_message_id,
                            "user_message_id": visible_turn.user_message_id,
                            "agent_run_id": agent_run.as_ref().map(|(run_id, _)| run_id),
                            "objective_revision": objective.as_ref().map(|record| record.revision),
                            "awaiting_user_kind": turn
                                .awaiting_user
                                .as_ref()
                                .map(|wait| wait.wait_kind_key()),
                        }),
                    )
                    .map_err(|error| crate::LocalTaskExecutionError {
                        message: error.to_string(),
                    })?;
                let receipts = store
                    .list_effect_receipts_for_execution(
                        &contract.as_ref().execution_id,
                        contract.as_ref().revision,
                    )
                    .map_err(|error| crate::LocalTaskExecutionError {
                        message: error.to_string(),
                    })?
                    .into_iter()
                    .map(|receipt| receipt.receipt_ref)
                    .collect();
                (
                    Some(CheckpointDataRef::Redacted {
                        record_ref: DurableDataRef::from_store_id(&checkpoint.checkpoint_id)
                            .map_err(|error| crate::LocalTaskExecutionError {
                                message: error.to_string(),
                            })?,
                    }),
                    receipts,
                )
            } else {
                (None, Vec::new())
            };
            canonical_chat_outcome(
                contract.as_ref().execution_id.as_str(),
                contract.as_ref().revision,
                contract.as_ref().kind.as_str(),
                &turn,
                checkpoint_ref,
                contract.as_ref().objective.clone(),
                effect_receipts,
            )?
        }
    };

    if let ExecutionOutcome::Completed { output, .. } = &mut canonical {
        output["thread_id"] = serde_json::json!(thread_id);
        output["assistant_message_id"] =
            serde_json::json!(visible_turn.assistant_message_id.as_str());
        output["user_message_id"] = serde_json::json!(visible_turn.user_message_id.as_str());
        output["agent_run_id"] =
            serde_json::json!(agent_run.as_ref().map(|(run_id, _)| run_id.as_str()));
        output["objective_revision"] =
            serde_json::json!(objective.as_ref().map(|record| record.revision));
    }

    if let Some((run_id, journal)) = &agent_run {
        let flushed = journal.close_and_flush();
        let dropped = journal.dropped_events();
        if !flushed || dropped > 0 {
            tracing::warn!(
                target: "agent::journal",
                %run_id,
                flushed,
                dropped,
                "journal closed with degraded observability before canonical projection"
            );
        }
        crate::agent_journal::unregister(run_id);
    }
    unregister_turn(turn_id);
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;
    use local_first_execution_protocol::{
        CheckpointDataRef, DurableDataRef, EffectReceiptRef, ExecutionContract, ExecutionOutcome,
        ExecutionScope, FailureClass, ValidatedExecutionContract, ValidatedExecutionOutcome,
        WakeCondition,
    };
    use local_first_task_runtime::{TaskRecord, TaskStore, UserId, WorkspaceId};

    fn checkpoint_ref() -> CheckpointDataRef {
        CheckpointDataRef::Redacted {
            record_ref: DurableDataRef::from_store_id("0123456789abcdef0123456789abcdef")
                .expect("valid durable ref"),
        }
    }

    #[test]
    fn typed_turn_stops_map_exhaustively_to_canonical_outcomes() {
        let cases = [
            (local_first_engine::TurnStop::Completed, "completed"),
            (local_first_engine::TurnStop::SuspendedUser, "user"),
            (local_first_engine::TurnStop::SuspendedApproval, "approval"),
            (
                local_first_engine::TurnStop::SuspendedEffect {
                    receipt_ref: EffectReceiptRef::from_store_id(
                        "11111111111111111111111111111111",
                    )
                    .unwrap(),
                },
                "effect",
            ),
            (
                local_first_engine::TurnStop::SuspendedModel {
                    role: "primary".to_string(),
                },
                "model",
            ),
            (
                local_first_engine::TurnStop::Failed {
                    failure: local_first_execution_protocol::ExecutionFailure::permanent(
                        "no_reply", "No reply",
                    ),
                },
                "failed",
            ),
        ];

        for (stop, expected) in cases {
            let turn = local_first_engine::TurnOutcome {
                stop,
                memory_answer: "answer".to_string(),
                ..Default::default()
            };
            let outcome = canonical_chat_outcome(
                "turn-1",
                1,
                "chat_turn",
                &turn,
                Some(checkpoint_ref()),
                None,
                Vec::new(),
            )
            .expect("typed stop maps");
            match (expected, outcome) {
                ("completed", ExecutionOutcome::Completed { output, .. }) => {
                    assert_eq!(output["answer"], "answer");
                }
                ("user", ExecutionOutcome::Suspended { wake, .. }) => assert_eq!(
                    wake,
                    WakeCondition::User {
                        wait_ref: "turn-1:1:user".to_string()
                    }
                ),
                ("approval", ExecutionOutcome::Suspended { wake, .. }) => assert_eq!(
                    wake,
                    WakeCondition::Approval {
                        approval_ref: "turn-1:1:approval".to_string()
                    }
                ),
                ("effect", ExecutionOutcome::Suspended { wake, .. }) => assert_eq!(
                    wake,
                    WakeCondition::EffectResolution {
                        receipt_ref: EffectReceiptRef::from_store_id(
                            "11111111111111111111111111111111",
                        )
                        .unwrap(),
                    }
                ),
                ("model", ExecutionOutcome::Suspended { wake, .. }) => assert_eq!(
                    wake,
                    WakeCondition::ModelAvailable {
                        role: "primary".to_string()
                    }
                ),
                ("failed", ExecutionOutcome::Failed { failure }) => {
                    assert_eq!(failure.class, FailureClass::Permanent);
                    assert_eq!(failure.code, "no_reply");
                }
                (expected, outcome) => panic!("expected {expected}, got {outcome:?}"),
            }
        }
    }

    #[test]
    fn resumed_revision_loads_the_exact_checkpoint_referenced_by_the_journal() {
        let state = AppState::for_tests();
        let user = UserId::new("user-1");
        let workspace = WorkspaceId::new("workspace-1");
        let task = TaskRecord::new(
            "turn-resume",
            user.clone(),
            workspace.clone(),
            "chat_turn",
            "resume",
            json!({"thread_id": "thread-1"}),
        );
        let contract = ValidatedExecutionContract::try_from(ExecutionContract::new(
            "turn-resume",
            "chat_turn",
            ExecutionScope {
                user_id: user.as_str().into(),
                workspace_id: workspace.as_str().into(),
                thread_id: Some("thread-1".into()),
            },
            serde_json::to_value(&task).unwrap(),
        ))
        .unwrap();
        let agent_state = json!({"round": 4, "messages": ["committed"]});
        let fingerprint = format!(
            "{:x}",
            sha2::Sha256::digest(serde_json::to_vec(&agent_state).unwrap())
        );
        let wake = WakeCondition::Signal {
            kind: "resume.test".into(),
            correlation_id: "signal-1".into(),
        };

        let resumed_contract = {
            let store = state.task_store.lock().unwrap();
            store.insert_task(&task).unwrap();
            store.create_execution(&contract).unwrap();
            let checkpoint = store
                .append_checkpoint(
                    &task.task_id,
                    &task.user_id,
                    &task.workspace_id,
                    json!({
                        "agent_state": agent_state,
                        "agent_state_fingerprint": fingerprint,
                    }),
                    json!({"kind": "chat_turn"}),
                )
                .unwrap();
            let outcome = ValidatedExecutionOutcome::new(
                ExecutionOutcome::Suspended {
                    wake: wake.clone(),
                    checkpoint: CheckpointEnvelope::new(
                        "turn-resume",
                        1,
                        "chat_turn",
                        1,
                        CheckpointDataRef::Redacted {
                            record_ref: DurableDataRef::from_store_id(&checkpoint.checkpoint_id)
                                .unwrap(),
                        },
                    )
                    .with_resume_context(None, wake, Vec::new()),
                },
                &contract,
            )
            .unwrap();
            store.commit_execution_outcome(&outcome).unwrap();
            store
                .deliver_execution_signal("resume.test", "signal-1", &json!({"ok": true}))
                .unwrap();
            store.execution("turn-resume").unwrap().unwrap().contract
        };

        assert_eq!(
            agent_resume_state(&state, &task, &resumed_contract),
            Some(json!({"round": 4, "messages": ["committed"]}))
        );
    }

    #[test]
    fn resumed_chat_attempt_uses_the_durable_wake_input() {
        let task = TaskRecord::new(
            "turn-input-resume",
            UserId::new("user-1"),
            WorkspaceId::new("workspace-1"),
            "chat_turn",
            "choose",
            json!({
                "prompt": "Choose A or B",
                "visible_prompt": "Choose one",
                "request_id": "initial",
                "images": ["old-image"],
                "attachments": [{"local_path": "/tmp/old.txt", "display_name": "old.txt"}],
            }),
        );
        let delivery = local_first_execution_protocol::WakeDelivery {
            condition: WakeCondition::User {
                wait_ref: "wait-1".into(),
            },
            dedup_key: WakeCondition::User {
                wait_ref: "wait-1".into(),
            }
            .dedup_key(),
            payload: json!({
                "type": "user",
                "prompt": "A",
                "visible_prompt": "A",
                "request_id": "resume",
                "source_message_id": "local_user_resume",
                "images": ["new-image"],
                "attachments": [{"local_path": "/tmp/new.txt", "display_name": "new.txt"}],
            }),
            delivered_at_unix_seconds: 1,
        };

        let input = effective_chat_attempt_input(&task, Some(&delivery)).unwrap();
        assert_eq!(input.prompt, "A");
        assert_eq!(input.visible_prompt, "A");
        assert_eq!(input.user_message_id.as_deref(), Some("local_user_resume"));
        assert_eq!(input.images, vec!["new-image"]);
        assert_eq!(input.attachments[0].display_name, "new.txt");
    }

    #[test]
    fn completed_typed_stop_needs_no_task_status_reread() {
        let turn = local_first_engine::TurnOutcome {
            stop: local_first_engine::TurnStop::Completed,
            memory_answer: "visible answer".to_string(),
            ..Default::default()
        };

        let outcome =
            canonical_chat_outcome("turn-stale", 2, "chat_turn", &turn, None, None, Vec::new())
                .expect("completed outcome");

        assert!(matches!(outcome, ExecutionOutcome::Completed { .. }));
    }

    #[test]
    fn register_and_unregister_turn() {
        let _ = register_turn("turn_test_reg");
        assert!(
            turn_broadcast_registry()
                .lock()
                .unwrap()
                .contains_key("turn_test_reg")
        );
        assert!(turn_cancel_notify("turn_test_reg").is_some());
        unregister_turn("turn_test_reg");
        assert!(
            !turn_broadcast_registry()
                .lock()
                .unwrap()
                .contains_key("turn_test_reg")
        );
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
    fn emit_broadcasts_only_the_canonical_terminal() {
        let store = TaskStore::open_in_memory().unwrap();
        let state = AppState::for_tests();
        let broadcast = register_turn("turn_test_terminal");
        let mut rx = broadcast.tx.subscribe();

        emit_turn_event(
            &state,
            &store,
            "turn_test_terminal",
            TurnEventKind::Done,
            json!({"attempt": 2}),
        )
        .unwrap();
        emit_turn_event(
            &state,
            &store,
            "turn_test_terminal",
            TurnEventKind::Error,
            json!({"attempt": 1}),
        )
        .unwrap();

        let events = store.read_turn_events("turn_test_terminal", 0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, TurnEventKind::Done);
        assert_eq!(rx.try_recv().unwrap().kind, "done");
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        unregister_turn("turn_test_terminal");
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
                tokio::time::timeout(std::time::Duration::from_secs(1), cancel.cancelled())
                    .await
                    .expect("latched cancellation must wake a late waiter");
            });
        });
        wait.join().unwrap();
        unregister_turn("turn_test_cancel");
    }

    #[test]
    fn persisted_cancel_before_registration_is_latched() {
        let broadcast = register_turn("turn_test_persisted_cancel");

        assert!(apply_persisted_cancellation(
            &broadcast,
            Some(TaskStatus::Cancelled)
        ));
        assert!(broadcast.cancel.is_cancelled());

        unregister_turn("turn_test_persisted_cancel");
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
