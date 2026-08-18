use crate::{
    AppState, GatewayError, channel_chat_message, chat_openai_stream_config,
    gateway_memory_user_id, gateway_user_id, inference_locality, inference_provider_id,
    inference_transport, is_ollama_base, lock_store, memory_facade, publish_app_event,
    redact_sensitive_text,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use local_first_desktop_gateway::{ChatMessagesSnapshot, ChatThreadSnapshot, compact_thread_title};
use local_first_memory::{
    DataSensitivity as MemoryDataSensitivity, MemoryCreateRequest, MemoryLifecycleRequest,
    PERSONAL_WORKSPACE, PrivacyDomain, WorkspaceId as MemoryWorkspaceId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub(crate) struct ImprovePromptRequest {
    prompt: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ImprovePromptResponse {
    improved: String,
}

/// Rewrites a draft prompt into a clearer, more complete instruction.
pub(crate) async fn improve_prompt(
    State(state): State<AppState>,
    Json(request): Json<ImprovePromptRequest>,
) -> Result<Json<ImprovePromptResponse>, GatewayError> {
    let draft = request.prompt.trim();
    if draft.is_empty() {
        return Ok(Json(ImprovePromptResponse {
            improved: String::new(),
        }));
    }
    let (base_url, model, api_key) = chat_openai_stream_config().ok_or_else(|| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "no_inference_provider",
        message: "No provider configured.".to_string(),
    })?;
    let system = "You are an assistant that REWRITES prompts to make them clearer, more specific \
and complete, WITHOUT executing them and without answering the request. Keep the SAME language \
and the user's intent; make criteria, constraints and expected format explicit only if implicit. \
Return ONLY the rewritten prompt, as plain text, without preamble, quotes or explanations.";
    let payload = serde_json::json!({
        "model": model,
        "temperature": 0.3,
        "max_tokens": 4000,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": format!("Rewrite this prompt:\n\n{draft}") },
        ],
    });
    let mut usage = local_first_inference_usage::UsageContext::new(
        uuid::Uuid::new_v4().to_string(),
        local_first_inference_usage::InferencePurpose::Other,
        gateway_user_id().as_str(),
    );
    usage.purpose_detail = Some("prompt_improvement".to_string());
    let response = inference_transport::send_openai_json(
        &state.http,
        state.usage_recorder.clone(),
        &usage,
        &inference_provider_id(&base_url),
        &model,
        inference_locality(&base_url),
        &base_url,
        api_key.as_deref(),
        &payload,
        Some(std::time::Duration::from_secs(30)),
        system.chars().count().saturating_add(draft.chars().count()),
    )
    .await
    .map_err(|error| {
        tracing::warn!(
            target: "chat::improve_prompt",
            %error, model = %model, %base_url,
            "improve-prompt LLM request errored"
        );
        GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "improve_prompt_failed",
            message: format!("Provider unreachable: {error}"),
        }
    })?;
    if !(200..300).contains(&response.status) {
        let status = response.status;
        let body: String = response.body.to_string().chars().take(300).collect();
        tracing::warn!(
            target: "chat::improve_prompt",
            %status, model = %model, %base_url, body = %body,
            "improve-prompt LLM call failed"
        );
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "improve_prompt_failed",
            message: format!("Provider responded {status}"),
        });
    }
    let body = response.body;
    let improved = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .to_string();
    let improved = if improved.is_empty() {
        let snippet: String = body.to_string().chars().take(300).collect();
        tracing::warn!(
            target: "chat::improve_prompt",
            model = %model, %base_url, body = %snippet,
            "improve-prompt LLM returned 2xx but no content — keeping the original draft"
        );
        draft.to_string()
    } else {
        improved
    };
    Ok(Json(ImprovePromptResponse { improved }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct SuggestionsRequest {
    prompt: String,
    answer: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct SuggestionsResponse {
    suggestions: Vec<String>,
}

fn chat_suggestions_payload(
    base_url: &str,
    model: &str,
    system: &str,
    user: &str,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "model": model,
        "temperature": 0.5,
        "max_tokens": 2000,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    if is_ollama_base(base_url) {
        payload["reasoning_effort"] = serde_json::Value::String("none".to_string());
    }
    payload
}

/// Proposes a few short follow-up prompts after the latest exchange.
pub(crate) async fn chat_suggestions(
    State(state): State<AppState>,
    Json(request): Json<SuggestionsRequest>,
) -> Json<SuggestionsResponse> {
    let empty = Json(SuggestionsResponse {
        suggestions: Vec::new(),
    });
    let Some((base_url, model, api_key)) = chat_openai_stream_config() else {
        return empty;
    };
    if request.answer.trim().is_empty() {
        return empty;
    }
    let system = "Propose 3 SHORT follow-up questions the user might ask AFTER this answer. Rules: \
one per line, max ~7 words, in the SAME language as the user, phrased as if written by the user, \
without numbering, dashes or quotes. Return ONLY the 3 lines.";
    let user = format!(
        "User request:\n{}\n\nAssistant answer:\n{}",
        request.prompt.chars().take(2000).collect::<String>(),
        request.answer.chars().take(4000).collect::<String>()
    );
    let payload = chat_suggestions_payload(&base_url, &model, system, &user);
    let mut usage = local_first_inference_usage::UsageContext::new(
        uuid::Uuid::new_v4().to_string(),
        local_first_inference_usage::InferencePurpose::Other,
        gateway_user_id().as_str(),
    );
    usage.purpose_detail = Some("follow_up_suggestions".to_string());
    let response = match inference_transport::send_openai_json(
        &state.http,
        state.usage_recorder.clone(),
        &usage,
        &inference_provider_id(&base_url),
        &model,
        inference_locality(&base_url),
        &base_url,
        api_key.as_deref(),
        &payload,
        Some(std::time::Duration::from_secs(25)),
        system.chars().count().saturating_add(user.chars().count()),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(
                target: "chat::suggestions",
                %error, model = %model, %base_url,
                "suggestions LLM request errored — showing no suggestions"
            );
            return empty;
        }
    };
    if !(200..300).contains(&response.status) {
        let status = response.status;
        let body: String = response.body.to_string().chars().take(300).collect();
        tracing::warn!(
            target: "chat::suggestions",
            %status, model = %model, %base_url, body = %body,
            "suggestions LLM call failed — showing no suggestions"
        );
        return empty;
    }
    let body = response.body;
    let content = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    if content.trim().is_empty() {
        let snippet: String = body.to_string().chars().take(300).collect();
        tracing::warn!(
            target: "chat::suggestions",
            model = %model, %base_url, body = %snippet,
            "suggestions LLM returned 2xx but no content — showing no suggestions"
        );
    }
    let suggestions = content
        .lines()
        .map(|line| {
            line.trim()
                .trim_start_matches(|c: char| {
                    c == '-' || c == '*' || c == '•' || c.is_ascii_digit() || c == '.' || c == ')'
                })
                .trim()
                .trim_matches('"')
                .trim()
                .to_string()
        })
        .filter(|line| !line.is_empty())
        .take(3)
        .collect();
    Json(SuggestionsResponse { suggestions })
}

#[derive(Debug, Deserialize)]
pub(crate) struct AutoTitleRequest {
    prompt: String,
    #[serde(default)]
    answer: String,
}

fn title_model_inputs(prompt: &str, answer: &str) -> (String, String) {
    (
        local_first_desktop_gateway::strip_display_markers(prompt)
            .trim()
            .to_string(),
        local_first_desktop_gateway::strip_display_markers(answer)
            .trim()
            .to_string(),
    )
}

async fn generate_thread_title(state: &AppState, prompt: &str, answer: &str) -> String {
    let (prompt, answer) = title_model_inputs(prompt, answer);
    let (prompt, answer) = (prompt.as_str(), answer.as_str());
    let fallback = || {
        let base = prompt.trim();
        if base.is_empty() {
            "Nuova chat".to_string()
        } else {
            base.chars().take(48).collect::<String>()
        }
    };
    let Some((base_url, model, api_key)) = chat_openai_stream_config() else {
        tracing::warn!(
            target: "chat::autotitle",
            "no chat model configured (orchestrator role unresolved) — falling back to prompt truncation"
        );
        return fallback();
    };
    let system = "Generate a very short TITLE (max 5 words) for this conversation, in the same \
language as the user. Only the title, without quotes, final punctuation or prefixes.";
    let user = format!(
        "First message:\n{}\n\nAnswer:\n{}",
        prompt.chars().take(1500).collect::<String>(),
        answer.chars().take(1500).collect::<String>()
    );
    let payload = serde_json::json!({
        "model": model,
        "temperature": 0.3,
        "max_tokens": 2000,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let mut usage = local_first_inference_usage::UsageContext::new(
        uuid::Uuid::new_v4().to_string(),
        local_first_inference_usage::InferencePurpose::TitleGeneration,
        gateway_user_id().as_str(),
    );
    usage.purpose_detail = Some("thread_title".to_string());
    let title = match inference_transport::send_openai_json(
        &state.http,
        state.usage_recorder.clone(),
        &usage,
        &inference_provider_id(&base_url),
        &model,
        inference_locality(&base_url),
        &base_url,
        api_key.as_deref(),
        &payload,
        Some(std::time::Duration::from_secs(30)),
        system.chars().count().saturating_add(user.chars().count()),
    )
    .await
    {
        Ok(response) if (200..300).contains(&response.status) => {
            let body = response.body;
            let extracted = Some(&body)
                .and_then(|b| {
                    b.get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("message"))
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_str())
                        .map(|s| {
                            s.trim()
                                .trim_matches('"')
                                .lines()
                                .next()
                                .unwrap_or("")
                                .trim()
                                .to_string()
                        })
                })
                .unwrap_or_default();
            if extracted.trim().is_empty() {
                let snippet: String = body.to_string().chars().take(300).collect();
                tracing::warn!(
                    target: "chat::autotitle",
                    model = %model, %base_url, body = %snippet,
                    "title LLM returned 2xx but no usable content — falling back to prompt truncation"
                );
            }
            extracted
        }
        Ok(response) => {
            let status = response.status;
            let body: String = response.body.to_string().chars().take(300).collect();
            tracing::warn!(
                target: "chat::autotitle",
                %status, model = %model, %base_url, body = %body,
                "title LLM call failed — falling back to prompt truncation"
            );
            String::new()
        }
        Err(err) => {
            tracing::warn!(
                target: "chat::autotitle",
                error = %err, model = %model, %base_url,
                "title LLM request errored — falling back to prompt truncation"
            );
            String::new()
        }
    };
    if title.is_empty() {
        fallback()
    } else {
        title.chars().take(60).collect()
    }
}

/// Auto-titles a thread from its first exchange, persisting the result.
pub(crate) async fn autotitle_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<AutoTitleRequest>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    {
        let store = lock_store(&state)?;
        if let Some(thread) = store.thread(&thread_id).map_err(GatewayError::store)? {
            let is_provisional = thread.title == compact_thread_title(&request.prompt);
            if !is_placeholder_chat_title(&thread.title) && !is_provisional {
                return Ok(Json(
                    store
                        .select_thread(&thread_id)
                        .map_err(GatewayError::store)?,
                ));
            }
        }
    }
    let title = generate_thread_title(&state, &request.prompt, &request.answer).await;
    Ok(Json(
        lock_store(&state)?
            .rename_thread(&thread_id, &title)
            .map_err(GatewayError::store)?,
    ))
}

fn is_placeholder_chat_title(title: &str) -> bool {
    matches!(
        title.trim().to_ascii_lowercase().as_str(),
        "new task" | "nuovo compito"
    )
}

#[derive(Debug, Deserialize)]
pub(crate) struct SeedAssistantRequest {
    text: String,
    #[serde(default)]
    event_parts: Vec<serde_json::Value>,
}

/// Append a literal assistant message to a thread.
pub(crate) async fn seed_assistant_message(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SeedAssistantRequest>,
) -> Result<Json<ChatMessagesSnapshot>, GatewayError> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "empty_message",
            message: "Empty message.".to_string(),
        });
    }
    let mut message = channel_chat_message("assistant", text);
    message.event_parts = request.event_parts;
    let snapshot = lock_store(&state)?
        .append_assistant_message(&thread_id, &message)
        .map_err(GatewayError::store)?;
    publish_app_event(serde_json::json!({
        "type": "thread.updated",
        "thread_id": thread_id,
    }));
    Ok(Json(snapshot))
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProactiveAnswerRequest {
    answer: String,
    #[serde(default)]
    question: String,
    #[serde(default)]
    ack: String,
}

