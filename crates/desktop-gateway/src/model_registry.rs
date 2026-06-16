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
    /// Extended-reasoning ("thinking") model.
    #[serde(default)]
    pub reasoning: bool,
    /// Modality: "text" | "embedding" | "image" — text is the default.
    #[serde(default = "default_modality")]
    pub modality: String,
    #[serde(default)]
    pub context_window: Option<u32>,
    /// Qualitative profile ("in cosa eccelle") used to RANK among capability-eligible
    /// models. Optional so old catalogs still load.
    #[serde(default)]
    pub profile: Option<ModelProfile>,
}

fn default_modality() -> String {
    "text".to_string()
}

/// Coarse capability/cost tier used by the ranker. Fast = cheap/quick, Balanced
/// = strong general use, Reasoning = deep/complex work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    Fast,
    Balanced,
    Reasoning,
}

impl ModelTier {
    fn rank(self) -> i32 {
        match self {
            ModelTier::Fast => 0,
            ModelTier::Balanced => 1,
            ModelTier::Reasoning => 2,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ModelTier::Fast => "fast",
            ModelTier::Balanced => "balanced",
            ModelTier::Reasoning => "reasoning",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "fast" => Some(ModelTier::Fast),
            "balanced" => Some(ModelTier::Balanced),
            "reasoning" => Some(ModelTier::Reasoning),
            _ => None,
        }
    }
}

/// A model's qualitative profile. `strengths` is free text ("excels at …") for a
/// future LLM-router / UI; `tier` drives today's heuristic ranking. `source`
/// records provenance (curated | inferred | generated | user) and `confidence`
/// (0..100) lets the UI flag low-confidence auto profiles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelProfile {
    pub tier: ModelTier,
    #[serde(default)]
    pub strengths: String,
    #[serde(default = "default_profile_source")]
    pub source: String,
    #[serde(default)]
    pub confidence: u8,
}

fn default_profile_source() -> String {
    "inferred".to_string()
}

/// Curated/inferred profile from a model id. Known families get a curated tier +
/// strengths (high confidence); unknown text models default to Balanced with low
/// confidence (a later increment can replace these with model-generated drafts).
fn infer_profile(lower: &str, modality: &str) -> ModelProfile {
    let curated = |tier: ModelTier, strengths: &str| ModelProfile {
        tier,
        strengths: strengths.to_string(),
        source: "curated".to_string(),
        confidence: 80,
    };
    if modality == "embedding" {
        return curated(ModelTier::Fast, "Embeddings for memory/RAG.");
    }
    if modality == "image" {
        return curated(ModelTier::Balanced, "Image generation.");
    }
    // Small/fast tiers FIRST (so "gpt-4o-mini" → fast, not balanced).
    let fast_name_markers = ["mini", "haiku", "flash", "small", "ministral", "gemma", "lite", "nano", "tiny"];
    if fast_name_markers.iter().any(|m| lower.contains(m)) || has_small_param_size(lower) {
        return curated(
            ModelTier::Fast,
            "Fast and cheap: extraction, classification, short tasks.",
        );
    }
    if is_reasoning_model(lower) {
        return curated(
            ModelTier::Reasoning,
            "Deep reasoning: complex problems, planning, agentic coding.",
        );
    }
    let balanced_families = [
        "sonnet", "gpt-4o", "gpt-4.1", "gpt-5", "minimax", "glm", "qwen", "gemini", "mistral",
        "kimi", "deepseek", "llama", "command",
    ];
    if balanced_families.iter().any(|m| lower.contains(m)) {
        return curated(
            ModelTier::Balanced,
            "Strong general purpose: comprehension, tool-use, large context.",
        );
    }
    ModelProfile {
        tier: ModelTier::Balanced,
        strengths: String::new(),
        source: "inferred".to_string(),
        confidence: 30,
    }
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
        let reasoning = modality == "text" && is_reasoning_model(&lower);
        let context_window = infer_context_window(&lower);
        ModelEntry {
            id: id.to_string(),
            vision,
            tools,
            reasoning,
            modality: modality.to_string(),
            context_window,
            profile: Some(infer_profile(&lower, modality)),
        }
    }
}

/// Heuristic: an extended-reasoning ("thinking") model.
fn is_reasoning_model(lower: &str) -> bool {
    ["opus", "o1", "o3", "o4", "-r1", "deepseek-r", "reasoner", "thinking"]
        .iter()
        .any(|m| lower.contains(m))
}

