//! Durable chat turn broker HTTP owner.
//!
//! Owns the gateway routes and helpers that enqueue, resume, cancel, inspect,
//! steer, and stream durable `chat_turn` executions. The agent loop, live stream
//! transport, memory endpoints, and generic task executor remain in their own
//! owners.

use super::*;

#[test]
fn turn_broker_owner_smoke() {
    let input = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: "thread-test".to_string(),
        request_id: "request-test".to_string(),
        assistant_message_id: "assistant-test".to_string(),
        prompt: "hello".to_string(),
        visible_prompt: None,
        images: Vec::new(),
        attachments: None,
        mode: None,
        model: None,
        source: local_first_task_runtime::broker::ChatTurnSource::Interactive,
        approval: local_first_task_runtime::broker::TurnApproval::Full,
    };
    assert!(broker_turn_message_attachments(&input).is_empty());
}

// ── Turn broker HTTP surface (the only chat path) ─────────────────────────────
//
// POST   /api/chat/turns                    — enqueue a chat turn (201 / 409)
// GET    /api/chat/turns/{turn_id}          — turn status
// DELETE /api/chat/turns/{turn_id}          — cancel (202 / 404)
// GET    /api/chat/turns/{turn_id}/events   — batch events (?since=seq)
// GET    /api/chat/turns/{turn_id}/stream   — replay + live NDJSON (?since=seq)

/// POST /api/chat/turns — enqueue a chat turn via the broker.
/// The ONE chat-turn enqueue: atomically persist the linked user message AND the `chat_turn`
/// task in a single tx; the worker pool + `execute_chat_turn_task` then run the canonical engine
/// (which emits `turn_events` → the working island). Shared by the HTTP `enqueue_turn` and the
/// channel inbound path so a channel message is just another turn SOURCE — same broker, same
/// engine, same island/persistence — instead of a parallel inline executor.
pub(crate) fn enqueue_chat_turn_core(
    state: &AppState,
    input: &local_first_task_runtime::broker::ChatTurnInput,
) -> Result<
    local_first_task_runtime::broker::EnqueuedTurn,
    local_first_task_runtime::broker::EnqueueError,
> {
    let user_id = gateway_user_id();
    let workspace_id = lock_store(state)
        .ok()
        .and_then(|store| store.workspace_for_thread(&input.thread_id).ok())
        .map(WorkspaceId::new)
        .unwrap_or_else(gateway_workspace_id);
    let store = state.task_store.lock().map_err(|e| {
        local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Store(format!("task store lock: {e}")),
        )
    })?;
    local_first_task_runtime::broker::enqueue_chat_turn_atomic(
        &store,
        &user_id,
        &workspace_id,
        input,
        |tx| insert_broker_turn_messages(tx, input),
    )
}

pub(crate) fn enqueue_or_steer_chat_turn_core(
    state: &AppState,
    input: &local_first_task_runtime::broker::ChatTurnInput,
) -> Result<
    local_first_task_runtime::broker::EnqueueTurnOutcome,
    local_first_task_runtime::broker::EnqueueError,
> {
    let user_id = gateway_user_id();
    let workspace_id = lock_store(state)
        .ok()
        .and_then(|store| store.workspace_for_thread(&input.thread_id).ok())
        .map(WorkspaceId::new)
        .unwrap_or_else(gateway_workspace_id);
    let store = state.task_store.lock().map_err(|e| {
        local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Store(format!("task store lock: {e}")),
        )
    })?;
    local_first_task_runtime::broker::enqueue_or_steer_chat_turn_atomic(
        &store,
        &user_id,
        &workspace_id,
        input,
        |tx| insert_broker_turn_messages(tx, input),
        |tx| insert_broker_steering_user_message(tx, input),
    )
}

pub(crate) fn complete_temporal_preflight_chat_turn_core(
    state: &AppState,
    input: &local_first_task_runtime::broker::ChatTurnInput,
    text: &str,
) -> Result<
    Option<local_first_task_runtime::broker::EnqueuedTurn>,
    local_first_task_runtime::broker::EnqueueError,
> {
    let user_id = gateway_user_id();
    let workspace_id = lock_store(state)
        .ok()
        .and_then(|store| store.workspace_for_thread(&input.thread_id).ok())
        .map(WorkspaceId::new)
        .unwrap_or_else(gateway_workspace_id);
    let store = state.task_store.lock().map_err(|error| {
        local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Store(format!("task store lock: {error}")),
        )
    })?;
    if store
        .active_chat_turn_for_thread(&input.thread_id)
        .map_err(local_first_task_runtime::broker::EnqueueError::Store)?
        .is_some()
    {
        return Ok(None);
    }
    let task_id = local_first_task_runtime::broker::chat_turn_task_id(&input.request_id);
    let completed = local_first_task_runtime::broker::complete_chat_turn_atomic(
        &store,
        &user_id,
        &workspace_id,
        input,
        local_first_task_runtime::broker::TerminalChatTurn {
            status: local_first_task_runtime::TaskStatus::Completed,
            event_kind: local_first_task_runtime::TurnEventKind::Done,
            event_payload: serde_json::json!({
                "assistant_message_id": input.assistant_message_id,
                "execution_id": task_id.as_str(),
                "revision": 1,
                "text": text,
            }),
        },
        |tx| insert_broker_temporal_preflight_messages(tx, input, text),
    )?;
    Ok(Some(completed))
}

pub(crate) fn fail_model_preflight_chat_turn_core(
    state: &AppState,
    input: &local_first_task_runtime::broker::ChatTurnInput,
    text: &str,
) -> Result<
    Option<local_first_task_runtime::broker::EnqueuedTurn>,
    local_first_task_runtime::broker::EnqueueError,
> {
    let user_id = gateway_user_id();
    let workspace_id = lock_store(state)
        .ok()
        .and_then(|store| store.workspace_for_thread(&input.thread_id).ok())
        .map(WorkspaceId::new)
        .unwrap_or_else(gateway_workspace_id);
    let store = state.task_store.lock().map_err(|error| {
        local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Store(format!("task store lock: {error}")),
        )
    })?;
    if store
        .active_chat_turn_for_thread(&input.thread_id)
        .map_err(local_first_task_runtime::broker::EnqueueError::Store)?
        .is_some()
    {
        return Ok(None);
    }
    let task_id = local_first_task_runtime::broker::chat_turn_task_id(&input.request_id);
    let failed = local_first_task_runtime::broker::complete_chat_turn_atomic(
        &store,
        &user_id,
        &workspace_id,
        input,
        local_first_task_runtime::broker::TerminalChatTurn {
            status: local_first_task_runtime::TaskStatus::Failed,
            event_kind: local_first_task_runtime::TurnEventKind::Error,
            event_payload: serde_json::json!({
                "assistant_message_id": input.assistant_message_id,
                "execution_id": task_id.as_str(),
                "revision": 1,
                "text": text,
            }),
        },
        |tx| insert_broker_model_preflight_messages(tx, input, text),
    )?;
    Ok(Some(failed))
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct ResumedChatTurn {
    pub(crate) execution_id: String,
    pub(crate) revision: u64,
    pub(crate) stream_from_seq: i64,
}

