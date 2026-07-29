//! In-process local inference via [`mistral.rs`](https://github.com/EricLBuehler/mistral.rs).
//!
//! Feature-gated (`local-mistralrs`) because it pulls a large, accelerator-aware
//! dependency tree; default builds do not compile it. This is the Rust-native
//! local backbone from ADR 0007: a single binary, cross-OS, vision-capable.
//!
//! On Apple Silicon enable mistral.rs's `metal` feature; on NVIDIA, `cuda`.

use crate::json_parse::json_response_from_text;
use crate::provider::{CapabilityDescriptor, InferenceProvider, ProviderAttempt};
use local_first_subagents::{
    GenerateJsonRequest, GenerateJsonResponse, RuntimeClientError, TokenMetrics,
};
use mistralrs::{
    IsqBits, Model, ModelBuilder, PagedAttentionMetaBuilder, TextMessageRole, TextMessages,
};
use tokio::runtime::Runtime;

/// Error loading or running a local mistral.rs model.
#[derive(Debug)]
pub enum MistralRsError {
    Runtime(std::io::Error),
    Model(String),
}

impl std::fmt::Display for MistralRsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MistralRsError::Runtime(error) => write!(formatter, "tokio runtime: {error}"),
            MistralRsError::Model(message) => write!(formatter, "mistral.rs model: {message}"),
        }
    }
}

impl std::error::Error for MistralRsError {}

/// A local model served in-process by mistral.rs, exposed as an
/// [`InferenceProvider`]. mistral.rs is async; this provider owns a Tokio
/// runtime and blocks on it so it fits the synchronous provider contract used
/// by the rest of the system.
pub struct MistralRsProvider {
    descriptor: CapabilityDescriptor,
    model: Model,
    runtime: Runtime,
    usage: std::sync::Arc<dyn local_first_inference_usage::UsageRecorder>,
}

impl MistralRsProvider {
    /// Loads `model_id` (a Hugging Face repo or local path) with in-situ 4-bit
    /// quantization. Blocking: model load can take a while on first run.
    pub fn load(
        descriptor: CapabilityDescriptor,
        model_id: impl Into<String>,
        usage: std::sync::Arc<dyn local_first_inference_usage::UsageRecorder>,
    ) -> Result<Self, MistralRsError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(MistralRsError::Runtime)?;
        let model_id = model_id.into();
        let model = runtime
            .block_on(async move {
                // PagedAttention improves decode throughput; if it is unavailable
                // on this platform, fall back to a plain build rather than failing.
                let paged = PagedAttentionMetaBuilder::default().build();
                let builder = ModelBuilder::new(model_id)
                    .with_auto_isq(IsqBits::Four)
                    .with_logging();
                let builder = match paged {
                    Ok(paged) => builder.with_paged_attn(paged),
                    Err(_) => builder,
                };
                builder.build().await
            })
            .map_err(|error| MistralRsError::Model(error.to_string()))?;
        Ok(Self {
            descriptor,
            model,
            runtime,
            usage,
        })
    }
}

/// The caller's timeout bound (e.g. the steering decision's 45s) as a `Duration`.
/// A missing, non-finite or non-positive value means "no bound" — never a zero
/// timeout, which would fail every request instantly.
fn timeout_duration(seconds: Option<f64>) -> Option<std::time::Duration> {
    seconds
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(std::time::Duration::from_secs_f64)
}

impl InferenceProvider for MistralRsProvider {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }

    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let attempt =
            ProviderAttempt::start(&self.usage, request, &self.descriptor, &self.descriptor.id);
        let messages = TextMessages::new().add_message(TextMessageRole::User, &request.prompt);
        let request_future = self.model.send_chat_request(messages);
        // Without this the caller's bound was advisory only: a hung local
        // generation held the interpreter worker forever (triage MINOR 7).
        // The elapsed case is mapped straight onto this crate's error type —
        // mistral.rs reports its own failures through `anyhow`, which is not a
        // dependency here, so there is no shared error type to funnel into.
        let outcome = match timeout_duration(request.request_timeout_seconds) {
            Some(bound) => self
                .runtime
                .block_on(async move { tokio::time::timeout(bound, request_future).await })
                .map_err(|_elapsed| RuntimeClientError::Runtime {
                    code: "mistralrs_timeout".to_string(),
                    message: format!("local generation exceeded {bound:?}"),
                }),
            None => Ok(self.runtime.block_on(request_future)),
        };
        let response = match outcome {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                attempt.failed("runtime", None);
                return Err(RuntimeClientError::Runtime {
                    code: "mistralrs_error".to_string(),
                    message: error.to_string(),
                });
            }
            Err(timeout_error) => {
                attempt.failed("timeout", None);
                return Err(timeout_error);
            }
        };

        let content = response
            .choices
            .first()
            .and_then(|choice| choice.message.content.as_ref())
            .cloned()
            .unwrap_or_default();

        let metrics = TokenMetrics {
            prompt_tps: response.usage.avg_prompt_tok_per_sec as f64,
            generation_tps: response.usage.avg_compl_tok_per_sec as f64,
            ..TokenMetrics::zero()
        };
        let parsed = json_response_from_text(content, request, metrics);
        attempt.completed(
            local_first_inference_usage::NormalizedUsage {
                input_tokens: Some((request.prompt.chars().count() as u64).div_ceil(4).max(1)),
                output_tokens: Some(
                    (parsed.raw_output.chars().count() as u64)
                        .div_ceil(4)
                        .max(1),
                ),
                ..Default::default()
            },
            local_first_inference_usage::UsageProvenance::HomunEstimated,
        );
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::timeout_duration;
    use std::time::Duration;

    #[test]
    fn timeout_duration_maps_only_positive_finite_seconds() {
        assert_eq!(timeout_duration(Some(45.0)), Some(Duration::from_secs(45)));
        assert_eq!(
            timeout_duration(Some(0.5)),
            Some(Duration::from_millis(500))
        );
        // No bound configured, or a nonsense bound, must never become a 0s timeout
        // that fails every request instantly — it means "no timeout".
        assert_eq!(timeout_duration(None), None);
        assert_eq!(timeout_duration(Some(0.0)), None);
        assert_eq!(timeout_duration(Some(-1.0)), None);
        assert_eq!(timeout_duration(Some(f64::NAN)), None);
        assert_eq!(timeout_duration(Some(f64::INFINITY)), None);
    }
}