/// True if the model id carries a SMALL parameter-size token (≤ 13B), e.g.
/// `llama3.1:8b`, `qwen2.5:3b`. Parses a digit-run immediately followed by `b`
/// as the size, so it does NOT mis-match large sizes like `671b`/`480b` (the old
/// substring check treated "671b" as containing "1b").
fn has_small_param_size(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            // A parameter size is "<digits>b" (e.g. 8b, 70b) — the digit run must
            // be immediately followed by 'b'.
            if i < bytes.len() && (bytes[i] == b'b' || bytes[i] == b'B') {
                if let Ok(size) = lower[start..i].parse::<u32>() {
                    if size >= 1 && size <= 13 {
                        return true;
                    }
                }
            }
        } else {
            i += 1;
        }
    }
    false
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
    /// Per-role model bindings (Phase 2). A missing/auto entry means "pick the
    /// best model by capability".
    #[serde(default)]
    pub roles: std::collections::BTreeMap<String, RoleBinding>,
    /// User override for the LLM concurrency limit (ResourceGovernor LlmInference).
    /// `None` = infer from locality (loopback 1, cloud 4); `Some(n)` = force n.
    /// The provider's kind/base_url still drives the inferred fallback when None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_concurrency_override: Option<u32>,
}

impl ProviderRegistry {
    /// Whether the user has forced the LLM concurrency limit (vs. locality inference).
    pub fn llm_concurrency_override(&self) -> Option<u32> {
        self.llm_concurrency_override.filter(|&n| n >= 1)
    }
}

/// A per-role model binding. Both fields present = manual; otherwise "auto"
/// (the capability matcher picks the best model).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleBinding {
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// Static catalog of the roles the app actually routes through a model.
pub struct RoleInfo {
    pub key: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

/// The roles wired today. Vision/embeddings/image-gen will be added here when
/// their call sites exist (image generation is a separate, later phase).
pub const ROLES: &[RoleInfo] = &[
    RoleInfo {
        key: "orchestrator",
        label: "General management",
        description: "Understanding requests, creating and planning tasks, synthesis.",
    },
    RoleInfo {
        key: "coding",
        label: "Coding",
        description: "Analyzing and modifying code in project chats: needs a strong model for code, tool-use and wide context. If not set, uses the General management model.",
    },
    RoleInfo {
        key: "browser",
        label: "Browser model",
        description: "Planner for the observe-act web loop: it is the heaviest consumer (one call per micro-action). A fast model here and a more capable one for chat and synthesis is often a good tradeoff.",
    },
    RoleInfo {
        key: "memory",
        label: "Memory",
        description: "Extracting facts/preferences from conversations: a fast and cheap model is best.",
    },
];

/// Hard requirements a model must meet to serve a role (the gate), plus a soft
/// `preferred_tier` used to RANK among the eligible models.
#[derive(Debug, Clone, Copy)]
pub struct RoleReq {
    pub needs_tools: bool,
    pub needs_vision: bool,
    pub modality: &'static str,
    pub preferred_tier: Option<ModelTier>,
}

pub fn role_requirements(role: &str) -> RoleReq {
    match role {
        "vision" => RoleReq {
            needs_tools: false,
            needs_vision: true,
            modality: "text",
            preferred_tier: Some(ModelTier::Balanced),
        },
        "embeddings" => RoleReq {
            needs_tools: false,
            needs_vision: false,
            modality: "embedding",
            preferred_tier: None,
        },
        // The orchestrator does comprehension/planning → prefer the reasoning tier.
        "orchestrator" => RoleReq {
            needs_tools: true,
            needs_vision: false,
            modality: "text",
            preferred_tier: Some(ModelTier::Reasoning),
        },
        // Coding wants strong reasoning + tool-use (edits/build/test) on a wide
        // context; same hard gate as the orchestrator.
        "coding" => RoleReq {
            needs_tools: true,
            needs_vision: false,
            modality: "text",
            preferred_tier: Some(ModelTier::Reasoning),
        },
        // Browser/observe-act wants a fast-but-capable tool model.
        "browser" => RoleReq {
            needs_tools: true,
            needs_vision: false,
            modality: "text",
            preferred_tier: Some(ModelTier::Balanced),
        },
        // Memory extraction is simple structured output run in the background on
        // every salient turn → prefer a fast, cheap model; no tools needed.
        "memory" => RoleReq {
            needs_tools: false,
            needs_vision: false,
            modality: "text",
            preferred_tier: Some(ModelTier::Fast),
        },
        _ => RoleReq {
            needs_tools: true,
            needs_vision: false,
            modality: "text",
            preferred_tier: None,
        },
    }
}

/// The provider+model chosen for a role, plus whether it came from auto-matching.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRole {
    pub role: String,
    pub provider_id: String,
    pub model: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub auto: bool,
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

