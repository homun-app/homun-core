//! Provider registry: the persisted catalog of inference providers (OpenAI-compat,
//! Anthropic, Ollama, …), each with its own base URL and a cached model catalog.
//!
//! This is Phase 1 of the multi-provider / per-role model routing work. It owns
//! the data model + JSON (de)serialization + capability inference, and stays pure
//! (no secret store / HTTP) so it is testable; `main.rs` wires the I/O, the
//! per-provider API keys (encrypted secret store) and the HTTP model listing.

use serde::{Deserialize, Serialize};

/// How to talk to a provider's HTTP API. Chat for every kind goes through the
/// OpenAI-compatible `/chat/completions` surface (Anthropic via its own path is
/// handled by the router); the kind also decides how we *list* models.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// Any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Together, Z.ai…).
    OpenaiCompat,
    /// Local Ollama (OpenAI-compatible for chat; lists via `/api/tags`).
    Ollama,
    /// Anthropic Messages API (lists via `/v1/models` with `x-api-key`).
    Anthropic,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::OpenaiCompat => "openai_compat",
            ProviderKind::Ollama => "ollama",
            ProviderKind::Anthropic => "anthropic",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "openai_compat" | "openai-compat" | "openai" | "openrouter" | "groq" | "together"
            | "zai" | "z.ai" | "deepseek" | "moonshot" | "mistral" | "xai" | "custom" => {
                Some(ProviderKind::OpenaiCompat)
            }
            "ollama" => Some(ProviderKind::Ollama),
            "anthropic" => Some(ProviderKind::Anthropic),
            _ => None,
        }
    }

    /// Whether this kind authenticates with a bearer token on the model-list call.
    pub fn lists_with_bearer(self) -> bool {
        matches!(self, ProviderKind::OpenaiCompat)
    }
}

/// A single model offered by a provider, with capability flags used by the
/// (Phase 2) role auto-matcher. Flags are inferred heuristically on import and
/// can be overridden by the user later.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub tools: bool,
    /// Modality: "text" | "embedding" | "image" — text is the default.
    #[serde(default = "default_modality")]
    pub modality: String,
    #[serde(default)]
    pub context_window: Option<u32>,
}

fn default_modality() -> String {
    "text".to_string()
}

impl ModelEntry {
    /// Builds an entry from a bare model id, inferring capabilities heuristically.
    /// Heuristics are best-effort hints for auto-matching, never correctness gates.
    pub fn inferred(id: &str) -> Self {
        let lower = id.to_ascii_lowercase();
        let is_embedding = lower.contains("embed");
        let is_image = lower.contains("dall-e")
            || lower.contains("dalle")
            || lower.contains("stable-diffusion")
            || lower.contains("sdxl")
            || lower.contains("flux")
            || lower.contains("image");
        let modality = if is_embedding {
            "embedding"
        } else if is_image {
            "image"
        } else {
            "text"
        };
        let vision = !is_embedding
            && (lower.contains("-vl")
                || lower.contains("vision")
                || lower.contains("llava")
                || lower.contains("gpt-4o")
                || lower.contains("gpt-4.1")
                || lower.contains("o3")
                || lower.contains("o4")
                || lower.contains("claude-3")
                || lower.contains("claude-sonnet")
                || lower.contains("claude-opus")
                || lower.contains("gemini")
                || lower.contains("qwen3-vl")
                || lower.contains("pixtral"));
        // Text/chat models support tool calls; embedding/image models do not.
        let tools = modality == "text";
        let context_window = infer_context_window(&lower);
        ModelEntry {
            id: id.to_string(),
            vision,
            tools,
            modality: modality.to_string(),
            context_window,
        }
    }
}

fn infer_context_window(lower: &str) -> Option<u32> {
    if lower.contains("claude") {
        Some(200_000)
    } else if lower.contains("gpt-4o") || lower.contains("gpt-4.1") || lower.contains("o3") {
        Some(128_000)
    } else if lower.contains("gemini") {
        Some(1_000_000)
    } else if lower.contains("minimax") || lower.contains("glm") || lower.contains("qwen") {
        Some(200_000)
    } else {
        None
    }
}

