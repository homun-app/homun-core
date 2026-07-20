use local_first_inference_usage::{
    CostProvenance, Locality, NormalizedUsage, UsageAttemptEvent, UsageContext, UsageProvenance,
    UsageRecorder,
};
use serde_json::Value;
use std::{sync::Arc, time::Instant};

#[derive(Debug)]
pub(crate) enum InferenceTransportError {
    Request(reqwest::Error),
    Decode(reqwest::Error),
}

impl std::fmt::Display for InferenceTransportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Request(error) => write!(formatter, "request failed: {error}"),
            Self::Decode(error) => write!(formatter, "response decode failed: {error}"),
        }
    }
}

pub(crate) struct RecordedJsonResponse {
    pub status: u16,
    pub body: Value,
}

struct AttemptGuard {
    recorder: Arc<dyn UsageRecorder>,
    started: UsageAttemptEvent,
    clock: Instant,
    terminal: bool,
}

impl AttemptGuard {
    fn start(
        recorder: Arc<dyn UsageRecorder>,
        context: &UsageContext,
        provider_id: &str,
        model_id: &str,
        locality: Locality,
    ) -> Self {
        let started = UsageAttemptEvent::started(
            context.clone(),
            uuid::Uuid::new_v4().to_string(),
            provider_id,
            model_id,
            locality,
            now(),
        );
        recorder.record(started.clone());
        Self { recorder, started, clock: Instant::now(), terminal: false }
    }

    fn completed(&mut self, body: &Value, estimated_input_chars: usize) {
        let mut usage = parse_usage(body);
        let reported = usage.input_tokens.is_some()
            || usage.output_tokens.is_some()
            || usage.reasoning_tokens.is_some()
            || usage.cache_read_tokens.is_some()
            || usage.cache_write_tokens.is_some();
        if !reported {
            usage.input_tokens = Some(estimate_chars(estimated_input_chars));
            usage.output_tokens = serde_json::to_string(body)
                .ok()
                .map(|text| estimate_chars(text.chars().count()));
        }
        let mut event = self.started.completed(now(), usage);
        event.latency_ms = u64::try_from(self.clock.elapsed().as_millis()).ok();
        event.usage_provenance = if reported {
            UsageProvenance::ProviderReported
        } else {
            UsageProvenance::HomunEstimated
        };
        event.cost_provenance = if event.locality == Locality::Local {
            CostProvenance::NotBilled
        } else {
            CostProvenance::Unavailable
        };
        self.recorder.record(event);
        self.terminal = true;
    }

    fn failed(&mut self, class: &str, status: Option<u16>) {
        let mut event = self.started.failed(now(), class, status);
        event.latency_ms = u64::try_from(self.clock.elapsed().as_millis()).ok();
        if event.locality == Locality::Local {
            event.cost_provenance = CostProvenance::NotBilled;
        }
        self.recorder.record(event);
        self.terminal = true;
    }
}

impl Drop for AttemptGuard {
    fn drop(&mut self) {
        if !self.terminal {
            let mut event = self.started.aborted(now(), "cancelled");
            event.latency_ms = u64::try_from(self.clock.elapsed().as_millis()).ok();
            self.recorder.record(event);
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_openai_json(
    http: &reqwest::Client,
    recorder: Arc<dyn UsageRecorder>,
    context: &UsageContext,
    provider_id: &str,
    model_id: &str,
    locality: Locality,
    base_url: &str,
    api_key: Option<&str>,
    payload: &Value,
    timeout: Option<std::time::Duration>,
    estimated_input_chars: usize,
) -> Result<RecordedJsonResponse, InferenceTransportError> {
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut request = http.post(endpoint).json(payload);
    if let Some(api_key) = api_key.filter(|key| !key.is_empty()) {
        request = request.bearer_auth(api_key);
    }
    if let Some(timeout) = timeout {
        request = request.timeout(timeout);
    }
    send_json(
        request,
        recorder,
        context,
        provider_id,
        model_id,
        locality,
        estimated_input_chars,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_ollama_embed(
    http: &reqwest::Client,
    recorder: Arc<dyn UsageRecorder>,
    context: &UsageContext,
    base_url: &str,
    model_id: &str,
    input: &str,
    timeout: Option<std::time::Duration>,
) -> Result<RecordedJsonResponse, InferenceTransportError> {
    let endpoint = format!("{}/api/embed", base_url.trim_end_matches('/'));
    let payload = serde_json::json!({"model": model_id, "input": input});
    let mut request = http.post(endpoint).json(&payload);
    if let Some(timeout) = timeout {
        request = request.timeout(timeout);
    }
    send_json(
        request,
        recorder,
        context,
        "ollama",
        model_id,
        Locality::Local,
        input.chars().count(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn send_json(
    request: reqwest::RequestBuilder,
    recorder: Arc<dyn UsageRecorder>,
    context: &UsageContext,
    provider_id: &str,
    model_id: &str,
    locality: Locality,
    estimated_input_chars: usize,
) -> Result<RecordedJsonResponse, InferenceTransportError> {
    let mut attempt = AttemptGuard::start(recorder, context, provider_id, model_id, locality);
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            attempt.failed("transport", None);
            return Err(InferenceTransportError::Request(error));
        }
    };
    let status = response.status().as_u16();
    let body = if (200..300).contains(&status) {
        match response.json::<Value>().await {
            Ok(body) => body,
            Err(error) => {
                attempt.failed("decode", Some(status));
                return Err(InferenceTransportError::Decode(error));
            }
        }
    } else {
        // Error endpoints are not required to return JSON. Preserve the status
        // and a bounded textual body so callers can keep their existing retry
        // policy while the failed attempt is still accounted exactly once.
        match response.text().await {
            Ok(text) => serde_json::from_str(&text).unwrap_or(Value::String(text)),
            Err(error) => {
                attempt.failed("response_body", Some(status));
                return Err(InferenceTransportError::Decode(error));
            }
        }
    };
    if (200..300).contains(&status) {
        attempt.completed(&body, estimated_input_chars);
    } else {
        attempt.failed("http_status", Some(status));
    }
    Ok(RecordedJsonResponse { status, body })
}

fn parse_usage(body: &Value) -> NormalizedUsage {
    NormalizedUsage {
        input_tokens: body
            .pointer("/usage/prompt_tokens")
            .or_else(|| body.pointer("/usage/input_tokens"))
            .and_then(Value::as_u64),
        output_tokens: body
            .pointer("/usage/completion_tokens")
            .or_else(|| body.pointer("/usage/output_tokens"))
            .and_then(Value::as_u64),
        reasoning_tokens: body
            .pointer("/usage/completion_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64),
        cache_read_tokens: body
            .pointer("/usage/prompt_tokens_details/cached_tokens")
            .or_else(|| body.pointer("/usage/cache_read_input_tokens"))
            .and_then(Value::as_u64),
        cache_write_tokens: body
            .pointer("/usage/cache_creation_input_tokens")
            .and_then(Value::as_u64),
    }
}

fn estimate_chars(chars: usize) -> u64 {
    u64::try_from(chars).unwrap_or(u64::MAX).div_ceil(4).max(1)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or_default()
}