    /// Resolves the model for a role: an explicit (valid) manual binding wins,
    /// otherwise the capability auto-matcher picks the best available model.
    pub fn resolve_role(&self, role: &str) -> Option<ResolvedRole> {
        if let Some(binding) = self.roles.get(role)
            && let (Some(pid), Some(model)) =
                (binding.provider_id.as_deref(), binding.model.as_deref())
            && !pid.is_empty()
            && !model.is_empty()
            && let Some(provider) = self.get(pid)
        {
            return Some(ResolvedRole {
                role: role.to_string(),
                provider_id: provider.id.clone(),
                model: model.to_string(),
                kind: provider.kind,
                base_url: provider.base_url.clone(),
                auto: false,
            });
        }
        self.auto_role(role)
    }

    /// Auto-match (two-stage): STAGE 1 filters by the role's hard requirements
    /// (modality/tools/vision — correctness gate); STAGE 2 RANKS the eligible
    /// models by fit to the role's preferred tier, then context window, then the
    /// active provider, then registry order. Falls back to the active provider's
    /// effective model when no catalog is loaded.
    /// STAGE 1 (gate): models passing a role's hard capability requirements.
    /// Shared by the heuristic ranker and the semantic (LLM) router.
    pub fn eligible_models(&self, role: &str) -> Vec<(&ProviderEntry, &ModelEntry)> {
        let req = role_requirements(role);
        let mut out = Vec::new();
        for provider in &self.providers {
            for model in &provider.models {
                if model.modality != req.modality {
                    continue;
                }
                if req.needs_tools && !model.tools {
                    continue;
                }
                if req.needs_vision && !model.vision {
                    continue;
                }
                out.push((provider, model));
            }
        }
        out
    }

    fn auto_role(&self, role: &str) -> Option<ResolvedRole> {
        let req = role_requirements(role);
        let active = self.active_provider_id.as_deref();
        let mut candidates = self.eligible_models(role);
        // Distance from a model's tier to the role's preferred tier (0 = exact).
        // Unprofiled models are treated as Balanced. No preference → distance 0.
        let tier_distance = |model: &ModelEntry| -> i32 {
            match req.preferred_tier {
                None => 0,
                Some(pref) => {
                    let tier = model
                        .profile
                        .as_ref()
                        .map(|p| p.tier)
                        .unwrap_or(ModelTier::Balanced);
                    (tier.rank() - pref.rank()).abs()
                }
            }
        };
        candidates.sort_by(|(pa, ma), (pb, mb)| {
            // 1) closest tier wins (ascending distance)
            tier_distance(ma)
                .cmp(&tier_distance(mb))
                // 2) larger context window
                .then(
                    mb.context_window
                        .unwrap_or(0)
                        .cmp(&ma.context_window.unwrap_or(0)),
                )
                // 3) prefer the active provider
                .then(
                    (active == Some(pb.id.as_str())).cmp(&(active == Some(pa.id.as_str()))),
                )
        });
        if let Some((provider, model)) = candidates.first() {
            return Some(ResolvedRole {
                role: role.to_string(),
                provider_id: provider.id.clone(),
                model: model.id.clone(),
                kind: provider.kind,
                base_url: provider.base_url.clone(),
                auto: true,
            });
        }
        // No catalog yet: use the active provider's current model so roles still
        // resolve before "Aggiorna modelli" has run.
        let provider = self.active()?;
        let model = provider.effective_model()?;
        Some(ResolvedRole {
            role: role.to_string(),
            provider_id: provider.id.clone(),
            model,
            kind: provider.kind,
            base_url: provider.base_url.clone(),
            auto: true,
        })
    }

    /// Overrides a model's profile (user-curated). Returns false if the
    /// provider/model isn't in the registry.
    pub fn set_model_profile(
        &mut self,
        provider_id: &str,
        model_id: &str,
        profile: ModelProfile,
    ) -> bool {
        self.update_model(provider_id, model_id, |model| model.profile = Some(profile))
    }

