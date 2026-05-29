use crate::json_parse::json_response_from_text;
use crate::provider::{CapabilityDescriptor, InferenceProvider};
use local_first_subagents::{
    GenerateJsonRequest, GenerateJsonResponse, RuntimeClientError, TokenMetrics,
};
use serde_json::{Value, json};

const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Cloud provider for the Anthropic Messages API (Claude) — the premium
/// agentic/vision tier in ADR 0007. Always cloud locality, so the router only
/// uses it when the privacy policy permits cloud delegation.
pub struct AnthropicProvider {
    descriptor: CapabilityDescriptor,
    base_url: String,
    model: String,
    api_key: String,
    http: reqwest::blocking::Client,
}

impl AnthropicProvider {
    pub fn new(
        descriptor: CapabilityDescriptor,
        model: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Self {
        Self {
            descriptor,
            base_url: DEFAULT_ANTHROPIC_BASE_URL.to_string(),
            model: model.into(),
            api_key: api_key.into(),
            http: reqwest::blocking::Client::new(),
        }
    }

    /// Override the API base URL (e.g. a gateway/proxy). Defaults to the public
    /// Anthropic API.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into().trim_end_matches('/').to_string();
        self
    }

    fn messages_url(&self) -> String {
        format!("{}/v1/messages", self.base_url)
    }

    fn request_body(&self, request: &GenerateJsonRequest) -> Value {
        json!({
            "model": self.model,
            // Anthropic requires max_tokens; never send 0.
            "max_tokens": request.max_tokens.max(1),
            "temperature": request.temperature,
            "messages": [{ "role": "user", "content": request.prompt }],
        })
    }
}

impl InferenceProvider for AnthropicProvider {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }

    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let mut builder = self
            .http
            .post(self.messages_url())
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION);
        if let Some(seconds) = request.request_timeout_seconds
            && seconds > 0.0
        {
            builder = builder.timeout(std::time::Duration::from_secs_f64(seconds));
        }
        let response = builder
            .json(&self.request_body(request))
            .send()
            .map_err(RuntimeClientError::Request)?;
        if !response.status().is_success() {
            return Err(RuntimeClientError::Status(response.status().as_u16()));
        }
        let body: Value = response.json().map_err(RuntimeClientError::Request)?;
        Ok(parse_anthropic_message(&body, request))
    }
}

/// Pure parse of an Anthropic Messages response into our JSON contract.
/// Separated from the HTTP call so it is testable without a network.
pub fn parse_anthropic_message(body: &Value, request: &GenerateJsonRequest) -> GenerateJsonResponse {
    // Concatenate all text content blocks (`content: [{type:"text", text:...}]`).
    let content = body
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    let metrics = parse_usage(body.get("usage"));
    json_response_from_text(content, request, metrics)
}

fn parse_usage(usage: Option<&Value>) -> TokenMetrics {
    let mut metrics = TokenMetrics::zero();
    let Some(usage) = usage else {
        return metrics;
    };
    if let Some(input) = usage.get("input_tokens").and_then(Value::as_u64) {
        metrics.prompt_tokens = input as u32;
    }
    if let Some(output) = usage.get("output_tokens").and_then(Value::as_u64) {
        metrics.generation_tokens = output as u32;
    }
    metrics
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(required_keys: &[&str]) -> GenerateJsonRequest {
        GenerateJsonRequest {
            prompt: "decide".to_string(),
            max_tokens: 256,
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: None,
            json_schema: None,
            required_keys: required_keys.iter().map(|key| key.to_string()).collect(),
            repair: true,
        }
    }

    fn message(text: &str) -> Value {
        json!({
            "content": [{ "type": "text", "text": text }],
            "usage": { "input_tokens": 20, "output_tokens": 9 }
        })
    }

    #[test]
    fn parses_text_block_json_with_usage() {
        let body = message(r#"{"decision":"act","ref":"e1"}"#);
        let parsed = parse_anthropic_message(&body, &request(&["decision"]));
        assert!(parsed.valid, "errors: {:?}", parsed.errors);
        assert_eq!(parsed.json["decision"], "act");
        assert_eq!(parsed.metrics.prompt_tokens, 20);
        assert_eq!(parsed.metrics.generation_tokens, 9);
    }

    #[test]
    fn repairs_text_with_prose_around_json() {
        let body = message("Here is the decision:\n{\"decision\":\"complete\"}\nDone.");
        let parsed = parse_anthropic_message(&body, &request(&["decision"]));
        assert!(parsed.valid, "errors: {:?}", parsed.errors);
        assert!(parsed.repaired);
        assert_eq!(parsed.json["decision"], "complete");
    }

    #[test]
    fn flags_missing_required_keys() {
        let body = message(r#"{"ref":"e1"}"#);
        let parsed = parse_anthropic_message(&body, &request(&["decision"]));
        assert!(!parsed.valid);
        assert!(parsed.errors[0].contains("decision"));
    }

    #[test]
    fn joins_multiple_text_blocks() {
        let body = json!({
            "content": [
                { "type": "text", "text": "{\"a\":" },
                { "type": "text", "text": "1}" }
            ]
        });
        let parsed = parse_anthropic_message(&body, &request(&[]));
        assert!(parsed.valid, "errors: {:?}", parsed.errors);
        assert_eq!(parsed.json["a"], 1);
    }
}