pub(crate) fn resume_suspended_user_turn_core(
    state: &AppState,
    input: &local_first_task_runtime::broker::ChatTurnInput,
) -> Result<Option<ResumedChatTurn>, local_first_task_runtime::broker::EnqueueError> {
    if input.source != local_first_task_runtime::broker::ChatTurnSource::Interactive {
        return Ok(None);
    }
    let user_id = gateway_user_id();
    let workspace_id = lock_store(state)
        .ok()
        .and_then(|store| store.workspace_for_thread(&input.thread_id).ok())
        .map(WorkspaceId::new)
        .unwrap_or_else(gateway_workspace_id);
    let store = state.task_store.lock().map_err(|error| {
        local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Store(format!("task store lock: {error}")),
        )
    })?;
    let mut wakes = store
        .pending_execution_wakes(
            user_id.as_str(),
            workspace_id.as_str(),
            Some(&input.thread_id),
        )?
        .into_iter()
        .filter(|wake| {
            matches!(
                wake.condition,
                local_first_execution_protocol::WakeCondition::User { .. }
            )
        });
    let Some(wake) = wakes.next() else {
        return Ok(None);
    };
    if wakes.next().is_some() {
        return Err(local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Conflict(
                "thread has more than one pending user wake".into(),
            ),
        ));
    }
    // Never resurrect a turn that already reached a terminal state (e.g. it was
    // cancelled while suspended): discard the stale wake and return `None` so
    // the caller enqueues a brand-new turn for this message instead.
    let wake_task_is_terminal = store
        .get_task(
            &local_first_task_runtime::TaskId::new(&wake.execution_id),
            &user_id,
            &workspace_id,
        )?
        .is_some_and(|task| {
            local_first_task_runtime::turn_lifecycle::task_status_is_terminal(task.status)
        });
    if wake_task_is_terminal {
        store.discard_pending_execution_wakes(&wake.execution_id)?;
        return Ok(None);
    }
    let stream_from_seq = store
        .read_turn_events(&wake.execution_id, 0)?
        .last()
        .map(|event| event.seq)
        .unwrap_or(0);
    let payload = serde_json::json!({
        "type": "user",
        "prompt": input.prompt,
        "visible_prompt": input.visible_prompt,
        "request_id": input.request_id,
        "source_message_id": format!("local_user_{}", input.request_id),
        "images": input.images,
        "attachments": input.attachments,
        "mode": input.mode,
        "model": input.model,
    });
    #[cfg(not(test))]
    let delivered = store.deliver_execution_wake_with(&wake.condition, &payload, |tx| {
        insert_broker_resume_user_message(tx, input, &wake.execution_id)
    })?;
    // Test AppState keeps chat and task stores on separate in-memory SQLite
    // connections, unlike production's shared homun.sqlite.
    #[cfg(test)]
    let delivered = store.deliver_execution_wake(&wake.condition, &payload)?;
    if delivered != 1 {
        return Err(local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Conflict(
                "pending user wake changed before delivery".into(),
            ),
        ));
    }
    #[cfg(test)]
    {
        drop(store);
        let _ = start_visible_conversation_turn(
            state,
            &input.thread_id,
            workspace_id.as_str(),
            input.source.as_str(),
            None,
            "Resume",
            input.visible_prompt.as_deref().unwrap_or(&input.prompt),
            Some(&format!("local_user_{}", input.request_id)),
            None,
            Some(&wake.execution_id),
            Some(&wake.execution_id),
        );
    }
    Ok(Some(ResumedChatTurn {
        execution_id: wake.execution_id,
        revision: wake.revision + 1,
        stream_from_seq,
    }))
}

pub(crate) fn resume_suspended_approval_turn_core(
    state: &AppState,
    thread_id: &str,
    approved: bool,
    tool: &str,
    result: &str,
    approved_args: Option<&serde_json::Value>,
    prompt: &str,
) -> Result<Option<ResumedChatTurn>, local_first_task_runtime::broker::EnqueueError> {
    let user_id = gateway_user_id();
    let workspace_id = lock_store(state)
        .ok()
        .and_then(|store| store.workspace_for_thread(thread_id).ok())
        .map(WorkspaceId::new)
        .unwrap_or_else(gateway_workspace_id);
    let store = state.task_store.lock().map_err(|error| {
        local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Store(format!("task store lock: {error}")),
        )
    })?;
    let mut wakes = store
        .pending_execution_wakes(user_id.as_str(), workspace_id.as_str(), Some(thread_id))?
        .into_iter()
        .filter(|wake| {
            matches!(
                wake.condition,
                local_first_execution_protocol::WakeCondition::Approval { .. }
            )
        });
    let Some(wake) = wakes.next() else {
        return Ok(None);
    };
    if wakes.next().is_some() {
        return Err(local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Conflict(
                "thread has more than one pending approval wake".into(),
            ),
        ));
    }
    let stream_from_seq = store
        .read_turn_events(&wake.execution_id, 0)?
        .last()
        .map(|event| event.seq)
        .unwrap_or(0);
    let payload = serde_json::json!({
        "type": "approval",
        "approved": approved,
        "tool": tool,
        "result": result,
        "arguments": approved_args,
        "prompt": prompt,
        "visible_prompt": approval_continuation_visible_text(tool),
    });
    let delivered = store.deliver_execution_wake(&wake.condition, &payload)?;
    if delivered != 1 {
        return Err(local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Conflict(
                "pending approval wake changed before delivery".into(),
            ),
        ));
    }
    Ok(Some(ResumedChatTurn {
        execution_id: wake.execution_id,
        revision: wake.revision + 1,
        stream_from_seq,
    }))
}

pub(crate) fn insert_broker_turn_messages(
    tx: &rusqlite::Transaction<'_>,
    input: &local_first_task_runtime::broker::ChatTurnInput,
) -> local_first_task_runtime::TaskRuntimeResult<()> {
    let visible_prompt = input.visible_prompt.as_deref().unwrap_or(&input.prompt);
    let mut user = channel_chat_message_with_id(
        "user",
        visible_prompt,
        &format!("local_user_{}", input.request_id),
    );
    user.attachments = broker_turn_message_attachments(input);
    let mut assistant = channel_chat_message_with_id("assistant", "", &input.assistant_message_id);
    assistant.linked_task_id = Some(
        local_first_task_runtime::broker::chat_turn_task_id(&input.request_id)
            .as_str()
            .to_string(),
    );
    assistant.memory_reuse = Some(local_first_memory::MemoryReuseEnvelope::blocked_unknown());
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Streaming;
    ChatStore::insert_linked_turn_messages(tx, &input.thread_id, &user, &assistant)
        .map_err(|e| local_first_task_runtime::TaskRuntimeError::Store(e.to_string()))
}

pub(crate) fn insert_broker_temporal_preflight_messages(
    tx: &rusqlite::Transaction<'_>,
    input: &local_first_task_runtime::broker::ChatTurnInput,
    text: &str,
) -> local_first_task_runtime::TaskRuntimeResult<()> {
    let visible_prompt = input.visible_prompt.as_deref().unwrap_or(&input.prompt);
    let mut user = channel_chat_message_with_id(
        "user",
        visible_prompt,
        &format!("local_user_{}", input.request_id),
    );
    user.attachments = broker_turn_message_attachments(input);
    let mut assistant =
        channel_chat_message_with_id("assistant", text, &input.assistant_message_id);
    assistant.linked_task_id = Some(
        local_first_task_runtime::broker::chat_turn_task_id(&input.request_id)
            .as_str()
            .to_string(),
    );
    assistant.memory_reuse = Some(local_first_memory::MemoryReuseEnvelope::blocked_unknown());
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Delivered;
    ChatStore::insert_linked_turn_messages(tx, &input.thread_id, &user, &assistant)
        .map_err(|e| local_first_task_runtime::TaskRuntimeError::Store(e.to_string()))
}

pub(crate) fn insert_broker_model_preflight_messages(
    tx: &rusqlite::Transaction<'_>,
    input: &local_first_task_runtime::broker::ChatTurnInput,
    text: &str,
) -> local_first_task_runtime::TaskRuntimeResult<()> {
    let visible_prompt = input.visible_prompt.as_deref().unwrap_or(&input.prompt);
    let mut user = channel_chat_message_with_id(
        "user",
        visible_prompt,
        &format!("local_user_{}", input.request_id),
    );
    user.attachments = broker_turn_message_attachments(input);
    let mut assistant =
        channel_chat_message_with_id("assistant", text, &input.assistant_message_id);
    assistant.linked_task_id = Some(
        local_first_task_runtime::broker::chat_turn_task_id(&input.request_id)
            .as_str()
            .to_string(),
    );
    assistant.memory_reuse = Some(local_first_memory::MemoryReuseEnvelope::blocked_unknown());
    assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Failed;
    ChatStore::insert_linked_turn_messages(tx, &input.thread_id, &user, &assistant)
        .map_err(|e| local_first_task_runtime::TaskRuntimeError::Store(e.to_string()))
}

pub(crate) fn chat_model_configuration_missing() -> bool {
    crate::effective_inference_base_url().is_none()
}

pub(crate) fn missing_model_provider_text() -> &'static str {
    "No model provider is configured. Open Settings > Providers and add or enable a provider before starting a chat."
}

pub(crate) fn insert_broker_steering_user_message(
    tx: &rusqlite::Transaction<'_>,
    input: &local_first_task_runtime::broker::ChatTurnInput,
) -> local_first_task_runtime::TaskRuntimeResult<()> {
    let visible_prompt = input.visible_prompt.as_deref().unwrap_or(&input.prompt);
    ChatStore::insert_linked_user_message(
        tx,
        &input.thread_id,
        &format!("local_user_{}", input.request_id),
        visible_prompt,
        &now_epoch_secs().to_string(),
        &broker_turn_message_attachments(input),
    )
    .map_err(|e| local_first_task_runtime::TaskRuntimeError::Store(e.to_string()))
}

#[cfg(not(test))]
pub(crate) fn insert_broker_resume_user_message(
    tx: &rusqlite::Transaction<'_>,
    input: &local_first_task_runtime::broker::ChatTurnInput,
    execution_id: &str,
) -> local_first_task_runtime::TaskRuntimeResult<()> {
    let visible_prompt = input.visible_prompt.as_deref().unwrap_or(&input.prompt);
    ChatStore::insert_linked_resume_user_message(
        tx,
        &input.thread_id,
        &format!("local_user_{}", input.request_id),
        visible_prompt,
        &now_epoch_secs().to_string(),
        &broker_turn_message_attachments(input),
        execution_id,
    )
    .map_err(|e| local_first_task_runtime::TaskRuntimeError::Store(e.to_string()))
}

