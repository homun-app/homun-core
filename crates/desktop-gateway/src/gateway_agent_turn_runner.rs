//! Agent turn runner wrappers.
//!
//! Owns the thin bridge that starts a chat generation stream and drains it into
//! a visible assistant message. The canonical loop remains in
//! `stream_chat_via_openai` / `run_agent_rounds`; stream buffering and fanout
//! stay with their existing owners.

use local_first_desktop_gateway::{AttachmentInput, ChatGenerateStreamRequest};

use super::*;

pub(crate) async fn run_agent_turn_into_message(
    state: &AppState,
    thread_id: &str,
    prompt: &str,
    tool_policy: &str,
    source_user_message_id: &str,
    assistant_message_id: &str,
    requested_delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) -> Result<Option<AgentTurnResult>, String> {
    let (base_url, model, api_key) = chat_role_config_for_thread(state, Some(thread_id))
        .ok_or_else(|| "chat role configuration is unavailable".to_string())?;
    log_chat_model_selection(prompt, "chat", &base_url, &model, false);
    let context = agent_turn_context(
        state,
        thread_id,
        &[source_user_message_id, assistant_message_id],
    )
    .ok_or_else(|| "chat context is unavailable".to_string())?;
    let request_id = agent_turn_stream_request_id(assistant_message_id);
    let request = ChatGenerateStreamRequest {
        request_id: request_id.clone(),
        agent_run_id: None,
        agent_checkpoint: None,
        checkpoint_input: None,
        prompt: prompt.to_string(),
        thread_id: Some(thread_id.to_string()),
        context,
        max_context_chars: None,
        model: None,
        images: Vec::new(),
        attachments: Vec::new(),
        max_tokens: 2000,
        temperature: 0.3,
        wait_if_busy: true,
        request_timeout_seconds: None,
        tool_policy: Some(tool_policy.to_string()),
        mode: None,
    };
    let response = stream_chat_via_openai(state, request, base_url, model, api_key)
        .await
        .map_err(|error| error.message)?;
    let entry = stream_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&request_id).cloned());
    let body_task = tokio::spawn(async move {
        let _ = axum::body::to_bytes(response.into_body(), usize::MAX).await;
    });

    let result = match entry {
        Some(entry) => {
            drain_agent_stream_into_message(
                state,
                thread_id,
                assistant_message_id,
                entry,
                requested_delivery_state,
            )
            .await
        }
        None => {
            let _ = body_task.await;
            return Err("stream registration disappeared before draining".to_string());
        }
    };
    let _ = body_task.await;
    result
}

/// Like `run_agent_turn_into_message` but additionally mirrors each stream
/// event into turn_events (durable) + the per-turn broadcast (live) via the
/// fan-out drain. Used by the broker executor path.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_agent_turn_into_message_with_fanout(
    state: &AppState,
    thread_id: &str,
    prompt: &str,
    tool_policy: &str,
    images: Vec<String>,
    attachments: Vec<AttachmentInput>,
    source_user_message_id: &str,
    assistant_message_id: &str,
    turn_id: &str,
    agent_run_id: Option<&str>,
    agent_checkpoint: Option<serde_json::Value>,
    checkpoint_input: Option<serde_json::Value>,
    model_override: Option<&str>,
    requested_delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) -> Result<BrokerAgentTurnResult, String> {
    let (base_url, model, api_key) =
        chat_model_config_for_turn(state, Some(thread_id), model_override)?;
    log_chat_model_selection(
        prompt,
        if model_override
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            "manual"
        } else {
            "chat"
        },
        &base_url,
        &model,
        model_override
            .map(str::trim)
            .is_some_and(|value| !value.is_empty()),
    );
    let context = agent_turn_context(
        state,
        thread_id,
        &[source_user_message_id, assistant_message_id],
    )
    .ok_or_else(|| "chat context is unavailable".to_string())?;
    let request_id = broker_turn_stream_request_id(turn_id);
    let request = ChatGenerateStreamRequest {
        request_id: request_id.clone(),
        agent_run_id: agent_run_id.map(str::to_string),
        agent_checkpoint,
        checkpoint_input,
        prompt: prompt.to_string(),
        thread_id: Some(thread_id.to_string()),
        context,
        max_context_chars: None,
        model: None,
        images,
        attachments,
        max_tokens: 2000,
        temperature: 0.3,
        wait_if_busy: true,
        request_timeout_seconds: None,
        tool_policy: Some(tool_policy.to_string()),
        mode: None,
    };
    let response = stream_chat_via_openai(state, request, base_url, model, api_key)
        .await
        .map_err(|error| error.message)?;
    let entry = stream_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&request_id).cloned());
    if let Some(entry) = entry.as_ref() {
        let stream_buffer_empty = entry
            .lines
            .lock()
            .map(|lines| lines.is_empty())
            .unwrap_or(true);
        if stream_buffer_empty
            && let Some(outcome) = entry.outcome.lock().ok().and_then(|slot| slot.clone())
            && !outcome.memory_answer.trim().is_empty()
        {
            fanout_legacy_card_markers_from_text(state, turn_id, &outcome.memory_answer);
        }
    }
    if let Some(abort) = stream_abort_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&request_id).cloned())
    {
        crate::turn_executor::attach_turn_engine_abort(turn_id, abort);
    }

    let body_task = tokio::spawn(async move {
        let _ = axum::body::to_bytes(response.into_body(), usize::MAX).await;
    });

    let result = match entry {
        Some(entry) => {
            drain_agent_stream_into_message_with_fanout(
                state,
                thread_id,
                source_user_message_id,
                assistant_message_id,
                entry,
                turn_id,
                requested_delivery_state,
            )
            .await
        }
        None => {
            let _ = body_task.await;
            return Err("stream registration disappeared before draining".to_string());
        }
    };
    let _ = body_task.await;
    result
}
