use crate::provider::{CapabilityDescriptor, InferenceProvider, ProviderAttempt};
use local_first_subagents::{
    GenerateJsonRequest, GenerateJsonResponse, JsonRuntime, RuntimeClientError,
};

/// Adapts any existing [`JsonRuntime`] (e.g. the MLX `RuntimeClient`) into an
/// [`InferenceProvider`], so the current local runtime can sit behind the
/// router alongside cloud providers without rewriting it.
pub struct JsonRuntimeProvider<R> {
    descriptor: CapabilityDescriptor,
    runtime: R,
    usage: std::sync::Arc<dyn local_first_inference_usage::UsageRecorder>,
}

impl<R> JsonRuntimeProvider<R> {
    pub fn new(
        descriptor: CapabilityDescriptor,
        runtime: R,
        usage: std::sync::Arc<dyn local_first_inference_usage::UsageRecorder>,
    ) -> Self {
        Self {
            descriptor,
            runtime,
            usage,
        }
    }
}

impl<R: JsonRuntime> InferenceProvider for JsonRuntimeProvider<R> {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }

    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let attempt = ProviderAttempt::start(
            &self.usage,
            request,
            &self.descriptor,
            &self.descriptor.id,
        );
        match self.runtime.generate_json(request) {
            Ok(response) => {
                let has_reported = response.metrics.prompt_tokens > 0
                    || response.metrics.generation_tokens > 0;
                let usage = if has_reported {
                    local_first_inference_usage::NormalizedUsage {
                        input_tokens: Some(response.metrics.prompt_tokens.into()),
                        output_tokens: Some(response.metrics.generation_tokens.into()),
                        ..Default::default()
                    }
                } else {
                    local_first_inference_usage::NormalizedUsage {
                        input_tokens: Some((request.prompt.chars().count() as u64).div_ceil(4).max(1)),
                        output_tokens: Some((response.raw_output.chars().count() as u64).div_ceil(4).max(1)),
                        ..Default::default()
                    }
                };
                attempt.completed(
                    usage,
                    if has_reported {
                        local_first_inference_usage::UsageProvenance::ProviderReported
                    } else {
                        local_first_inference_usage::UsageProvenance::HomunEstimated
                    },
                );
                Ok(response)
            }
            Err(error) => {
                attempt.failed("runtime", None);
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::Locality;
    use local_first_subagents::TokenMetrics;
    use std::cell::RefCell;

    struct FakeRuntime {
        seen: RefCell<Option<String>>,
    }

    impl JsonRuntime for FakeRuntime {
        fn generate_json(
            &self,
            request: &GenerateJsonRequest,
        ) -> Result<GenerateJsonResponse, RuntimeClientError> {
            *self.seen.borrow_mut() = Some(request.prompt.clone());
            Ok(GenerateJsonResponse {
                valid: true,
                errors: Vec::new(),
                json: serde_json::json!({ "ok": true }),
                raw_output: String::new(),
                repaired: false,
                metrics: TokenMetrics::zero(),
            })
        }
    }

    fn descriptor() -> CapabilityDescriptor {
        CapabilityDescriptor {
            id: "mlx:gemma4".to_string(),
            locality: Locality::Local,
            supports_vision: true,
            supports_tools: true,
            context_window: 8_192,
            approx_tokens_per_second: None,
        }
    }

    #[test]
    fn delegates_generate_json_to_wrapped_runtime() {
        let provider = JsonRuntimeProvider::new(
            descriptor(),
            FakeRuntime {
                seen: RefCell::new(None),
            },
            std::sync::Arc::new(local_first_inference_usage::NoopUsageRecorder),
        );
        let request = GenerateJsonRequest {
            usage: local_first_inference_usage::UsageContext::new(
                "runtime-test",
                local_first_inference_usage::InferencePurpose::Evaluation,
                "test",
            ),
            prompt: "hello".to_string(),
            max_tokens: 8,
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: None,
            json_schema: None,
            required_keys: Vec::new(),
            repair: false,
        };
        let response = provider.generate_json(&request).unwrap();
        assert!(response.valid);
        assert_eq!(provider.descriptor().id, "mlx:gemma4");
    }
}