/// Project durable broker inputs into the transcript once, at enqueue. The
/// worker later consumes these same inputs, so transcript and model never
/// disagree about which attachments belong to a turn.
pub(crate) fn broker_turn_message_attachments(
    input: &local_first_task_runtime::broker::ChatTurnInput,
) -> Vec<serde_json::Value> {
    let mut out = input
        .attachments
        .as_ref()
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, attachment)| {
            let display_name = attachment.get("display_name")?.as_str()?;
            let mime_type = attachment
                .get("mime_type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let kind = if mime_type.starts_with("image/") {
                "image"
            } else if mime_type.starts_with("text/") || mime_type == "application/json" {
                "text"
            } else {
                "file"
            };
            Some(serde_json::json!({
                "artifact_id": format!("pending_{}_{}", input.request_id, index),
                "title_redacted": display_name,
                "kind": kind,
                "size_bytes": attachment
                    .get("size_bytes")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or_default(),
                "preview_available": kind == "image",
                "privacy_domain": "local_files",
            }))
        })
        .collect::<Vec<_>>();
    out.extend(input.images.iter().enumerate().map(|(index, image)| {
        serde_json::json!({
            "artifact_id": format!("inline_image_{}_{}", input.request_id, index),
            "title_redacted": format!("Image {}", index + 1),
            "kind": "image",
            "size_bytes": 0,
            "preview_available": true,
            "privacy_domain": "local_files",
            "preview_url": image,
        })
    }));
    out
}

pub(crate) async fn enqueue_turn(
    State(state): State<AppState>,
    Json(req): Json<EnqueueTurnRequest>,
) -> Result<(StatusCode, Json<Value>), GatewayError> {
    tracing::info!(
        target: "broker::enqueue",
        thread_id = %req.thread_id,
        prompt_len = req.prompt.len(),
        source = ?req.source.as_deref().unwrap_or("interactive"),
        "turn enqueue requested"
    );
    // Honor the client's request_id so turn_id == `turn_{request_id}` is predictable client-side
    // (cancel via DELETE /turns/{id} and resume both derive it). Regenerating it here silently
    // broke Stop: the client's DELETE hit `turn_{clientRequestId}` while the turn lived under a
    // server-minted id → 404, cancel never reached the turn. Fall back to a fresh id for callers
    // that don't supply one (some non-interactive sources).
    let request_id = req
        .request_id
        .clone()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| {
            format!(
                "chat_stream_{}_{}",
                now_epoch_secs(),
                uuid::Uuid::new_v4().simple()
            )
        });
    let source = match req.source.as_deref().unwrap_or("interactive") {
        "automation" => local_first_task_runtime::broker::ChatTurnSource::Automation,
        "channel" => local_first_task_runtime::broker::ChatTurnSource::Channel,
        "connector" => local_first_task_runtime::broker::ChatTurnSource::Connector,
        _ => local_first_task_runtime::broker::ChatTurnSource::Interactive,
    };
    let approval = match source {
        local_first_task_runtime::broker::ChatTurnSource::Interactive => {
            local_first_task_runtime::broker::TurnApproval::Full
        }
        // Channels stay READ-ONLY (no committing tool/browser actions on the user's behalf
        // from an inbound message) — the same policy the inline path enforced.
        local_first_task_runtime::broker::ChatTurnSource::Channel => {
            local_first_task_runtime::broker::TurnApproval::ReadOnly
        }
        _ => local_first_task_runtime::broker::TurnApproval::Confirm,
    };
    let input = local_first_task_runtime::broker::ChatTurnInput {
        thread_id: req.thread_id.clone(),
        request_id: request_id.clone(),
        assistant_message_id: format!("local_assistant_{request_id}"),
        prompt: req.prompt.clone(),
        visible_prompt: req.visible_prompt.clone(),
        images: req.images.clone(),
        attachments: req.attachments.clone(),
        mode: req.mode.clone(),
        model: req.model.clone(),
        source,
        approval,
    };
    // S2: persist a plugin-owned routing binding THREAD-scoped, before the turn runs.
    // Root cause this closes: per-turn BM25 routing from the prompt alone loses the
    // route on "Use template" intake follow-ups ("mio", "1 Senior developer…") that
    // don't match the original route_text, falling through to the general AgentLoop
    // (no tool pruning). Writing it here — once, at the turn that sets it — means the
    // router (S2-T3) can read it on this turn AND every later turn of the thread that
    // doesn't re-send it. Absent on ordinary turns: fail-open, no behavior change.
    if let Some(binding) = &req.routing_binding {
        let binding_json = serde_json::to_string(binding).map_err(|e| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "routing_binding_invalid",
            message: format!("routing_binding serialize: {e}"),
        })?;
        lock_store(&state)?
            .set_thread_routing_binding(&req.thread_id, &binding_json)
            .map_err(GatewayError::store)?;
    }
    if let Some(text) =
        crate::gateway_temporal_preflight::evaluate_chat_temporal_preflight(input.prompt.as_str())
            .into_done_text()
        && let Some(completed) = complete_temporal_preflight_chat_turn_core(&state, &input, &text)
            .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "temporal_preflight_store",
            message: error.to_string(),
        })?
    {
        return Ok((
            StatusCode::CREATED,
            Json(serde_json::json!({
                "turn_id": completed.task_id.as_str(),
                "thread_id": completed.thread_id,
                "request_id": request_id,
                "status": "completed",
                "position_in_queue": completed.position_in_queue,
            })),
        ));
    }
    if chat_model_configuration_missing() {
        let text = missing_model_provider_text();
        if let Some(failed) =
            fail_model_preflight_chat_turn_core(&state, &input, text).map_err(|error| {
                GatewayError {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    code: "model_preflight_store",
                    message: error.to_string(),
                }
            })?
        {
            return Ok((
                StatusCode::CREATED,
                Json(serde_json::json!({
                    "turn_id": failed.task_id.as_str(),
                    "thread_id": failed.thread_id,
                    "request_id": request_id,
                    "status": "failed",
                    "position_in_queue": failed.position_in_queue,
                })),
            ));
        }
    }
    if let Some(resumed) =
        resume_suspended_user_turn_core(&state, &input).map_err(|error| GatewayError {
            status: StatusCode::CONFLICT,
            code: "broker_resume_store",
            message: error.to_string(),
        })?
    {
        publish_app_event(serde_json::json!({
            "type": "thread.turn_resumed",
            "thread_id": input.thread_id,
            "turn_id": resumed.execution_id,
            "revision": resumed.revision,
        }));
        return Ok((
            StatusCode::ACCEPTED,
            Json(serde_json::json!({
                "turn_id": resumed.execution_id,
                "thread_id": input.thread_id,
                "request_id": request_id,
                "revision": resumed.revision,
                "stream_from_seq": resumed.stream_from_seq,
                "status": "resumed",
            })),
        ));
    }
    match enqueue_or_steer_chat_turn_core(&state, &input) {
        Ok(local_first_task_runtime::broker::EnqueueTurnOutcome::Enqueued(enqueued)) => {
            let turn_id = enqueued.task_id.as_str().to_string();
            tracing::info!(
                target: "broker::enqueue",
                turn_id = %turn_id,
                thread_id = %enqueued.thread_id,
                "turn enqueued (201) — worker pool will pick it up"
            );
            Ok((
                StatusCode::CREATED,
                Json(serde_json::json!({
                    "turn_id": turn_id,
                    "thread_id": enqueued.thread_id,
                    "request_id": request_id,
                    "status": "queued",
                    "position_in_queue": enqueued.position_in_queue,
                })),
            ))
        }
        Ok(local_first_task_runtime::broker::EnqueueTurnOutcome::SteeringQueued {
            thread_id,
            active_turn_id,
            steering,
        }) => {
            publish_app_event(serde_json::json!({
                "type": "thread.steering_changed",
                "thread_id": thread_id,
                "steering_id": steering.steering_id,
                "revision": steering.revision,
            }));
            Ok((
                StatusCode::ACCEPTED,
                Json(serde_json::json!({
                    "thread_id": thread_id,
                    "active_turn_id": active_turn_id,
                    "request_id": request_id,
                    "source_message_id": steering.source_message_id,
                    "objective_revision": steering.objective_revision,
                    "status": "steering_queued",
                    "steering": steering,
                })),
            ))
        }
        Err(local_first_task_runtime::broker::EnqueueError::ThreadBusy {
            thread_id,
            active_turn_id,
        }) => {
            tracing::warn!(
                target: "broker::enqueue",
                thread_id = %thread_id,
                active_turn_id = %active_turn_id,
                "turn rejected (409) — thread already has an active turn"
            );
            Ok((
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "thread_busy",
                    "thread_id": thread_id,
                    "active_turn_id": active_turn_id,
                })),
            ))
        }
        Err(local_first_task_runtime::broker::EnqueueError::Store(e)) => Err(GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "broker_enqueue_store",
            message: format!("enqueue store error: {e}"),
        }),
    }
}