/// A configured provider plus its (cached) model catalog. The API key lives in
/// the encrypted secret store, keyed by `id`, never in this struct.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderEntry {
    /// Stable slug, unique within the registry (e.g. "ollama", "openrouter").
    pub id: String,
    pub label: String,
    pub kind: ProviderKind,
    pub base_url: String,
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    /// The model selected for this provider (Phase 1 single-model; Phase 2 roles
    /// refine this into per-task bindings).
    #[serde(default)]
    pub active_model: Option<String>,
    #[serde(default)]
    pub models_fetched_at: Option<String>,
}

impl ProviderEntry {
    pub fn new(id: String, label: String, kind: ProviderKind, base_url: String) -> Self {
        ProviderEntry {
            id,
            label,
            kind,
            base_url: base_url.trim_end_matches('/').to_string(),
            models: Vec::new(),
            active_model: None,
            models_fetched_at: None,
        }
    }

    /// The provider's chosen model, falling back to the first text model in its
    /// catalog (so a freshly-added provider is usable before an explicit pick).
    pub fn effective_model(&self) -> Option<String> {
        if let Some(model) = self.active_model.as_deref().filter(|m| !m.is_empty()) {
            return Some(model.to_string());
        }
        self.models
            .iter()
            .find(|m| m.modality == "text")
            .or_else(|| self.models.first())
            .map(|m| m.id.clone())
    }

    /// The model-list endpoint URL for this provider's kind.
    pub fn models_endpoint(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        match self.kind {
            ProviderKind::Ollama => {
                // Ollama serves OpenAI-compat at /v1; /api/tags lives at the root.
                let root = base.strip_suffix("/v1").unwrap_or(base);
                format!("{root}/api/tags")
            }
            ProviderKind::OpenaiCompat => format!("{base}/models"),
            ProviderKind::Anthropic => format!("{base}/v1/models"),
        }
    }
}

/// The whole persisted registry. `active_provider_id` is the provider used for
/// inference until Phase 2 introduces per-role bindings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRegistry {
    #[serde(default)]
    pub providers: Vec<ProviderEntry>,
    #[serde(default)]
    pub active_provider_id: Option<String>,
}

