//! Thread history model context owner.
//!
//! Owns conversion of persisted chat messages into bounded model context for a
//! new agent turn. Stream draining, visible-turn startup, recall execution, and
//! final assistant persistence remain separate owners.

use super::*;

pub(crate) fn context_message_for_model(
    _facade: &MemoryFacade,
    _consumer: (&MemoryUserId, &MemoryWorkspaceId),
    message: &ChatMessage,
    _now_unix: i64,
) -> Option<ChatContextMessage> {
    local_first_desktop_gateway::chat_message_for_existing_thread_context(message)
}

pub(crate) fn thread_context_for_model(
    state: &AppState,
    thread_id: &str,
    skip_message_ids: &[&str],
    current_prompt: Option<&str>,
) -> Option<Vec<ChatContextMessage>> {
    let skip: std::collections::HashSet<&str> = skip_message_ids.iter().copied().collect();
    let (snapshot, workspace_id) = {
        let Ok(store) = lock_store(state) else {
            return None;
        };
        (
            store.messages(thread_id).ok()?,
            store.workspace_for_thread(thread_id).ok()?,
        )
    };
    let mut messages: Vec<ChatMessage> = snapshot
        .messages
        .into_iter()
        .filter(|m| matches!(m.role.as_str(), "user" | "assistant"))
        .filter(|m| !skip.contains(m.id.as_str()))
        .collect();
    if messages
        .last()
        .is_some_and(|message| message.role == "assistant" && message.text.trim() == "…")
    {
        messages.pop();
    }
    if let Some(current_prompt) = current_prompt
        && messages.last().is_some_and(|message| {
            message.role == "user" && message.text.trim() == current_prompt.trim()
        })
    {
        messages.pop();
    }
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let workspace = MemoryWorkspaceId::new(workspace_id);
    let now_unix = i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX);
    let mut msgs: Vec<ChatContextMessage> = messages
        .iter()
        .filter_map(|message| {
            context_message_for_model(facade, (&user, &workspace), message, now_unix)
        })
        .collect();
    let len = msgs.len();
    if len > 16 {
        msgs.drain(0..len - 16);
    }
    Some(msgs)
}

pub(crate) fn effective_prompt_context_for_model(
    state: &AppState,
    thread_id: Option<&str>,
    request_context: &[ChatContextMessage],
    current_prompt: &str,
) -> Vec<ChatContextMessage> {
    match thread_id {
        Some(thread_id) => thread_context_for_model(state, thread_id, &[], Some(current_prompt))
            .unwrap_or_default(),
        None => request_context.to_vec(),
    }
}

pub(crate) fn agent_turn_context(
    state: &AppState,
    thread_id: &str,
    skip_message_ids: &[&str],
) -> Option<Vec<ChatContextMessage>> {
    thread_context_for_model(state, thread_id, skip_message_ids, None)
}