/// GET /api/chat/turns/{turn_id} — turn status.
pub(crate) async fn get_turn(
    Path(turn_id): Path<String>,
    State(state): State<AppState>,
    Query(query): Query<TurnSinceQuery>,
) -> Result<Json<Value>, GatewayError> {
    let store = state.task_store.lock().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "broker_store_lock",
        message: format!("lock: {e}"),
    })?;
    let user_id = gateway_user_id();
    let workspace_id = resolve_turn_workspace(&query);
    let task_id = TaskId::new(&turn_id);
    let task = match store
        .get_task(&task_id, &user_id, &workspace_id)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "broker_get",
            message: format!("{e}"),
        })? {
        Some(task) => task,
        None if query
            .workspace
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty()) =>
        {
            store
                .tasks_for_user_by_id(&task_id, &user_id)
                .map_err(|e| GatewayError {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    code: "broker_get",
                    message: format!("{e}"),
                })?
                .into_iter()
                .find(|candidate| candidate.workspace_id.as_str() == workspace_id.as_str())
                .ok_or_else(|| GatewayError {
                    status: StatusCode::NOT_FOUND,
                    code: "turn_not_found",
                    message: format!("turn {turn_id} not found"),
                })?
        }
        None => {
            return Err(GatewayError {
                status: StatusCode::NOT_FOUND,
                code: "turn_not_found",
                message: format!("turn {turn_id} not found"),
            });
        }
    };
    let status =
        visible_turn_status(&store, task_id.as_str(), task.status).map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "broker_get_events",
            message: format!("{e}"),
        })?;
    Ok(Json(serde_json::json!({
        "turn_id": turn_id,
        "thread_id": task.input_json.get("thread_id").and_then(|v| v.as_str()),
        "request_id": task.input_json.get("request_id").and_then(|v| v.as_str()),
        "status": status,
        "priority": format!("{:?}", task.priority).to_lowercase(),
        "source": task.input_json.get("source").and_then(|v| v.as_str()),
        "created_at": task.created_at.unix_timestamp(),
        "updated_at": task.updated_at.unix_timestamp(),
    })))
}

fn visible_turn_status(
    store: &local_first_task_runtime::TaskStore,
    turn_id: &str,
    task_status: local_first_task_runtime::TaskStatus,
) -> Result<&'static str, local_first_task_runtime::TaskRuntimeError> {
    use local_first_task_runtime::ReducedTurnStatus;

    let events = store.read_turn_events(turn_id, 0)?;
    let reduced = local_first_task_runtime::reduce_turn_events(&events);
    let status = match reduced.status {
        ReducedTurnStatus::Completed => "completed",
        ReducedTurnStatus::Failed => "failed",
        ReducedTurnStatus::Cancelled => "cancelled",
        ReducedTurnStatus::WaitingUser
            if task_status == local_first_task_runtime::TaskStatus::WaitingUserApproval =>
        {
            "waiting_user"
        }
        ReducedTurnStatus::WaitingUser => task_status.as_str(),
        ReducedTurnStatus::WaitingApproval => "waiting_user_approval",
        ReducedTurnStatus::Empty | ReducedTurnStatus::Running => task_status.as_str(),
    };
    Ok(status)
}

/// Cancels a chat_turn task via the broker AND finalizes its assistant bubble
/// (`MessageDeliveryState::Cancelled`) in the SAME call — every cancel entry point
/// (`cancel_turn`, `cancel_task`) routes through this now (converge, don't
/// duplicate) so bubble treatment cannot silently diverge between them again.
///
/// When the cancel inserted the canonical `cancelled` terminal event, this helper
/// ALSO broadcasts it live (per-turn NDJSON channel + unified WS) — the executor's
/// later `emit_turn_event(Cancelled)` is silenced by the terminal-once guard
/// because this path persisted the event first, so without this broadcast the UI
/// would never see the terminal state.
///
/// For a `Running` turn the execution runtime commits `Cancelled(User)` after
/// its cancel race unwinds and the canonical projector repeats the same message
/// state idempotently.
///
/// For a `Parked` turn (steering park+resume, Build 2) there is NO live executor —
/// it was unregistered and its agent_run aborted at park time — so nothing else
/// will EVER flip that bubble out of its open "waiting for the model" state. Before
/// this helper existed, `cancel_task` (the Workbench "Attività" tab's cancel,
/// unlike `cancel_turn`) skipped this step entirely, leaving a permanent ghost
/// bubble on cancel-of-parked. `task_before_cancel` is the task snapshot fetched
/// BEFORE calling this (its `thread_id`/`assistant_message_id` don't change on
/// cancel, so re-fetching after would be redundant). Returns whatever
/// `cancel_chat_turn` returned (`false` = already terminal or missing).
pub(crate) fn cancel_chat_turn_and_finalize_bubble(
    state: &AppState,
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    task_id: &TaskId,
    task_before_cancel: Option<&TaskRecord>,
) -> local_first_task_runtime::TaskRuntimeResult<bool> {
    let outcome = local_first_task_runtime::broker::cancel_chat_turn(
        store,
        user_id,
        workspace_id,
        task_id,
        &crate::turn_executor::GatewayCancelNotify,
    )?;
    if outcome.cancelled {
        // This call inserted the canonical `cancelled` terminal event, so it owns
        // the live fan-out (same envelope/shape as `emit_turn_event`): the executor
        // racing to emit `Cancelled` afterwards hits `TerminalWrite::Existing` and
        // stays silent. `None` means a racing writer already persisted the terminal
        // event and broadcast it — do not double-broadcast.
        if let Some(event) = outcome.terminal_event.as_ref() {
            crate::turn_executor::broadcast_turn_event(state, task_id.as_str(), event);
        }
        if let Some(task) = task_before_cancel {
            set_chat_turn_message_delivery_state(
                state,
                task,
                local_first_desktop_gateway::MessageDeliveryState::Cancelled,
            );
        }
    }
    Ok(outcome.cancelled)
}

/// DELETE /api/chat/turns/{turn_id} — cancel a turn (idempotent). 202 if cancelled,
/// 404 if the turn does not exist or is already terminal.
pub(crate) async fn cancel_turn(
    Path(turn_id): Path<String>,
    State(state): State<AppState>,
    Query(query): Query<TurnSinceQuery>,
) -> Result<StatusCode, GatewayError> {
    let store = state.task_store.lock().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "broker_store_lock",
        message: format!("lock: {e}"),
    })?;
    let user_id = gateway_user_id();
    let workspace_id = resolve_turn_workspace(&query);
    let task_id = TaskId::new(&turn_id);
    let delivery_task = store
        .get_task(&task_id, &user_id, &workspace_id)
        .ok()
        .flatten();
    let ok = cancel_chat_turn_and_finalize_bubble(
        &state,
        &store,
        &user_id,
        &workspace_id,
        &task_id,
        delivery_task.as_ref(),
    )
    .map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "broker_cancel",
        message: format!("{e}"),
    })?;
    let held_steering = delivery_task
        .as_ref()
        .and_then(|task| task.input_json.get("thread_id").and_then(Value::as_str))
        .and_then(|thread_id| {
            store
                .list_turn_steering(user_id.as_str(), workspace_id.as_str(), thread_id)
                .ok()
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|row| {
            row.active_turn_id == turn_id
                && row.status == local_first_task_runtime::TurnSteeringStatus::Held
        })
        .collect::<Vec<_>>();
    drop(store);
    for steering in &held_steering {
        publish_steering_changed(steering);
    }
    Ok(if ok {
        StatusCode::ACCEPTED
    } else {
        StatusCode::NOT_FOUND
    })
}

/// Query params for turn inspection/cancel/events/stream endpoints.
#[derive(Debug, Clone, Deserialize, Default)]
pub(crate) struct TurnSinceQuery {
    #[serde(default)]
    pub(crate) since: Option<i64>,
    #[serde(default)]
    pub(crate) workspace: Option<String>,
}

pub(crate) fn resolve_turn_workspace(query: &TurnSinceQuery) -> WorkspaceId {
    query
        .workspace
        .as_deref()
        .map(str::trim)
        .filter(|workspace| !workspace.is_empty())
        .map(WorkspaceId::new)
        .unwrap_or_else(gateway_workspace_id)
}

pub(crate) fn execution_thread_workspace(
    state: &AppState,
    thread_id: &str,
) -> Result<String, GatewayError> {
    let store = lock_store(state)?;
    let exists = store.thread(thread_id).map_err(|_| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "agent_thread_not_found",
        message: "thread not found".to_string(),
    })?;
    if exists.is_none() {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "agent_thread_not_found",
            message: "thread not found".to_string(),
        });
    }
    store
        .workspace_for_thread(thread_id)
        .map_err(|_| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "agent_thread_not_found",
            message: "thread not found".to_string(),
        })
}

