use local_first_subagents::{GenerateJsonRequest, GenerateJsonResponse, RuntimeClientError};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Where a provider runs. The router treats this as a privacy boundary: local
/// stays on device, cloud leaves the device and is deny-by-default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Locality {
    Local,
    Cloud,
}

impl Locality {
    pub fn is_cloud(self) -> bool {
        matches!(self, Locality::Cloud)
    }
}

/// Static, declared capabilities of a provider/model. The router selects on
/// these plus policy; it never infers them at call time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityDescriptor {
    /// Stable id for routing/audit, e.g. `ollama:qwen2.5-vl` or `anthropic:claude`.
    pub id: String,
    pub locality: Locality,
    pub supports_vision: bool,
    pub supports_tools: bool,
    pub context_window: u32,
    /// Rough throughput hint used only for tie-breaking, never correctness.
    pub approx_tokens_per_second: Option<f32>,
}

impl CapabilityDescriptor {
    pub fn satisfies(&self, requirements: &Requirements) -> bool {
        (!requirements.needs_vision || self.supports_vision)
            && (!requirements.needs_tools || self.supports_tools)
            && self.context_window >= requirements.min_context_window
    }
}

/// What a single inference call needs. The router matches these against each
/// provider's `CapabilityDescriptor`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Requirements {
    pub needs_vision: bool,
    pub needs_tools: bool,
    pub min_context_window: u32,
}

/// One inference backend behind the router: a local engine (mistral.rs, later
/// llama.cpp, MLX) or a cloud endpoint (OpenAI-compatible, Anthropic).
///
/// The trait is deliberately small for the first slice: structured JSON
/// generation plus a declared capability descriptor. Text/stream/vision/tool
/// surfaces are added the same way as the system needs them.
pub trait InferenceProvider {
    fn descriptor(&self) -> &CapabilityDescriptor;

    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError>;
}

pub(crate) struct ProviderAttempt<'a> {
    recorder: &'a dyn local_first_inference_usage::UsageRecorder,
    started: local_first_inference_usage::UsageAttemptEvent,
    clock: std::time::Instant,
}

impl<'a> ProviderAttempt<'a> {
    pub(crate) fn start(
        recorder: &'a Arc<dyn local_first_inference_usage::UsageRecorder>,
        request: &GenerateJsonRequest,
        descriptor: &CapabilityDescriptor,
        model_id: &str,
    ) -> Self {
        let provider_id = descriptor.id.split_once(':').map(|(provider, _)| provider).unwrap_or(&descriptor.id);
        let locality = match descriptor.locality {
            Locality::Local => local_first_inference_usage::Locality::Local,
            Locality::Cloud => local_first_inference_usage::Locality::Cloud,
        };
        let recorded_at = now();
        let started = local_first_inference_usage::UsageAttemptEvent::started(
            request.usage.clone(),
            uuid::Uuid::new_v4().to_string(),
            provider_id,
            model_id,
            locality,
            recorded_at,
        );
        recorder.record(started.clone());
        Self { recorder: recorder.as_ref(), started, clock: std::time::Instant::now() }
    }

    pub(crate) fn completed(
        self,
        usage: local_first_inference_usage::NormalizedUsage,
        provenance: local_first_inference_usage::UsageProvenance,
    ) {
        let mut event = self.started.completed(now(), usage);
        event.latency_ms = u64::try_from(self.clock.elapsed().as_millis()).ok();
        event.usage_provenance = provenance;
        event.cost_provenance = if event.locality == local_first_inference_usage::Locality::Local {
            local_first_inference_usage::CostProvenance::NotBilled
        } else {
            local_first_inference_usage::CostProvenance::Unavailable
        };
        self.recorder.record(event);
    }

    pub(crate) fn failed(self, error_class: &str, upstream_status: Option<u16>) {
        let mut event = self.started.failed(now(), error_class, upstream_status);
        event.latency_ms = u64::try_from(self.clock.elapsed().as_millis()).ok();
        if event.locality == local_first_inference_usage::Locality::Local {
            event.cost_provenance = local_first_inference_usage::CostProvenance::NotBilled;
        }
        self.recorder.record(event);
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) mod usage_tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub(crate) struct RecordingUsageRecorder {
        pub(crate) events: Mutex<Vec<local_first_inference_usage::UsageAttemptEvent>>,
    }

    impl local_first_inference_usage::UsageRecorder for RecordingUsageRecorder {
        fn record(&self, event: local_first_inference_usage::UsageAttemptEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    #[test]
    fn local_attempts_are_explicitly_not_billed() {
        let recorder = Arc::new(RecordingUsageRecorder::default());
        let request = GenerateJsonRequest {
            usage: local_first_inference_usage::UsageContext::new(
                "local-call",
                local_first_inference_usage::InferencePurpose::Evaluation,
                "test",
            ),
            prompt: "test".to_string(),
            max_tokens: 4,
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: None,
            json_schema: None,
            required_keys: Vec::new(),
            repair: false,
        };
        let descriptor = CapabilityDescriptor {
            id: "mistralrs:test".to_string(),
            locality: Locality::Local,
            supports_vision: false,
            supports_tools: false,
            context_window: 1_024,
            approx_tokens_per_second: None,
        };
        ProviderAttempt::start(
            &(recorder.clone() as Arc<dyn local_first_inference_usage::UsageRecorder>),
            &request,
            &descriptor,
            "test",
        )
        .completed(
            local_first_inference_usage::NormalizedUsage {
                input_tokens: Some(1),
                output_tokens: Some(1),
                ..Default::default()
            },
            local_first_inference_usage::UsageProvenance::HomunEstimated,
        );
        let events = recorder.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[1].cost_provenance,
            local_first_inference_usage::CostProvenance::NotBilled
        );
    }
}
