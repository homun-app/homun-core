use crate::AppState;
use crate::gateway_identity::{gateway_memory_workspace_id, gateway_user_id};
use crate::gateway_model_routing::{
    extractor_openai_config, inference_locality, inference_provider_id,
};
use crate::inference_transport;

/// Strip a ```json ... ``` fence the model may wrap JSON in.
pub(crate) fn strip_json_fences(text: &str) -> &str {
    let trimmed = text.trim();
    let without_open = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    without_open
        .trim()
        .strip_suffix("```")
        .unwrap_or(without_open.trim())
        .trim()
}

pub(crate) async fn call_memory_json(
    state: &AppState,
    system: &str,
    user_content: &str,
) -> Option<serde_json::Value> {
    let (base_url, model, api_key) = extractor_openai_config()?;
    let payload = serde_json::json!({
        "model": model,
        "temperature": 0.0,
        "max_tokens": 4000,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user_content },
        ],
    });
    let mut usage = local_first_inference_usage::UsageContext::new(
        uuid::Uuid::new_v4().to_string(),
        local_first_inference_usage::InferencePurpose::MemoryExtraction,
        gateway_user_id().as_str(),
    );
    usage.purpose_detail = Some("memory_json".to_string());
    usage.workspace_id = Some(gateway_memory_workspace_id().as_str().to_string());
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
        Some(std::time::Duration::from_secs(150)),
        system
            .chars()
            .count()
            .saturating_add(user_content.chars().count()),
    )
    .await
    .ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    let body = response.body;
    let content = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())?;
    serde_json::from_str(strip_json_fences(content)).ok()
}