pub(crate) fn set_chat_turn_message_delivery_state(
    state: &AppState,
    task: &TaskRecord,
    delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) {
    if task.kind != "chat_turn" {
        return;
    }
    let Some(thread_id) = task
        .input_json
        .get("thread_id")
        .and_then(|value| value.as_str())
    else {
        return;
    };
    let Some(message_id) = task
        .input_json
        .get("assistant_message_id")
        .and_then(|value| value.as_str())
    else {
        return;
    };
    if let Ok(store) = lock_store(state) {
        let _ = store.set_message_delivery_state(thread_id, message_id, delivery_state);
    }
}

pub(crate) async fn get_thread_agent_runs(
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<local_first_task_runtime::AgentRun>>, GatewayError> {
    let workspace = execution_thread_workspace(&state, &thread_id)?;
    let runs = lock_task_store(&state)?
        .list_agent_runs_for_thread(&thread_id, gateway_user_id().as_str(), &workspace)
        .map_err(GatewayError::task)?;
    Ok(Json(runs))
}

pub(crate) async fn get_thread_runtime_plan(
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Value>, GatewayError> {
    let workspace = execution_thread_workspace(&state, &thread_id)?;
    let plan = lock_task_store(&state)?
        .load_runtime_plan(gateway_user_id().as_str(), &workspace, &thread_id)
        .map_err(GatewayError::task)?;
    Ok(Json(serde_json::to_value(plan).unwrap_or(Value::Null)))
}

pub(crate) async fn get_thread_runtime_context(
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<runtime_context::RuntimeContextResponse>, GatewayError> {
    let workspace = execution_thread_workspace(&state, &thread_id)?;
    let user_id = gateway_user_id();
    let (run, prompt_snapshot, compacted) = {
        let store = lock_task_store(&state)?;
        let run = store
            .list_agent_runs_for_thread(&thread_id, user_id.as_str(), &workspace)
            .map_err(GatewayError::task)?
            .into_iter()
            .next();
        let Some(run) = run else {
            if store
                .has_agent_runs_for_thread(&thread_id)
                .map_err(GatewayError::task)?
            {
                return Err(GatewayError {
                    status: StatusCode::NOT_FOUND,
                    code: "runtime_context_not_found",
                    message: "runtime context not found".to_string(),
                });
            }
            return Ok(Json(runtime_context::RuntimeContextResponse::unavailable()));
        };
        let prompt_snapshot = store
            .latest_agent_prompt_snapshot(&run.run_id, user_id.as_str(), &workspace)
            .map_err(GatewayError::task)?
            .map(|event| event.payload);
        let compacted = store
            .list_agent_run_events(&run.run_id, user_id.as_str(), &workspace, None)
            .map_err(GatewayError::task)?
            .iter()
            .any(|event| event.kind == "context_compacted");
        (Some(run), prompt_snapshot, compacted)
    };
    let usage = state
        .usage_store
        .lock()
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "runtime_context_usage_lock",
            message: format!("lock: {error}"),
        })?
        .run_token_usage(
            user_id.as_str(),
            &workspace,
            run.as_ref()
                .map(|run| run.run_id.as_str())
                .unwrap_or_default(),
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "runtime_context_usage",
            message: error.to_string(),
        })?;
    Ok(Json(runtime_context::project_runtime_context(
        run.as_ref(),
        prompt_snapshot.as_ref(),
        compacted,
        usage.as_ref(),
        &load_provider_registry(),
    )))
}

pub(crate) async fn get_thread_working_ledger(
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Value>, GatewayError> {
    let workspace = execution_thread_workspace(&state, &thread_id)?;
    let store = lock_task_store(&state)?;
    let markdown =
        working_ledger::render(&store, gateway_user_id().as_str(), &workspace, &thread_id)
            .map_err(|message| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "working_ledger_render",
                message,
            })?;
    Ok(Json(
        serde_json::json!({"thread_id": thread_id, "markdown": markdown}),
    ))
}

pub(crate) async fn get_latest_agent_checkpoint(
    Path(run_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<local_first_task_runtime::AgentCheckpoint>, GatewayError> {
    let store = lock_task_store(&state)?;
    let user = gateway_user_id();
    let workspace = store
        .workspace_for_agent_run(&run_id, user.as_str())
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "agent_checkpoint_not_found",
            message: "checkpoint not found".to_string(),
        })?;
    let checkpoint = store
        .latest_agent_checkpoint(&run_id, user.as_str(), &workspace)
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "agent_checkpoint_not_found",
            message: "checkpoint not found".to_string(),
        })?;
    Ok(Json(checkpoint))
}

/// GET /api/chat/turns/{turn_id}/runs — ordered broker attempts for the authenticated scope.
pub(crate) async fn get_agent_runs(
    Path(turn_id): Path<String>,
    State(state): State<AppState>,
    Query(query): Query<TurnSinceQuery>,
) -> Result<Json<Vec<local_first_task_runtime::AgentRun>>, GatewayError> {
    let store = state.task_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "agent_run_store_lock",
        message: format!("lock: {error}"),
    })?;
    let workspace_id = resolve_turn_workspace(&query);
    let runs = store
        .list_agent_runs_for_turn(&turn_id, gateway_user_id().as_str(), workspace_id.as_str())
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "agent_run_list",
            message: error.to_string(),
        })?;
    if runs.is_empty() {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "agent_run_not_found",
            message: "agent run not found".to_string(),
        });
    }
    Ok(Json(runs))
}

/// GET /api/chat/runs/{run_id}/events — append-only internal events after the cursor.
pub(crate) async fn get_agent_run_events(
    Path(run_id): Path<String>,
    State(state): State<AppState>,
    Query(query): Query<TurnSinceQuery>,
) -> Result<Json<Vec<local_first_task_runtime::AgentRunEvent>>, GatewayError> {
    if query.since.is_some_and(|since| since < 0) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "agent_run_cursor_invalid",
            message: "since must be zero or greater".to_string(),
        });
    }
    let store = state.task_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "agent_run_store_lock",
        message: format!("lock: {error}"),
    })?;
    let user_id = gateway_user_id();
    let workspace_id = store
        .workspace_for_agent_run(&run_id, user_id.as_str())
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "agent_run_not_found",
            message: "agent run not found".to_string(),
        })?;
    let runs = store
        .list_agent_run_events(&run_id, user_id.as_str(), &workspace_id, query.since)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "agent_run_events",
            message: error.to_string(),
        })?;
    // An empty cursor page is valid only when the run itself exists in this scope.
    if runs.is_empty()
        && store
            .latest_agent_prompt_snapshot(&run_id, user_id.as_str(), &workspace_id)
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "agent_run_lookup",
                message: error.to_string(),
            })?
            .is_none()
    {
        let scoped_run_exists = store
            .list_agent_run_events(&run_id, user_id.as_str(), &workspace_id, None)
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "agent_run_lookup",
                message: error.to_string(),
            })?
            .into_iter()
            .any(|event| event.kind == "run_started");
        if !scoped_run_exists {
            return Err(GatewayError {
                status: StatusCode::NOT_FOUND,
                code: "agent_run_not_found",
                message: "agent run not found".to_string(),
            });
        }
    }
    Ok(Json(runs))
}

/// GET /api/chat/runs/{run_id}/prompt/latest — latest redacted model-visible request only.
pub(crate) async fn get_latest_agent_prompt(
    Path(run_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Value>, GatewayError> {
    let store = state.task_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "agent_run_store_lock",
        message: format!("lock: {error}"),
    })?;
    let user = gateway_user_id();
    let workspace = store
        .workspace_for_agent_run(&run_id, user.as_str())
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "agent_run_not_found",
            message: "agent run not found".to_string(),
        })?;
    let event = store
        .latest_agent_prompt_snapshot(&run_id, user.as_str(), &workspace)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "agent_prompt_latest",
            message: error.to_string(),
        })?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "agent_run_not_found",
            message: "agent run or prompt snapshot not found".to_string(),
        })?;
    let mut payload = event.payload;
    if let Value::Object(object) = &mut payload {
        object.insert("run_id".to_string(), Value::String(event.run_id));
        object.insert("seq".to_string(), Value::from(event.seq));
        object.insert(
            "round".to_string(),
            serde_json::to_value(event.round).unwrap_or(Value::Null),
        );
        object.insert("created_at".to_string(), Value::from(event.created_at));
    }
    Ok(Json(payload))
}

/// GET /api/chat/turns/{turn_id}/events — batch read of events with seq > ?since=.
pub(crate) async fn get_turn_events(
    Path(turn_id): Path<String>,
    State(state): State<AppState>,
    Query(query): Query<TurnSinceQuery>,
) -> Result<Json<Vec<Value>>, GatewayError> {
    let since = query.since.unwrap_or(0);
    let store = state.task_store.lock().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "broker_store_lock",
        message: format!("lock: {e}"),
    })?;
    let events = store
        .read_turn_events(&turn_id, since)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "broker_events",
            message: format!("{e}"),
        })?;
    let out: Vec<_> = events
        .into_iter()
        .map(|e| {
            serde_json::json!({
                "seq": e.seq,
                "kind": e.kind.as_str(),
                "payload": e.payload,
                "created_at": e.created_at,
            })
        })
        .collect();
    Ok(Json(out))
}

