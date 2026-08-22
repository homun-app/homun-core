//! Thread history model context owner.
//!
//! Owns conversion of persisted chat messages into bounded model context for a
//! new agent turn. Stream draining, visible-turn startup, recall execution, and
//! final assistant persistence remain separate owners.

use super::*;
use local_first_desktop_gateway::{
    BuildPromptRequest, build_chat_runtime_prompt, render_checkpoint_input,
};

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

pub(crate) struct ChatModelPromptInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) request_context: &'a [ChatContextMessage],
    pub(crate) prompt: &'a str,
    pub(crate) checkpoint_input: Option<&'a serde_json::Value>,
    pub(crate) model_context_window: Option<usize>,
}

pub(crate) struct ChatModelPrompt {
    pub(crate) prompt: String,
    pub(crate) effective_context: Vec<ChatContextMessage>,
}

pub(crate) fn prepare_chat_model_prompt(input: ChatModelPromptInput<'_>) -> ChatModelPrompt {
    let effective_context = effective_prompt_context_for_model(
        input.state,
        input.thread_id,
        input.request_context,
        input.prompt,
    );
    let prompt = chat_model_prompt_from_effective_context(
        input.prompt,
        &effective_context,
        input.checkpoint_input,
        input.model_context_window,
    );
    ChatModelPrompt {
        prompt,
        effective_context,
    }
}

fn chat_model_prompt_from_effective_context(
    prompt: &str,
    effective_context: &[ChatContextMessage],
    checkpoint_input: Option<&serde_json::Value>,
    model_context_window: Option<usize>,
) -> String {
    checkpoint_input
        .map(render_checkpoint_input)
        .unwrap_or_else(|| {
            build_chat_runtime_prompt(&BuildPromptRequest {
                prompt: prompt.to_string(),
                context: effective_context.to_vec(),
                max_context_chars: Some(chat_context_budget_chars(model_context_window)),
            })
            .runtime_prompt
        })
}

pub(crate) fn agent_turn_context(
    state: &AppState,
    thread_id: &str,
    skip_message_ids: &[&str],
) -> Option<Vec<ChatContextMessage>> {
    thread_context_for_model(state, thread_id, skip_message_ids, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_model_prompt_prefers_checkpoint_payload_over_runtime_prompt_builder() {
        let context = vec![ChatContextMessage {
            role: ChatContextRole::Assistant,
            text: "prior assistant context that should not enter checkpoint rendering".to_string(),
        }];
        let checkpoint = serde_json::json!({
            "kind": "resume",
            "user_prompt": "resume from checkpoint"
        });

        let prompt = chat_model_prompt_from_effective_context(
            "fresh user prompt",
            &context,
            Some(&checkpoint),
            Some(128_000),
        );

        assert_eq!(prompt, render_checkpoint_input(&checkpoint));
        assert!(!prompt.contains("prior assistant context"));
    }

    #[test]
    fn chat_model_prompt_uses_effective_context_budget_for_normal_turns() {
        let context = vec![ChatContextMessage {
            role: ChatContextRole::Assistant,
            text: "prior assistant context".to_string(),
        }];

        let prompt = chat_model_prompt_from_effective_context(
            "fresh user prompt",
            &context,
            None,
            Some(128_000),
        );

        assert!(prompt.contains("fresh user prompt"));
        assert!(prompt.contains("prior assistant context"));
    }
}