/// Answer to a proactivity question without running the agent loop.
pub(crate) async fn proactive_answer(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<ProactiveAnswerRequest>,
) -> Result<Json<ChatMessagesSnapshot>, GatewayError> {
    let answer = request.answer.trim();
    if answer.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "empty_answer",
            message: "Empty answer.".to_string(),
        });
    }
    {
        let user_message = channel_chat_message("user", answer);
        lock_store(&state)?
            .append_assistant_message(&thread_id, &user_message)
            .map_err(GatewayError::store)?;
    }
    capture_proactive_answer_memory(&state, &thread_id, request.question.trim(), answer);
    let ack = {
        let trimmed = request.ack.trim();
        if trimmed.is_empty() {
            "Perfect — noted. Thanks!".to_string()
        } else {
            trimmed.to_string()
        }
    };
    let ack_message = channel_chat_message("assistant", &ack);
    let snapshot = lock_store(&state)?
        .append_assistant_message(&thread_id, &ack_message)
        .map_err(GatewayError::store)?;
    publish_app_event(serde_json::json!({
        "type": "thread.updated",
        "thread_id": thread_id,
    }));
    Ok(Json(snapshot))
}

fn proactive_answer_memory_request(
    question: &str,
    answer: &str,
    thread_id: &str,
    lifecycle: MemoryLifecycleRequest,
) -> MemoryCreateRequest {
    let text = if question.is_empty() {
        format!("Onboarding answer: {answer}")
    } else {
        format!("{question}\n\u{2192} {answer}")
    };
    MemoryCreateRequest {
        request: lifecycle,
        memory_type: "preference".to_string(),
        text: redact_sensitive_text(&text),
        aliases: Vec::new(),
        language_hints: Vec::new(),
        confidence: 1.0,
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity: MemoryDataSensitivity::Internal,
        evidence_refs: Vec::new(),
        metadata: serde_json::json!({
            "source": "proactive_answer",
            "thread_id": thread_id,
        }),
    }
}