/// GET /api/chat/threads/{thread_id}/kernel-projection — canonical Runtime V2 thread
/// projection. This is the backend-owned contract for turn status, plan, activity,
/// attention, browser, capability runtime, and composer actions.
pub(crate) async fn thread_kernel_projection(
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<local_first_task_runtime::KernelThreadProjection>, GatewayError> {
    let store = state.task_store.lock().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "broker_store_lock",
        message: format!("lock: {e}"),
    })?;
    let projection = store
        .project_kernel_thread(&thread_id, 200)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "thread_kernel_projection",
            message: format!("{e}"),
        })?;
    Ok(Json(projection))
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SteeringMutationRequest {
    expected_revision: u64,
    prompt: String,
    visible_prompt: String,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default = "empty_json_array")]
    attachments: Value,
    mode: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SteeringRevisionRequest {
    expected_revision: u64,
}

pub(crate) fn empty_json_array() -> Value {
    Value::Array(Vec::new())
}

pub(crate) fn publish_steering_changed(record: &local_first_task_runtime::TurnSteeringRecord) {
    publish_app_event(serde_json::json!({
        "type": "thread.steering_changed",
        "thread_id": record.thread_id,
        "steering_id": record.steering_id,
        "revision": record.revision,
    }));
}

/// Close every steering row still waiting on a turn that has ended.
///
/// A row left `pending`/`held` when its turn finishes is unappliable - its target turn is over - but
/// it stays visible to the NEXT turn's finalization fence, which then waits its full budget and parks.
/// One instruction the semantic coordinator could not interpret therefore broke every subsequent turn
/// in the thread, each time looking like a fresh hang. Cancelling is the honest state: the instruction
/// never ran, and the user can restate it; leaving it pending is strictly worse, because it cannot ever
/// be applied and it disables the thread.
///
/// Best-effort and non-fatal by design: this is a cleanup fence on the way out of a turn, so a store
/// error must never propagate into (or fail) the turn that just finished - it is logged instead.
pub(crate) fn finalize_turn_steering(
    state: &AppState,
    thread_id: Option<&str>,
    turn_id: &str,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
) {
    let Some(thread_id) = thread_id.filter(|id| !id.trim().is_empty()) else {
        return;
    };
    let Ok(store) = state.task_store.lock() else {
        return;
    };
    let (user_id, workspace_id) = (user_id.as_str(), workspace_id.as_str());
    let Ok(before) = store.list_turn_steering(user_id, workspace_id, thread_id) else {
        return;
    };
    let changed =
        match store.close_unsettled_turn_steering(user_id, workspace_id, thread_id, turn_id) {
            Ok(changed) => changed,
            Err(error) => {
                tracing::warn!(
                    target: "steering::finalize",
                    turn_id,
                    %error,
                    "could not close steering rows left unsettled by a finished turn"
                );
                return;
            }
        };
    if changed == 0 {
        return;
    }
    let Ok(after) = store.list_turn_steering(user_id, workspace_id, thread_id) else {
        tracing::warn!(
            target: "steering::finalize",
            turn_id,
            "closed steering rows left unsettled by a finished turn but could not reload them for publication"
        );
        return;
    };
    for record in after {
        if record.active_turn_id != turn_id || record.status.as_str() != "cancelled" {
            continue;
        }
        let changed_status = before
            .iter()
            .any(|old| old.steering_id == record.steering_id && old.status != record.status);
        if !changed_status {
            continue;
        }
        tracing::warn!(
            target: "steering::finalize",
            steering_id = record.steering_id,
            turn_id,
            "closed a steering row left unsettled by a finished turn"
        );
        publish_steering_changed(&record);
    }
}

pub(crate) fn steering_mutation_result(
    result: local_first_task_runtime::TaskRuntimeResult<
        local_first_task_runtime::TurnSteeringRecord,
    >,
    store: &TaskStore,
    steering_id: i64,
    user_id: &str,
    workspace_id: &str,
) -> Result<(StatusCode, Json<Value>), GatewayError> {
    match result {
        Ok(record) => {
            publish_steering_changed(&record);
            Ok((
                StatusCode::OK,
                Json(serde_json::to_value(record).unwrap_or(Value::Null)),
            ))
        }
        Err(local_first_task_runtime::TaskRuntimeError::Conflict(_)) => {
            let current = store
                .load_turn_steering(steering_id, user_id, workspace_id)
                .map_err(GatewayError::task)?;
            Ok((
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "code": "steering_revision_conflict",
                    "steering": current,
                })),
            ))
        }
        Err(error) => Err(GatewayError::task(error)),
    }
}

pub(crate) async fn list_thread_steering(
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<local_first_task_runtime::TurnSteeringRecord>>, GatewayError> {
    let workspace = execution_thread_workspace(&state, &thread_id)?;
    let rows = lock_task_store(&state)?
        .list_turn_steering(gateway_user_id().as_str(), &workspace, &thread_id)
        .map_err(GatewayError::task)?;
    Ok(Json(rows))
}

pub(crate) async fn update_steering(
    Path(steering_id): Path<i64>,
    State(state): State<AppState>,
    Json(request): Json<SteeringMutationRequest>,
) -> Result<(StatusCode, Json<Value>), GatewayError> {
    let user = gateway_user_id();
    let store = lock_task_store(&state)?;
    let workspace = store
        .workspace_for_turn_steering(steering_id, user.as_str())
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "steering_not_found",
            message: "steering not found".into(),
        })?;
    let current = store
        .load_turn_steering(steering_id, user.as_str(), &workspace)
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "steering_not_found",
            message: "steering not found".into(),
        })?;
    let input = local_first_task_runtime::NewTurnSteering {
        source_message_id: current.source_message_id,
        prompt: request.prompt,
        visible_prompt: request.visible_prompt,
        images: request.images,
        attachments: request.attachments,
        mode: request.mode,
        model: request.model,
    };
    let result = store.update_turn_steering(
        steering_id,
        user.as_str(),
        &workspace,
        request.expected_revision,
        &input,
    );
    steering_mutation_result(result, &store, steering_id, user.as_str(), &workspace)
}

pub(crate) async fn delete_steering(
    Path(steering_id): Path<i64>,
    State(state): State<AppState>,
    Json(request): Json<SteeringRevisionRequest>,
) -> Result<(StatusCode, Json<Value>), GatewayError> {
    let user = gateway_user_id();
    let store = lock_task_store(&state)?;
    let workspace = store
        .workspace_for_turn_steering(steering_id, user.as_str())
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "steering_not_found",
            message: "steering not found".into(),
        })?;
    let result = store.cancel_turn_steering(
        steering_id,
        user.as_str(),
        &workspace,
        request.expected_revision,
    );
    steering_mutation_result(result, &store, steering_id, user.as_str(), &workspace)
}

pub(crate) async fn send_steering_now(
    Path(steering_id): Path<i64>,
    State(state): State<AppState>,
    Json(request): Json<SteeringRevisionRequest>,
) -> Result<(StatusCode, Json<Value>), GatewayError> {
    let user = gateway_user_id();
    let store = lock_task_store(&state)?;
    let workspace = store
        .workspace_for_turn_steering(steering_id, user.as_str())
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "steering_not_found",
            message: "steering not found".into(),
        })?;
    let workspace_id = WorkspaceId::new(&workspace);
    let result = local_first_task_runtime::broker::promote_held_turn_steering(
        &store,
        &user,
        &workspace_id,
        steering_id,
        request.expected_revision,
        insert_broker_turn_messages,
    );
    match result {
        Ok(promoted) => {
            publish_steering_changed(&promoted.steering);
            Ok((
                StatusCode::CREATED,
                Json(serde_json::json!({
                    "turn_id": promoted.turn.task_id.as_str(),
                    "thread_id": promoted.turn.thread_id,
                    "status": "queued",
                    "position_in_queue": promoted.turn.position_in_queue,
                    "steering": promoted.steering,
                })),
            ))
        }
        Err(local_first_task_runtime::broker::EnqueueError::Store(
            local_first_task_runtime::TaskRuntimeError::Conflict(_),
        )) => {
            let current = store
                .load_turn_steering(steering_id, user.as_str(), &workspace)
                .map_err(GatewayError::task)?;
            Ok((
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "code": "steering_revision_conflict",
                    "steering": current,
                })),
            ))
        }
        Err(error) => Err(GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "steering_send_now",
            message: error.to_string(),
        }),
    }
}