    /// Mutates a model in place (profile + capability flags). Returns false if the
    /// provider/model isn't in the registry.
    pub fn update_model<F: FnOnce(&mut ModelEntry)>(
        &mut self,
        provider_id: &str,
        model_id: &str,
        edit: F,
    ) -> bool {
        if let Some(provider) = self.get_mut(provider_id)
            && let Some(model) = provider.models.iter_mut().find(|m| m.id == model_id)
        {
            edit(model);
            return true;
        }
        false
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
    fn tier_does_not_mistake_large_param_sizes_for_fast() {
        // The old substring check made "671b" match "1b" → wrongly "fast".
        let big = ModelEntry::inferred("deepseek-v3.1:671b-cloud");
        assert_eq!(big.profile.as_ref().unwrap().tier, ModelTier::Balanced);
        let big2 = ModelEntry::inferred("qwen3-coder:480b-cloud");
        assert_eq!(big2.profile.as_ref().unwrap().tier, ModelTier::Balanced);
        // Genuinely small models stay fast.
        let small = ModelEntry::inferred("llama3.1:8b");
        assert_eq!(small.profile.as_ref().unwrap().tier, ModelTier::Fast);
        let small2 = ModelEntry::inferred("qwen2.5:3b");
        assert_eq!(small2.profile.as_ref().unwrap().tier, ModelTier::Fast);
        // Name-based fast marker still works.
        let mini = ModelEntry::inferred("gpt-4o-mini");
        assert_eq!(mini.profile.as_ref().unwrap().tier, ModelTier::Fast);
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

    fn registry_with_two_models() -> ProviderRegistry {
        let mut reg = ProviderRegistry::default();
        let mut ollama = ProviderEntry::new(
            "ollama".into(),
            "Ollama".into(),
            ProviderKind::Ollama,
            "http://127.0.0.1:11434/v1".into(),
        );
        ollama.models = vec![
            ModelEntry::inferred("llama3.1:8b"),       // tools, ctx None
            ModelEntry::inferred("minimax-m2.7:cloud"), // tools, ctx 200k
            ModelEntry::inferred("nomic-embed-text"),   // embedding
        ];
        reg.upsert(ollama);
        reg
    }

    #[test]
    fn auto_role_picks_largest_context_text_tool_model() {
        let reg = registry_with_two_models();
        let resolved = reg.resolve_role("orchestrator").unwrap();
        assert!(resolved.auto);
        assert_eq!(resolved.model, "minimax-m2.7:cloud");
        assert_eq!(resolved.provider_id, "ollama");
    }

    #[test]
    fn orchestrator_prefers_reasoning_tier_over_balanced() {
        let mut reg = ProviderRegistry::default();
        let mut p = ProviderEntry::new(
            "ollama".into(),
            "Ollama".into(),
            ProviderKind::Ollama,
            "http://127.0.0.1:11434/v1".into(),
        );
        // Both text+tools+200k; differ only by tier.
        let opus = ModelEntry::inferred("claude-opus-4"); // reasoning
        let sonnet = ModelEntry::inferred("claude-sonnet-4"); // balanced
        assert_eq!(opus.profile.as_ref().unwrap().tier, ModelTier::Reasoning);
        assert_eq!(sonnet.profile.as_ref().unwrap().tier, ModelTier::Balanced);
        p.models = vec![sonnet, opus];
        reg.upsert(p);

        // orchestrator prefers Reasoning → opus; browser prefers Balanced → sonnet.
        assert_eq!(reg.resolve_role("orchestrator").unwrap().model, "claude-opus-4");
        assert_eq!(reg.resolve_role("browser").unwrap().model, "claude-sonnet-4");
    }

    #[test]
    fn eligible_models_apply_the_capability_gate() {
        let reg = registry_with_two_models(); // llama3.1:8b, minimax (text+tools), nomic-embed
        // orchestrator (text+tools) → the two chat models, not the embedder.
        let orch: Vec<_> = reg
            .eligible_models("orchestrator")
            .iter()
            .map(|(_, m)| m.id.clone())
            .collect();
        assert!(orch.contains(&"minimax-m2.7:cloud".to_string()));
        assert!(orch.contains(&"llama3.1:8b".to_string()));
        assert!(!orch.contains(&"nomic-embed-text".to_string()));
        // embeddings role → only the embedder.
        let emb: Vec<_> = reg
            .eligible_models("embeddings")
            .iter()
            .map(|(_, m)| m.id.clone())
            .collect();
        assert_eq!(emb, vec!["nomic-embed-text".to_string()]);
    }

    #[test]
    fn manual_binding_overrides_auto() {
        let mut reg = registry_with_two_models();
        reg.roles.insert(
            "browser".into(),
            RoleBinding {
                provider_id: Some("ollama".into()),
                model: Some("llama3.1:8b".into()),
            },
        );
        let resolved = reg.resolve_role("browser").unwrap();
        assert!(!resolved.auto);
        assert_eq!(resolved.model, "llama3.1:8b");
    }

    #[test]
    fn auto_role_falls_back_to_active_model_without_catalog() {
        let mut reg = ProviderRegistry::default();
        let mut p = ProviderEntry::new(
            "ollama".into(),
            "Ollama".into(),
            ProviderKind::Ollama,
            "http://127.0.0.1:11434/v1".into(),
        );
        p.active_model = Some("minimax-m2.7:cloud".into());
        reg.upsert(p);
        let resolved = reg.resolve_role("orchestrator").unwrap();
        assert!(resolved.auto);
        assert_eq!(resolved.model, "minimax-m2.7:cloud");
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
