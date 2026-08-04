// Gateway-owned implementations of the memory crate capability clients.
use std::sync::Arc;

use crate::*;

/// ADR 0022 (Tappa 4): gateway implementation of `EmbeddingClient`.
///
/// This wraps the gateway memory embedding path so the orchestrated recall in
/// `local_first_memory` does not need to know about HTTP, cache policy, or
/// workspace-derived timing.
pub(crate) fn gateway_embedding_client(
    http: reqwest::Client,
) -> Arc<dyn local_first_memory::EmbeddingClient> {
    Arc::new(GatewayEmbeddingClient { http })
}

/// ADR 0022 (Tappa 4): gateway implementation of `LlmClient` for memory learn extraction.
///
/// This owns the gateway/provider transport boundary while the memory crate owns
/// orchestration and prompt semantics.
pub(crate) fn gateway_llm_client(http: reqwest::Client) -> Arc<dyn local_first_memory::LlmClient> {
    Arc::new(GatewayLlmClient { http })
}

struct GatewayEmbeddingClient {
    http: reqwest::Client,
}

impl local_first_memory::EmbeddingClient for GatewayEmbeddingClient {
    fn embed<'a>(&'a self, text: &'a str) -> local_first_memory::BoxFuture<'a, Vec<f32>> {
        let http = self.http.clone();
        Box::pin(async move {
            // `embed_query_for_memory_recall` derives workspace/timing internally;
            // the orchestrated recall only needs the query text embedding.
            let active = gateway_memory_workspace_id();
            let mut timing = MemoryRecallTiming::default();
            embed_query_for_memory_recall(&http, text, &active, &mut timing)
                .await
                .unwrap_or_default()
        })
    }
}

struct GatewayLlmClient {
    http: reqwest::Client,
}

impl local_first_memory::LlmClient for GatewayLlmClient {
    fn chat<'a>(
        &'a self,
        system: &'a str,
        user_content: &'a str,
    ) -> local_first_memory::BoxFuture<'a, Option<String>> {
        let http = self.http.clone();
        Box::pin(async move {
            let (base_url, model, api_key) = extractor_openai_config()?;
            let payload = serde_json::json!({
                "model": model,
                "temperature": 0.0,
                "max_tokens": 2000,
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
            usage.purpose_detail = Some("learn_extraction".to_string());
            usage.workspace_id = Some(gateway_memory_workspace_id().as_str().to_string());
            let response = inference_transport::send_openai_json(
                &http,
                global_usage_recorder(),
                &usage,
                &inference_provider_id(&base_url),
                &model,
                inference_locality(&base_url),
                &base_url,
                api_key.as_deref(),
                &payload,
                Some(std::time::Duration::from_secs(120)),
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
            body.get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .map(str::to_string)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_memory_clients_build_trait_objects() {
        let http = reqwest::Client::new();

        let embedding: Arc<dyn local_first_memory::EmbeddingClient> =
            gateway_embedding_client(http.clone());
        let llm: Arc<dyn local_first_memory::LlmClient> = gateway_llm_client(http);

        assert_eq!(Arc::strong_count(&embedding), 1);
        assert_eq!(Arc::strong_count(&llm), 1);
    }
}