/// GET /api/chat/turns/{turn_id}/stream — replay buffered events (seq > since) then
/// forward live broadcast events, as NDJSON. Mirrors `resume_stream` /
/// `ndjson_body_for_entry`: the broadcast subscription is taken BEFORE the DB
/// snapshot so a subscriber neither misses nor duplicates an event. The executor
/// always persists THEN broadcasts (`emit_turn_event`), so subscribe-first +
/// dedup-by-seq closes the race window. If no live broadcast exists (turn not
/// running, or already finished) the stream still serves the replay and then ends.
pub(crate) async fn subscribe_turn_stream(
    Path(turn_id): Path<String>,
    State(state): State<AppState>,
    Query(query): Query<TurnSinceQuery>,
) -> Result<Response, GatewayError> {
    let since = query.since.unwrap_or(0);

    // 1) Subscribe to the live broadcast FIRST. broadcast::subscribe only yields
    //    events sent after this call, so we must subscribe before reading the DB to
    //    avoid losing an event that lands between snapshot and subscribe. The
    //    overlap (events in both the snapshot and the broadcast) is deduped below.
    let live_rx = crate::turn_executor::turn_broadcast_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&turn_id).map(|b| b.tx.subscribe()));

    // 2) Replay snapshot from the DB (the durable source of truth) — hold the store
    //    lock only as long as needed to read. `max_seq` is the highest seq delivered
    //    in the replay, used to dedup the live tail.
    let (replay, max_seq) = {
        let store = state.task_store.lock().map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "broker_store_lock",
            message: format!("lock: {e}"),
        })?;
        let events = store
            .read_turn_events(&turn_id, since)
            .map_err(|e| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "broker_events",
                message: format!("{e}"),
            })?;
        let max = events.last().map(|e| e.seq).unwrap_or(since);
        let lines: Vec<String> = events
            .into_iter()
            .map(|e| {
                serde_json::to_string(&serde_json::json!({
                    "seq": e.seq,
                    "kind": e.kind.as_str(),
                    "payload": e.payload,
                    "created_at": e.created_at,
                }))
                .unwrap_or_else(|_| "{}".to_string())
            })
            .collect();
        (lines, max)
    };

    // 3) Build the mpsc → Body stream: push replay first, then forward live events,
    //    deduping any event the snapshot already delivered (seq <= max_seq).
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(64);
    tokio::spawn(async move {
        // Replay.
        for line in &replay {
            if tx.send(Ok(Bytes::from(format!("{line}\n")))).await.is_err() {
                return;
            }
        }
        // Live fan-out (only if a broadcast exists).
        if let Some(mut brx) = live_rx {
            loop {
                match brx.recv().await {
                    Ok(ev) => {
                        // Dedup against the replay snapshot: an event persisted right
                        // before the DB read was also broadcast right after, so it can
                        // show up in both. Drop the duplicate; live must be strictly >.
                        if ev.seq <= max_seq {
                            continue;
                        }
                        let line = match serde_json::to_string(&serde_json::json!({
                            "seq": ev.seq,
                            "kind": ev.kind,
                            "payload": ev.payload,
                        })) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        if tx.send(Ok(Bytes::from(format!("{line}\n")))).await.is_err() {
                            return;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    });

    let body = Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    }));
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .header("cache-control", "no-cache")
        .body(body)
        .expect("valid streaming response"))
}

// ── Step-advance visible event emission ─────────────────────────────────────
//
// When a plan step's canonical status changes (the `update_plan`/`step_advance` arm
// after F2, or the engine's evidence-verified frontier advance), emit a
// `GenerateStreamEvent::StepAdvance` so the frontend can render it inline in the chat
// stream — distinct from the full ‹‹PLAN›› card. It rides the SAME stream channel as
// every other turn event (the drain maps it via `turn_event_from_stream_value` to the
// durable `step_advance` TurnEventKind: store + live broadcast + unified WS).

/// Build a human-readable message for a step advance event (default `note` when the
/// caller doesn't carry a more specific one).
pub(crate) fn step_advance_message(step_id: &str, step_title: &str, status: &str) -> String {
    let status_label = match status {
        "done" => "completed",
        "doing" => "in progress",
        "blocked" => "blocked",
        "todo" => "pending",
        other => other,
    };
    if step_title.is_empty() {
        format!("Step {step_id}: {status_label}")
    } else {
        format!("Step {step_id} {status_label}: {step_title}")
    }
}

/// Emit a visible `StepAdvance` turn event for a single plan step status change.
/// PAYLOAD CONTRACT with the frontend (do NOT deviate):
/// `{"step_id": string, "title": string, "from": string|null, "to": string,
/// "verified": bool|null, "note": string|null}` — `from` is null for a brand-new step,
/// `verified` is the F2 verdict (null for plain status moves), `note` carries the
/// rejection reason on a failed F2 claim. Emitted on the turn's stream sink so it
/// fans out through the exact same path as every other turn event (durable store +
/// live broadcast + unified WS) with the turn's own id.
pub(crate) async fn emit_step_advance_event(
    tx: &StreamSink,
    step_id: &str,
    step_title: &str,
    from: Option<&str>,
    to: &str,
    verified: Option<bool>,
    note: Option<&str>,
) {
    let note = note
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| step_advance_message(step_id, step_title, to));
    let _ = emit_stream_event(
        tx,
        GenerateStreamEvent::StepAdvance {
            step_id: step_id.to_string(),
            title: step_title.to_string(),
            from: from.map(str::to_string),
            to: to.to_string(),
            verified,
            note: Some(note),
        },
    )
    .await;
}

// ── Heartbeat during model wait ─────────────────────────────────────────────
//
// When the model is processing for a long time (>15s with no streaming tokens),
// emit periodic `Heartbeat` events so the frontend can show "still thinking…"
// instead of an indefinite spinner. The heartbeat is cancelled when tokens
// resume or the turn ends.

/// Interval between heartbeat events during model wait.
// Plan deliverable: wired once the turn loop spawns model-wait heartbeats.
#[allow(dead_code)]
const HEARTBEAT_INTERVAL_SECS: u64 = 15;

/// Spawn a background task that emits `Heartbeat` turn events every
/// [`HEARTBEAT_INTERVAL_SECS`] seconds. Returns a [`tokio::task::JoinHandle`]
/// the caller MUST abort when the model starts responding or the turn ends.
///
/// The heartbeat carries `elapsed_seconds` (since the heartbeat started) and
/// `round` (the current agent round, if known) so the UI can surface progress
/// without blocking on the model.
// Plan deliverable: wired once the turn loop spawns model-wait heartbeats.
#[allow(dead_code)]
pub(crate) fn spawn_model_wait_heartbeat(
    state: AppState,
    turn_id: String,
    round: Option<u32>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(tokio::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
        // The first tick fires immediately; skip it.
        interval.tick().await;
        let start = std::time::Instant::now();
        loop {
            interval.tick().await;
            let elapsed = start.elapsed().as_secs();
            let payload = serde_json::json!({
                "elapsed_seconds": elapsed,
                "round": round,
            });
            if let Ok(store) = state.task_store.lock() {
                if crate::turn_executor::emit_turn_event(
                    &state,
                    &store,
                    &turn_id,
                    local_first_task_runtime::TurnEventKind::Heartbeat,
                    payload,
                )
                .is_err()
                {
                    // Store gone (turn ended) — stop quietly.
                    return;
                }
            } else {
                return;
            }
        }
    })
}

#[cfg(test)]
mod broker_event_tests {
    use super::*;

    #[test]
    fn step_advance_message_done_includes_title_and_status() {
        let msg = step_advance_message("s2", "Implement data models", "done");
        assert_eq!(msg, "Step s2 completed: Implement data models");
    }

    #[test]
    fn step_advance_message_doing_in_progress() {
        let msg = step_advance_message("s1", "Set up project", "doing");
        assert_eq!(msg, "Step s1 in progress: Set up project");
    }

    #[test]
    fn step_advance_message_blocked() {
        let msg = step_advance_message("s3", "Deploy", "blocked");
        assert_eq!(msg, "Step s3 blocked: Deploy");
    }

    #[test]
    fn step_advance_message_empty_title_falls_back_to_id() {
        let msg = step_advance_message("s5", "", "done");
        assert_eq!(msg, "Step s5: completed");
    }

    #[test]
    fn step_advance_message_unknown_status_passthrough() {
        let msg = step_advance_message("s1", "Test", "custom");
        assert_eq!(msg, "Step s1 custom: Test");
    }

    #[test]
    fn step_advance_turn_event_kind_round_trips() {
        let kind = local_first_task_runtime::TurnEventKind::StepAdvance;
        assert_eq!(kind.as_str(), "step_advance");
        assert_eq!(
            local_first_task_runtime::TurnEventKind::parse("step_advance"),
            Some(kind)
        );
    }