impl ProviderRegistry {
    pub fn get(&self, id: &str) -> Option<&ProviderEntry> {
        self.providers.iter().find(|p| p.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut ProviderEntry> {
        self.providers.iter_mut().find(|p| p.id == id)
    }

    /// The currently active provider (explicit `active_provider_id`, else the
    /// first configured one).
    pub fn active(&self) -> Option<&ProviderEntry> {
        self.active_provider_id
            .as_deref()
            .and_then(|id| self.get(id))
            .or_else(|| self.providers.first())
    }

    /// Inserts or replaces a provider (matched by id), preserving its cached
    /// models when the caller did not supply new ones. Returns the stored id.
    pub fn upsert(&mut self, mut entry: ProviderEntry) -> String {
        if let Some(existing) = self.get_mut(&entry.id) {
            if entry.models.is_empty() {
                entry.models = std::mem::take(&mut existing.models);
                entry.models_fetched_at = existing.models_fetched_at.take();
            }
            if entry.active_model.is_none() {
                entry.active_model = existing.active_model.take();
            }
            *existing = entry.clone();
        } else {
            self.providers.push(entry.clone());
        }
        if self.active_provider_id.is_none() {
            self.active_provider_id = Some(entry.id.clone());
        }
        entry.id
    }

    /// Removes a provider; if it was active, the active pointer moves to the
    /// first remaining provider (or clears).
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.providers.len();
        self.providers.retain(|p| p.id != id);
        let removed = self.providers.len() != before;
        if self.active_provider_id.as_deref() == Some(id) {
            self.active_provider_id = self.providers.first().map(|p| p.id.clone());
        }
        removed
    }
}

/// Slugifies a free-text label into a stable, url/file-safe provider id.
pub fn slugify(label: &str) -> String {
    let slug: String = label
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let collapsed = slug
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.is_empty() {
        "provider".to_string()
    } else {
        collapsed
    }
}

/// Parses a provider model-list HTTP response body into bare model ids,
/// according to the provider kind. Tolerant of missing fields.
pub fn parse_models_response(kind: ProviderKind, body: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    match kind {
        ProviderKind::Ollama => {
            if let Some(models) = body.get("models").and_then(|v| v.as_array()) {
                for m in models {
                    if let Some(name) = m.get("name").and_then(|v| v.as_str()) {
                        out.push(name.to_string());
                    } else if let Some(model) = m.get("model").and_then(|v| v.as_str()) {
                        out.push(model.to_string());
                    }
                }
            }
        }
        ProviderKind::OpenaiCompat | ProviderKind::Anthropic => {
            if let Some(data) = body.get("data").and_then(|v| v.as_array()) {
                for entry in data {
                    if let Some(id) = entry.get("id").and_then(|v| v.as_str()) {
                        out.push(id.to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_makes_stable_ids() {
        assert_eq!(slugify("OpenRouter"), "openrouter");
        assert_eq!(slugify("Z.ai / GLM"), "z-ai-glm");
        assert_eq!(slugify("  "), "provider");
    }

    #[test]
    fn capability_inference_distinguishes_modalities() {
        let embed = ModelEntry::inferred("nomic-embed-text");
        assert_eq!(embed.modality, "embedding");
        assert!(!embed.tools && !embed.vision);

        let vision = ModelEntry::inferred("qwen3-vl:235b");
        assert_eq!(vision.modality, "text");
        assert!(vision.vision && vision.tools);

        let img = ModelEntry::inferred("dall-e-3");
        assert_eq!(img.modality, "image");
        assert!(!img.tools);

        let chat = ModelEntry::inferred("minimax-m2.7:cloud");
        assert!(chat.tools && !chat.vision);
        assert_eq!(chat.context_window, Some(200_000));
    }

    #[test]
    fn ollama_models_endpoint_uses_api_tags() {
        let p = ProviderEntry::new(
            "ollama".into(),
            "Ollama".into(),
            ProviderKind::Ollama,
            "http://127.0.0.1:11434/v1".into(),
        );
        assert_eq!(p.models_endpoint(), "http://127.0.0.1:11434/api/tags");

        let oai = ProviderEntry::new(
            "openai".into(),
            "OpenAI".into(),
            ProviderKind::OpenaiCompat,
            "https://api.openai.com/v1".into(),
        );
        assert_eq!(oai.models_endpoint(), "https://api.openai.com/v1/models");
    }

    #[test]
    fn upsert_preserves_cached_models_and_sets_active() {
        let mut reg = ProviderRegistry::default();
        let mut p = ProviderEntry::new(
            "ollama".into(),
            "Ollama".into(),
            ProviderKind::Ollama,
            "http://127.0.0.1:11434/v1".into(),
        );
        p.models = vec![ModelEntry::inferred("minimax-m2.7:cloud")];
        reg.upsert(p);
        assert_eq!(reg.active_provider_id.as_deref(), Some("ollama"));

        // Re-upsert without models keeps the cached catalog.
        reg.upsert(ProviderEntry::new(
            "ollama".into(),
            "Ollama locale".into(),
            ProviderKind::Ollama,
            "http://127.0.0.1:11434/v1".into(),
        ));
        assert_eq!(reg.get("ollama").unwrap().models.len(), 1);
        assert_eq!(reg.get("ollama").unwrap().label, "Ollama locale");
    }

    #[test]
    fn parse_ollama_and_openai_lists() {
        let ollama = serde_json::json!({"models":[{"name":"a"},{"model":"b"}]});
        assert_eq!(parse_models_response(ProviderKind::Ollama, &ollama), vec!["a", "b"]);
        let oai = serde_json::json!({"data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"}]});
        assert_eq!(
            parse_models_response(ProviderKind::OpenaiCompat, &oai),
            vec!["gpt-4o", "gpt-4o-mini"]
        );
    }

    #[test]
    fn remove_reassigns_active() {
        let mut reg = ProviderRegistry::default();
        reg.upsert(ProviderEntry::new("a".into(), "A".into(), ProviderKind::Ollama, "u".into()));
        reg.upsert(ProviderEntry::new("b".into(), "B".into(), ProviderKind::OpenaiCompat, "u".into()));
        reg.active_provider_id = Some("a".into());
        assert!(reg.remove("a"));
        assert_eq!(reg.active_provider_id.as_deref(), Some("b"));
    }
}
