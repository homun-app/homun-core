use crate::json_parse::json_response_from_text;
use crate::provider::{CapabilityDescriptor, InferenceProvider};
use local_first_subagents::{
    GenerateJsonRequest, GenerateJsonResponse, RuntimeClientError, TokenMetrics,
};
use serde_json::{Value, json};

/// Provider for any OpenAI-compatible `/chat/completions` endpoint.
///
/// One adapter covers OpenAI, OpenRouter, Together, Groq, and — via the same
/// wire format — Ollama local (`http://127.0.0.1:11434/v1`) and Ollama Cloud
/// (`https://ollama.com/v1`). The base URL points at the API root that exposes
/// `chat/completions` (e.g. ending in `/v1`).
pub struct OpenAiCompatProvider {
    descriptor: CapabilityDescriptor,
    base_url: String,
    model: String,
    api_key: Option<String>,
    http: reqwest::blocking::Client,
}

impl OpenAiCompatProvider {
    pub fn new(
        descriptor: CapabilityDescriptor,
        base_url: impl Into<String>,
        model: impl Into<String>,
        api_key: Option<String>,
    ) -> Self {
        Self {
            descriptor,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            model: model.into(),
            api_key,
            http: reqwest::blocking::Client::new(),
        }
    }

    fn chat_completions_url(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }

    fn request_body(&self, request: &GenerateJsonRequest) -> Value {
        let mut body = json!({
            "model": self.model,
            "messages": [{ "role": "user", "content": request.prompt }],
            "temperature": request.temperature,
            // Ask for a JSON object; broadly supported, including Ollama.
            "response_format": { "type": "json_object" },
        });
        if request.max_tokens > 0 {
            body["max_tokens"] = json!(request.max_tokens);
        }
        body
    }
}

impl InferenceProvider for OpenAiCompatProvider {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }

    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let mut builder = self.http.post(self.chat_completions_url());
        if let Some(seconds) = request.request_timeout_seconds {
            if seconds > 0.0 {
                builder = builder.timeout(std::time::Duration::from_secs_f64(seconds));
            }
        }
        if let Some(api_key) = self.api_key.as_ref() {
            builder = builder.bearer_auth(api_key);
        }
        let response = builder
            .json(&self.request_body(request))
            .send()
            .map_err(RuntimeClientError::Request)?;
        if !response.status().is_success() {
            return Err(RuntimeClientError::Status(response.status().as_u16()));
        }
        let body: Value = response.json().map_err(RuntimeClientError::Request)?;
        Ok(parse_chat_completion(&body, request))
    }
}

/// Pure parse of an OpenAI-compatible chat completion into our JSON response
/// contract. Separated from the HTTP call so it is testable without a network.
pub fn parse_chat_completion(body: &Value, request: &GenerateJsonRequest) -> GenerateJsonResponse {
    let content = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let metrics = parse_usage(body.get("usage"));
    json_response_from_text(content, request, metrics)
}

fn parse_usage(usage: Option<&Value>) -> TokenMetrics {
    let mut metrics = TokenMetrics::zero();
    let Some(usage) = usage else {
        return metrics;
    };
    if let Some(prompt) = usage.get("prompt_tokens").and_then(Value::as_u64) {
        metrics.prompt_tokens = prompt as u32;
    }
    if let Some(completion) = usage.get("completion_tokens").and_then(Value::as_u64) {
        metrics.generation_tokens = completion as u32;
    }
    metrics
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(required_keys: &[&str]) -> GenerateJsonRequest {
        GenerateJsonRequest {
            prompt: "decide".to_string(),
            max_tokens: 64,
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: None,
            json_schema: None,
            required_keys: required_keys.iter().map(|key| key.to_string()).collect(),
            repair: false,
        }
    }

    fn completion(content: &str) -> Value {
        json!({
            "choices": [{ "message": { "role": "assistant", "content": content } }],
            "usage": { "prompt_tokens": 12, "completion_tokens": 7 }
        })
    }

    #[test]
    fn parses_valid_json_with_required_keys_and_usage() {
        let body = completion(r#"{"decision":"act","ref":"e1"}"#);
        let parsed = parse_chat_completion(&body, &request(&["decision"]));
        assert!(parsed.valid, "errors: {:?}", parsed.errors);
        assert_eq!(parsed.json["decision"], "act");
        assert_eq!(parsed.metrics.prompt_tokens, 12);
        assert_eq!(parsed.metrics.generation_tokens, 7);
    }

    #[test]
    fn flags_missing_required_keys() {
        let body = completion(r#"{"ref":"e1"}"#);
        let parsed = parse_chat_completion(&body, &request(&["decision"]));
        assert!(!parsed.valid);
        assert!(parsed.errors[0].contains("decision"));
    }

    #[test]
    fn flags_non_json_content() {
        let body = completion("Sorry, I cannot do that.");
        let parsed = parse_chat_completion(&body, &request(&[]));
        assert!(!parsed.valid);
        assert!(parsed.errors[0].contains("not valid JSON"));
    }

    #[test]
    fn repairs_trailing_characters_after_valid_object() {
        // Exact shape observed from qwen3-vl: a valid object plus a stray `"}`.
        let body = completion(
            r#"{"decision":"act","action":{"kind":"click","ref":"e467"},"expected_observation":"opens"}"}"#,
        );
        let mut req = request(&["decision"]);
        req.repair = true;
        let parsed = parse_chat_completion(&body, &req);
        assert!(parsed.valid, "errors: {:?}", parsed.errors);
        assert!(parsed.repaired);
        assert_eq!(parsed.json["action"]["ref"], "e467");
    }

    #[test]
    fn does_not_repair_when_repair_disabled() {
        let body = completion(r#"{"decision":"act"}trailing"#);
        let parsed = parse_chat_completion(&body, &request(&[]));
        assert!(!parsed.valid);
    }

    #[test]
    fn unwraps_markdown_fenced_json() {
        let body = completion("```json\n{\"decision\":\"complete\"}\n```");
        let parsed = parse_chat_completion(&body, &request(&["decision"]));
        assert!(parsed.valid, "errors: {:?}", parsed.errors);
        assert_eq!(parsed.json["decision"], "complete");
    }
}