    #[test]
    fn heartbeat_turn_event_kind_round_trips() {
        let kind = local_first_task_runtime::TurnEventKind::Heartbeat;
        assert_eq!(kind.as_str(), "heartbeat");
        assert_eq!(
            local_first_task_runtime::TurnEventKind::parse("heartbeat"),
            Some(kind)
        );
    }

    #[test]
    fn heartbeat_interval_is_fifteen_seconds() {
        assert_eq!(HEARTBEAT_INTERVAL_SECS, 15);
    }
}

#[cfg(test)]
mod kernel_projection_route_tests {
    use super::*;
    use local_first_task_runtime::{
        AgentRunStatus, NewAgentRun, TaskPriority, TaskRecord, TaskStatus, TurnEventKind,
    };

    #[tokio::test]
    async fn kernel_projection_route_returns_terminal_actions() {
        let state = AppState::for_tests();
        {
            let store = state.task_store.lock().unwrap();
            let mut task = TaskRecord::new(
                "turn-kernel-route",
                gateway_user_id(),
                gateway_workspace_id(),
                "chat_turn",
                "seed terminal projection",
                serde_json::json!({}),
            );
            task.status = TaskStatus::Running;
            task.priority = TaskPriority::High;
            store
                .insert_chat_turn(
                    &task,
                    "thread-kernel-route",
                    "req-kernel-route",
                    "interactive",
                    "full",
                )
                .unwrap();
            store
                .insert_turn_event(
                    "turn-kernel-route",
                    TurnEventKind::Done,
                    serde_json::json!({"text": "done"}),
                )
                .unwrap();
            store
                .create_agent_run(&NewAgentRun {
                    run_id: "run-kernel-route".into(),
                    turn_id: "turn-kernel-route".into(),
                    thread_id: "thread-kernel-route".into(),
                    user_id: gateway_user_id().as_str().to_string(),
                    workspace_id: gateway_workspace_id().as_str().to_string(),
                    role: None,
                    model: Some("test-model".into()),
                    provider: Some("test-provider".into()),
                    prompt_fingerprint: None,
                })
                .unwrap();
            store
                .finish_agent_run(
                    "run-kernel-route",
                    AgentRunStatus::Completed,
                    Some("canonical_completed"),
                )
                .unwrap();
        }

        let Json(projection) =
            thread_kernel_projection(Path("thread-kernel-route".to_string()), State(state))
                .await
                .unwrap();

        assert_eq!(projection.turn.status, "completed");
        assert_eq!(projection.turn.active_turn_id, None);
        assert!(!projection.actions.can_stop);
        assert_eq!(projection.actions.composer_mode, "new_turn");
    }
}

#[cfg(test)]
mod cancel_broadcast_tests {
    use super::*;
    use local_first_task_runtime::{TaskId, TaskRecord, TaskStatus};

    /// Seeds a Running chat_turn task under `turn_id` (no live executor — the
    /// broadcast-side half of the cancel path is what these tests exercise).
    fn seed_running_turn(state: &AppState, turn_id: &str, thread_id: &str) {
        let store = state.task_store.lock().unwrap();
        let mut task = TaskRecord::new(
            turn_id,
            gateway_user_id(),
            gateway_workspace_id(),
            "chat_turn",
            "seed goal",
            serde_json::json!({ "thread_id": thread_id }),
        );
        task.status = TaskStatus::Running;
        store
            .insert_chat_turn(&task, thread_id, "req-1", "interactive", "full")
            .unwrap();
    }

    /// Regression: the broker persists the `cancelled` terminal event BEFORE the
    /// executor can emit it, so the executor's emit is silenced by the
    /// terminal-once guard — the cancel path itself must broadcast the event on
    /// BOTH live sinks (per-turn NDJSON channel and unified WS), else the UI
    /// never sees the terminal state.
    #[test]
    fn cancel_broadcasts_the_cancelled_terminal_event_on_per_turn_and_ws() {
        let state = AppState::for_tests();
        let turn_id = "turn-cancel-broadcast";
        seed_running_turn(&state, turn_id, "thread-cancel-broadcast");

        let broadcast = crate::turn_executor::register_turn(turn_id);
        let mut ndjson_rx = broadcast.tx.subscribe();
        let (_ws_session, mut ws_rx) = state.ws_registry.register();

        let user_id = gateway_user_id();
        let workspace_id = gateway_workspace_id();
        let task_id = TaskId::new(turn_id);
        let ok = {
            let store = state.task_store.lock().unwrap();
            cancel_chat_turn_and_finalize_bubble(
                &state,
                &store,
                &user_id,
                &workspace_id,
                &task_id,
                None,
            )
            .unwrap()
        };
        assert!(ok);

        // Per-turn NDJSON broadcast channel.
        let received = ndjson_rx
            .try_recv()
            .expect("cancelled on the NDJSON channel");
        assert_eq!(received.kind, "cancelled");
        assert_eq!(
            received.payload.get("reason").and_then(Value::as_str),
            Some("user_cancel")
        );

        // Unified WS (same envelope shape as `emit_turn_event`).
        match ws_rx.try_recv().expect("cancelled on the unified WS") {
            crate::ws_gateway::ServerMessage::TurnEvent {
                turn_id: got_turn_id,
                seq,
                kind,
                payload,
                ..
            } => {
                assert_eq!(got_turn_id, turn_id);
                assert_eq!(kind, "cancelled");
                assert_eq!(seq, received.seq, "both sinks carry the persisted event");
                assert_eq!(
                    payload.get("reason").and_then(Value::as_str),
                    Some("user_cancel")
                );
            }
            other => panic!("expected turn.event on the WS, got {other:?}"),
        }

        // Terminal-once guard intact: the executor's late `Cancelled` emit finds
        // the already-persisted terminal event and broadcasts NOTHING new.
        {
            let store = state.task_store.lock().unwrap();
            crate::turn_executor::emit_turn_event(
                &state,
                &store,
                turn_id,
                local_first_task_runtime::TurnEventKind::Cancelled,
                serde_json::json!({ "reason": "late_executor_cancel" }),
            )
            .unwrap();
        }
        assert!(
            ndjson_rx.try_recv().is_err(),
            "the executor's suppressed emit must not reach the NDJSON channel"
        );
        assert!(
            ws_rx.try_recv().is_err(),
            "the executor's suppressed emit must not reach the WS"
        );

        crate::turn_executor::unregister_turn(turn_id);
    }

    /// A turn without a live per-turn broadcast entry (parked/unregistered) still
    /// publishes its `cancelled` terminal event on the unified WS.
    #[test]
    fn cancel_of_an_unregistered_turn_still_publishes_on_ws() {
        let state = AppState::for_tests();
        let turn_id = "turn-cancel-no-broadcast-entry";
        seed_running_turn(&state, turn_id, "thread-cancel-no-entry");

        let (_ws_session, mut ws_rx) = state.ws_registry.register();

        let ok = {
            let store = state.task_store.lock().unwrap();
            cancel_chat_turn_and_finalize_bubble(
                &state,
                &store,
                &gateway_user_id(),
                &gateway_workspace_id(),
                &TaskId::new(turn_id),
                None,
            )
            .unwrap()
        };
        assert!(ok);

        match ws_rx.try_recv().expect("cancelled on the unified WS") {
            crate::ws_gateway::ServerMessage::TurnEvent {
                turn_id: got_turn_id,
                kind,
                ..
            } => {
                assert_eq!(got_turn_id, turn_id);
                assert_eq!(kind, "cancelled");
            }
            other => panic!("expected turn.event on the WS, got {other:?}"),
        }
    }

    /// A second cancel is idempotent: no new terminal event, no new broadcast.
    #[test]
    fn second_cancel_is_idempotent_and_broadcasts_nothing() {
        let state = AppState::for_tests();
        let turn_id = "turn-cancel-idempotent";
        seed_running_turn(&state, turn_id, "thread-cancel-idempotent");

        let broadcast = crate::turn_executor::register_turn(turn_id);
        let mut ndjson_rx = broadcast.tx.subscribe();
        let (_ws_session, mut ws_rx) = state.ws_registry.register();

        let user_id = gateway_user_id();
        let workspace_id = gateway_workspace_id();
        let task_id = TaskId::new(turn_id);
        let store = state.task_store.lock().unwrap();
        assert!(
            cancel_chat_turn_and_finalize_bubble(
                &state,
                &store,
                &user_id,
                &workspace_id,
                &task_id,
                None,
            )
            .unwrap()
        );
        assert!(ndjson_rx.try_recv().is_ok(), "first cancel broadcasts");
        assert!(ws_rx.try_recv().is_ok());

        assert!(
            !cancel_chat_turn_and_finalize_bubble(
                &state,
                &store,
                &user_id,
                &workspace_id,
                &task_id,
                None,
            )
            .unwrap()
        );
        assert!(
            ndjson_rx.try_recv().is_err(),
            "a no-op cancel must not broadcast"
        );
        assert!(ws_rx.try_recv().is_err());
        drop(store);

        crate::turn_executor::unregister_turn(turn_id);
    }
}
