use local_first_subagents::{GenerateJsonRequest, GenerateJsonResponse, RuntimeClientError};
use serde::{Deserialize, Serialize};

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