fn capture_proactive_answer_memory(
    state: &AppState,
    thread_id: &str,
    question: &str,
    answer: &str,
) {
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "proactivity".to_string(),
        user_id: gateway_memory_user_id(),
        workspace_id: MemoryWorkspaceId::new(PERSONAL_WORKSPACE),
        purpose: "proactive_answer_capture".to_string(),
    };
    let request = proactive_answer_memory_request(question, answer, thread_id, lifecycle.clone());
    let facade = memory_facade(state);
    if let Ok(record) = facade.create_memory_candidate(request) {
        let _ = facade.confirm_memory(&lifecycle, &record.reference, "proactive answer capture");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggestions_payload_disables_reasoning_only_for_ollama() {
        let ollama =
            chat_suggestions_payload("https://ollama.com/v1", "deepseek-v4-pro", "system", "user");
        assert_eq!(ollama["reasoning_effort"], "none");

        let generic = chat_suggestions_payload(
            "https://api.openai.com/v1",
            "gpt-4.1-mini",
            "system",
            "user",
        );
        assert!(generic.get("reasoning_effort").is_none());
    }

    #[test]
    fn title_model_inputs_strip_plan_markers_from_answer() {
        let prompt = "LangGraph pro e contro";
        let answer = "‹‹PLAN››- [-] **Step 2 in corso** (`s2`): confronto‹‹/PLAN››\
LangGraph conviene per grafi di stato espliciti; per flussi lineari è overhead.";
        let (clean_prompt, clean_answer) = title_model_inputs(prompt, answer);
        assert_eq!(clean_prompt, prompt);
        assert!(!clean_answer.contains("Step 2"));
        assert!(!clean_answer.contains("‹‹PLAN"));
        assert!(clean_answer.starts_with("LangGraph conviene"));
    }

    #[test]
    fn proactive_answer_capture_is_a_recallable_preference() {
        let lifecycle = local_first_memory::MemoryLifecycleRequest {
            actor_id: "proactivity".to_string(),
            user_id: local_first_memory::UserId::new("user"),
            workspace_id: local_first_memory::WorkspaceId::new("__personal__"),
            purpose: "proactive_answer_capture".to_string(),
        };
        let req = proactive_answer_memory_request(
            "Che ruolo ricopri nel progetto Homun?",
            "Sviluppatore",
            "thread_42",
            lifecycle,
        );
        assert_eq!(req.memory_type, "preference");
        assert!(req.text.contains("Sviluppatore"));
        assert!(req.text.contains("Che ruolo"));
        assert_eq!(req.metadata["source"], "proactive_answer");
        assert_eq!(req.metadata["thread_id"], "thread_42");

        let bare = proactive_answer_memory_request(
            "",
            "Founder",
            "t1",
            local_first_memory::MemoryLifecycleRequest {
                actor_id: "proactivity".to_string(),
                user_id: local_first_memory::UserId::new("user"),
                workspace_id: local_first_memory::WorkspaceId::new("__personal__"),
                purpose: "proactive_answer_capture".to_string(),
            },
        );
        assert!(bare.text.contains("Founder"));
    }
}
