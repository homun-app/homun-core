//! In-process local inference via [`mistral.rs`](https://github.com/EricLBuehler/mistral.rs).
//!
//! Feature-gated (`local-mistralrs`) because it pulls a large, accelerator-aware
//! dependency tree; default builds do not compile it. This is the Rust-native
//! local backbone from ADR 0007: a single binary, cross-OS, vision-capable.
//!
//! On Apple Silicon enable mistral.rs's `metal` feature; on NVIDIA, `cuda`.

use crate::json_parse::json_response_from_text;
use crate::provider::{CapabilityDescriptor, InferenceProvider};
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
}

impl MistralRsProvider {
    /// Loads `model_id` (a Hugging Face repo or local path) with in-situ 4-bit
    /// quantization. Blocking: model load can take a while on first run.
    pub fn load(
        descriptor: CapabilityDescriptor,
        model_id: impl Into<String>,
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
        })
    }
}

impl InferenceProvider for MistralRsProvider {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }

    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let messages = TextMessages::new().add_message(TextMessageRole::User, &request.prompt);
        let response = self
            .runtime
            .block_on(self.model.send_chat_request(messages))
            .map_err(|error| RuntimeClientError::Runtime {
                code: "mistralrs_error".to_string(),
                message: error.to_string(),
            })?;

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
        Ok(json_response_from_text(content, request, metrics))
    }
}
