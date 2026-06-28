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

    fn request_body(&self, request: &GenerateJsonRequest, enforce_schema: bool) -> Value {
        build_request_body(&self.model, request, enforce_schema)
    }

    /// POST the body to the chat-completions endpoint with the request's
    /// timeout + auth. Factored out so `generate_json` can retry (strict schema
    /// → json_object fallback) without duplicating the builder setup.
    fn send(
        &self,
        body: &Value,
        timeout_seconds: Option<f64>,
    ) -> Result<reqwest::blocking::Response, RuntimeClientError> {
        let mut builder = self.http.post(self.chat_completions_url());
        if let Some(seconds) = timeout_seconds {
            if seconds > 0.0 {
                builder = builder.timeout(std::time::Duration::from_secs_f64(seconds));
            }
        }
        if let Some(api_key) = self.api_key.as_ref() {
            builder = builder.bearer_auth(api_key);
        }
        builder
            .json(body)
            .send()
            .map_err(RuntimeClientError::Request)
    }
}

/// The ONE definition of the cross-model structured-output "floor" `response_format`.
///
/// `Some(schema)` → strict `json_schema`: constrained decoding, where a supporting
/// backend (OpenAI, OpenRouter, recent Ollama) literally cannot emit out-of-schema
/// tokens — the floor that lets a weak/local model still produce valid structured
/// output. `None` → the universally-supported `json_object` hint, which is ALSO the
/// degrade target after a backend rejects `json_schema` with a 400 (e.g. ollama.com/v1).
/// `name` only labels the schema for the API; its value is cosmetic.
///
/// Single-source so every structured-output path — the inference provider, the gateway's
/// deck-content generation, the orchestration judges — degrades identically. Convergence
/// per caposaldo #5 / ADR 0016: changing the floor (e.g. adding a degrade level) happens
/// here, once. Pure + `pub` so cross-crate callers reuse it instead of re-hand-rolling.
pub fn structured_response_format(name: &str, schema: Option<&Value>) -> Value {
    match schema {
        Some(schema) => json!({
            "type": "json_schema",
            "json_schema": { "name": name, "strict": true, "schema": schema },
        }),
        None => json!({ "type": "json_object" }),
    }
}

/// Build the chat-completions request body. When `enforce_schema` is true AND a
/// `json_schema` is present, emit the strict `response_format: json_schema` (constrained
/// decoding — the cross-model floor); otherwise the loose `json_object` hint. The floor
/// itself is defined once in [`structured_response_format`]. Free function so it is
/// unit-testable without a provider.
pub(crate) fn build_request_body(
    model: &str,
    request: &GenerateJsonRequest,
    enforce_schema: bool,
) -> Value {
    let response_format = structured_response_format(
        "result",
        if enforce_schema {
            request.json_schema.as_ref()
        } else {
            None
        },
    );
    let mut body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": request.prompt }],
        "temperature": request.temperature,
        "response_format": response_format,
    });
    if request.max_tokens > 0 {
        body["max_tokens"] = json!(request.max_tokens);
    }
    body
}

impl InferenceProvider for OpenAiCompatProvider {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }

    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let timeout = request.request_timeout_seconds;
        // Try strict schema enforcement first; degrade ONCE to json_object if the
        // endpoint rejects json_schema with a 400 (e.g. ollama.com/v1). This way
        // we never silently lose enforcement on backends that DO support it.
        let enforce = request.json_schema.is_some();
        let mut response = self.send(&self.request_body(request, enforce), timeout)?;
        if enforce && response.status().as_u16() == 400 {
            response = self.send(&self.request_body(request, false), timeout)?;
        }
        if !response.status().is_success() {
            return Err(RuntimeClientError::Status(response.status().as_u16()));
        }
        let body: Value = response.json().map_err(RuntimeClientError::Request)?;
        let parsed = parse_chat_completion(&body, request);
        if !parsed.valid && std::env::var("HOMUN_INFERENCE_DEBUG").is_ok() {
            eprintln!(
                "[inference-debug] invalid response ({:?}); raw_output:\n{}",
                parsed.errors,
                parsed.raw_output.chars().take(1200).collect::<String>()
            );
        }
        Ok(parsed)
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

    #[test]
    fn enforces_strict_json_schema_when_present() {
        // The cross-model "floor": a schema present + enforce → constrained
        // decoding (strict json_schema), not the loose json_object hint.
        let mut req = request(&[]);
        req.json_schema = Some(json!({
            "type": "object",
            "properties": { "a": { "type": "string" } },
            "required": ["a"],
            "additionalProperties": false
        }));
        let body = build_request_body("m", &req, true);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        assert_eq!(
            body["response_format"]["json_schema"]["schema"]["required"][0],
            "a"
        );
    }

    #[test]
    fn falls_back_to_json_object_on_unsupported_endpoint() {
        // Same schema, but enforce=false (the 400-retry path): must degrade to
        // the universally-supported json_object hint, never carry the schema.
        let mut req = request(&[]);
        req.json_schema = Some(json!({ "type": "object" }));
        let body = build_request_body("m", &req, false);
        assert_eq!(body["response_format"]["type"], "json_object");
        assert!(body["response_format"].get("json_schema").is_none());
    }

    #[test]
    fn uses_json_object_when_no_schema_supplied() {
        let body = build_request_body("m", &request(&[]), true);
        assert_eq!(body["response_format"]["type"], "json_object");
    }

    #[test]
    fn structured_response_format_is_the_single_floor_definition() {
        // Schema present → strict json_schema with the given name (constrained decoding).
        let schema = json!({ "type": "object", "required": ["a"] });
        let strict = structured_response_format("deck", Some(&schema));
        assert_eq!(strict["type"], "json_schema");
        assert_eq!(strict["json_schema"]["name"], "deck");
        assert_eq!(strict["json_schema"]["strict"], true);
        assert_eq!(strict["json_schema"]["schema"]["required"][0], "a");
        // No schema → the universal json_object degrade target (no schema leaks through).
        let loose = structured_response_format("deck", None);
        assert_eq!(loose, json!({ "type": "json_object" }));
        assert!(loose.get("json_schema").is_none());
    }
}
