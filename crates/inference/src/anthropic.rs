use crate::json_parse::json_response_from_text;
use crate::provider::{CapabilityDescriptor, InferenceProvider, ProviderAttempt};
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
    usage: std::sync::Arc<dyn local_first_inference_usage::UsageRecorder>,
}

impl AnthropicProvider {
    pub fn new(
        descriptor: CapabilityDescriptor,
        model: impl Into<String>,
        api_key: impl Into<String>,
        usage: std::sync::Arc<dyn local_first_inference_usage::UsageRecorder>,
    ) -> Self {
        Self {
            descriptor,
            base_url: DEFAULT_ANTHROPIC_BASE_URL.to_string(),
            model: model.into(),
            api_key: api_key.into(),
            http: reqwest::blocking::Client::new(),
            usage,
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
        let attempt = ProviderAttempt::start(&self.usage, request, &self.descriptor, &self.model);
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
        let response = match builder.json(&self.request_body(request)).send() {
            Ok(response) => response,
            Err(error) => {
                attempt.failed("transport", None);
                return Err(RuntimeClientError::Request(error));
            }
        };
        if !response.status().is_success() {
            let status = response.status().as_u16();
            attempt.failed("http_status", Some(status));
            return Err(RuntimeClientError::Status(status));
        }
        let body: Value = match response.json() {
            Ok(body) => body,
            Err(error) => {
                attempt.failed("decode", None);
                return Err(RuntimeClientError::Request(error));
            }
        };
        let parsed = parse_anthropic_message(&body, request);
        let reported = body.get("usage").is_some();
        let usage = if reported {
            local_first_inference_usage::NormalizedUsage {
                input_tokens: body.pointer("/usage/input_tokens").and_then(Value::as_u64),
                output_tokens: body.pointer("/usage/output_tokens").and_then(Value::as_u64),
                cache_read_tokens: body.pointer("/usage/cache_read_input_tokens").and_then(Value::as_u64),
                cache_write_tokens: body.pointer("/usage/cache_creation_input_tokens").and_then(Value::as_u64),
                ..Default::default()
            }
        } else {
            local_first_inference_usage::NormalizedUsage {
                input_tokens: Some((request.prompt.chars().count() as u64).div_ceil(4).max(1)),
                output_tokens: Some((parsed.raw_output.chars().count() as u64).div_ceil(4).max(1)),
                ..Default::default()
            }
        };
        attempt.completed(
            usage,
            if reported { local_first_inference_usage::UsageProvenance::ProviderReported } else { local_first_inference_usage::UsageProvenance::HomunEstimated },
        );
        Ok(parsed)
    }
}

/// Pure parse of an Anthropic Messages response into our JSON contract.
/// Separated from the HTTP call so it is testable without a network.
pub fn parse_anthropic_message(
    body: &Value,
    request: &GenerateJsonRequest,
) -> GenerateJsonResponse {
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
    use crate::provider::{Locality, usage_tests::RecordingUsageRecorder};
    use local_first_inference_usage::{AttemptEventKind, UsageRecorder};
    use std::io::{Read, Write};
    use std::sync::Arc;

    fn request(required_keys: &[&str]) -> GenerateJsonRequest {
        GenerateJsonRequest {
            usage: local_first_inference_usage::UsageContext::new(
                "anthropic-test",
                local_first_inference_usage::InferencePurpose::Evaluation,
                "test",
            ),
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
    fn success_records_anthropic_reported_tokens() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = r#"{"content":[{"type":"text","text":"{\"ok\":true}"}],"usage":{"input_tokens":20,"output_tokens":9}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });

        let recorder = Arc::new(RecordingUsageRecorder::default());
        let provider = AnthropicProvider::new(
            CapabilityDescriptor {
                id: "anthropic:test".to_string(),
                locality: Locality::Cloud,
                supports_vision: false,
                supports_tools: false,
                context_window: 8_192,
                approx_tokens_per_second: None,
            },
            "model-a",
            "key",
            recorder.clone() as Arc<dyn UsageRecorder>,
        )
        .with_base_url(format!("http://{address}"));
        let response = provider.generate_json(&request(&["ok"])).unwrap();
        assert!(response.valid);
        server.join().unwrap();

        let events = recorder.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].event_kind, AttemptEventKind::AttemptCompleted);
        assert_eq!(events[1].input_tokens, Some(20));
        assert_eq!(events[1].output_tokens, Some(9));
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
