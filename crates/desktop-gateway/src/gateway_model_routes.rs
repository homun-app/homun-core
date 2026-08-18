//! HTTP routes for runtime model/provider configuration.
//!
//! Owns the API/DTO surface used by Settings and the composer while delegating
//! routing, provider registry persistence, and model capability policy to the
//! central model-routing owner.

use super::*;

#[derive(Debug, Serialize)]
pub(crate) struct ActiveModelResponse {
    /// "anthropic" | "openai-compat"
    backend: String,
    model: String,
    /// "cloud" | "local"
    locality: String,
    context_window: u32,
    /// Always true: the only backends are capable cloud/router providers (the
    /// small local MLX/Gemma fallback that this flag used to gate is gone).
    capable: bool,
    /// True when the selected backend needs a cloud API key but none is present
    /// — the UI can warn that chat will silently fall back to local.
    missing_api_key: bool,
}

/// Default cloud/compat model ids — the SINGLE source of truth shared by the
/// router builder ([`build_browser_inference_router`]) and the reporter
/// ([`active_inference_model_info`]) so the two can never drift (the bug class
/// behind both the de-gemma labels and the earlier mistralrs default mismatch).
const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-4-6";
const OPENAI_COMPAT_DEFAULT_MODEL: &str = "gpt-4o-mini";

/// Pure, env-free inputs for [`resolve_active_model`] — lets the selection
/// logic be unit-tested without mutating process env (which is parallel-unsafe).
struct ActiveModelInputs {
    backend: String,
    model: Option<String>,
    cloud_flag: bool,
    context_window: Option<u32>,
    has_api_key: bool,
}

/// Pure selection logic mirroring [`build_browser_inference_router`]: anthropic
/// only when explicitly selected AND a key is present; otherwise the configured
/// OpenAI-compatible provider (the local MLX/Gemma fallback is gone). Kept
/// separate from env reading so it is deterministically testable.
fn resolve_active_model(input: &ActiveModelInputs) -> ActiveModelResponse {
    if input.backend == "anthropic" && input.has_api_key {
        return ActiveModelResponse {
            backend: "anthropic".to_string(),
            model: input
                .model
                .clone()
                .unwrap_or_else(|| ANTHROPIC_DEFAULT_MODEL.to_string()),
            locality: "cloud".to_string(),
            context_window: input.context_window.unwrap_or(200_000),
            capable: true,
            missing_api_key: false,
        };
    }

    // Default for every other case (incl. anthropic-without-key, which the
    // router resolves to the OpenAI-compatible provider too).
    ActiveModelResponse {
        backend: "openai-compat".to_string(),
        model: input
            .model
            .clone()
            .unwrap_or_else(|| OPENAI_COMPAT_DEFAULT_MODEL.to_string()),
        locality: if input.cloud_flag { "cloud" } else { "local" }.to_string(),
        context_window: input.context_window.unwrap_or(32_768),
        capable: true,
        // An OpenAI-compatible endpoint may be keyless (local Ollama); only flag
        // a missing key when it is a cloud endpoint.
        missing_api_key: input.cloud_flag && !input.has_api_key,
    }
}

/// Reports which inference backend/model is actually active, mirroring the exact
/// selection logic in [`build_browser_inference_router`]. Read-only — the
/// recurring pain that started the de-gemma arc was "am I on cloud or gemma4?";
/// this makes the answer visible in the UI instead of buried in env vars.
pub(crate) fn active_inference_model_info() -> ActiveModelResponse {
    // Prefer the provider registry — the source generations actually use — so the
    // reported model/context match what runs. The legacy env/persisted fields
    // below are only a fallback when no provider is configured yet.
    {
        let registry = load_provider_registry();
        if let Some(provider) = registry.active()
            && let Some(model) = provider.effective_model()
        {
            let context_window = provider
                .models
                .iter()
                .find(|m| m.id == model)
                .and_then(|m| m.context_window)
                .unwrap_or(32_768);
            let base = provider.base_url.to_ascii_lowercase();
            let local = base.contains("127.0.0.1")
                || base.contains("localhost")
                || base.contains("0.0.0.0");
            let backend = if provider.kind.as_str() == "anthropic" {
                "anthropic"
            } else {
                "openai-compat"
            };
            return ActiveModelResponse {
                backend: backend.to_string(),
                model,
                locality: if local { "local" } else { "cloud" }.to_string(),
                context_window,
                capable: true,
                missing_api_key: !local && provider_api_key(&provider.id).is_none(),
            };
        }
    }
    resolve_active_model(&ActiveModelInputs {
        backend: env::var("HOMUN_INFERENCE_BACKEND")
            .unwrap_or_default()
            .to_ascii_lowercase(),
        model: persisted_inference_model()
            .or_else(|| env::var("HOMUN_INFERENCE_MODEL").ok())
            .filter(|value| !value.is_empty()),
        cloud_flag: env::var("HOMUN_INFERENCE_CLOUD")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
        context_window: env::var("HOMUN_INFERENCE_CONTEXT_WINDOW")
            .ok()
            .and_then(|value| value.parse::<u32>().ok()),
        has_api_key: resolve_inference_api_key().is_some(),
    })
}

#[derive(Debug, Serialize)]
pub(crate) struct ProviderModelsGroup {
    provider_id: String,
    label: String,
    /// Provider endpoint, so the picker can label each model 💻 local vs ☁️ cloud
    /// (a remote base_url OR a `:cloud`/`-cloud` model tag = cloud compute).
    base_url: String,
    models: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeModelsResponse {
    active: Option<String>,
    backend: String,
    available: Vec<String>,
    /// Models grouped by their provider, for the composer picker (search + sections).
    /// Empty on the env-based fallback (the picker then uses the flat `available`).
    groups: Vec<ProviderModelsGroup>,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct RuntimeModelsQuery {
    #[serde(default)]
    thread_id: Option<String>,
}

/// Lists the models the configured backend exposes (OpenAI-compatible `/models`,
/// which Ollama also serves) so Settings can offer a real picker.
pub(crate) async fn runtime_models(
    State(state): State<AppState>,
    Query(query): Query<RuntimeModelsQuery>,
) -> Json<RuntimeModelsResponse> {
    // Prefer the provider registry (what the user configured): the active provider
    // already carries its model catalog, so the in-app picker gets the REAL list
    // with no network round-trip — this is why the composer model menu was empty.
    {
        let registry = load_provider_registry();
        if let Some(provider) = registry.active() {
            // "Auto" must show what this THREAD would actually use: project chats
            // can resolve to coding, personal chats to orchestrator. Previously the
            // composer always displayed orchestrator even while the gateway sent a
            // project turn to coding, making provider failures impossible to reason
            // about from the UI.
            let active = chat_role_config_for_thread(&state, query.thread_id.as_deref())
                .map(|(_, model, _)| model)
                .or_else(|| provider.effective_model());
            // List models from ALL providers so the per-message override can pick
            // any configured model (e.g. a Z.ai model while Ollama is active).
            let mut available: Vec<String> = registry
                .providers
                .iter()
                .flat_map(|p| p.models.iter().map(|m| m.id.clone()))
                .collect();
            if let Some(active) = active.as_ref()
                && !available.iter().any(|m| m == active)
            {
                available.push(active.clone());
            }
            available.sort();
            available.dedup();
            // Grouped by provider for the composer picker (one section per provider).
            let groups: Vec<ProviderModelsGroup> = registry
                .providers
                .iter()
                .filter(|p| !p.models.is_empty())
                .map(|p| ProviderModelsGroup {
                    provider_id: p.id.clone(),
                    label: p.label.clone(),
                    base_url: p.base_url.clone(),
                    models: p.models.iter().map(|m| m.id.clone()).collect(),
                })
                .collect();
            if active.is_some() || !available.is_empty() {
                return Json(RuntimeModelsResponse {
                    active,
                    backend: provider.kind.as_str().to_string(),
                    available,
                    groups,
                });
            }
        }
    }
    let backend = env::var("HOMUN_INFERENCE_BACKEND")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let active = persisted_inference_model().or_else(|| env::var("HOMUN_INFERENCE_MODEL").ok());
    let mut available = Vec::new();
    if let Ok(base) = env::var("HOMUN_INFERENCE_BASE_URL")
        && !base.is_empty()
    {
        let url = format!("{}/models", base.trim_end_matches('/'));
        let mut request = state
            .http
            .get(&url)
            .timeout(std::time::Duration::from_secs(4));
        if let Some(key) = resolve_inference_api_key() {
            request = request.bearer_auth(key);
        }
        if let Ok(response) = request.send().await
            && let Ok(body) = response.json::<serde_json::Value>().await
            && let Some(data) = body.get("data").and_then(Value::as_array)
        {
            for entry in data {
                if let Some(id) = entry.get("id").and_then(Value::as_str) {
                    available.push(id.to_string());
                }
            }
        }
    }
    available.sort();
    available.dedup();
    Json(RuntimeModelsResponse {
        active,
        backend,
        available,
        groups: Vec::new(),
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetRuntimeModelRequest {
    model: String,
}

pub(crate) fn deliver_model_available_wakes(
    state: &AppState,
    role: &str,
    source: &str,
) -> Result<usize, GatewayError> {
    let condition = local_first_execution_protocol::WakeCondition::ModelAvailable {
        role: role.to_string(),
    };
    lock_task_store(state)?
        .deliver_execution_wake(
            &condition,
            &serde_json::json!({
                "type": "model_available",
                "role": role,
                "source": source,
            }),
        )
        .map_err(GatewayError::task)
}

/// Persists the user-selected active model. Applies to the next chat (no
/// restart): chat_openai_stream_config reads the override fresh each call.
pub(crate) async fn set_runtime_model(
    State(state): State<AppState>,
    Json(request): Json<SetRuntimeModelRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let model = request.model.trim();
    if model.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "model_required",
            message: "model must not be empty".to_string(),
        });
    }
    // Set the active provider's model in the registry when one exists; always
    // keep the legacy file in sync so env-only setups still resolve.
    let mut registry = load_provider_registry();
    if let Some(active_id) = registry.active().map(|p| p.id.clone())
        && let Some(provider) = registry.get_mut(&active_id)
    {
        provider.active_model = Some(model.to_string());
        save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    }
    set_persisted_inference_model(model).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "model_persist_failed",
        message: error.to_string(),
    })?;
    deliver_model_available_wakes(&state, "primary", "runtime_model_changed")?;
    Ok(Json(serde_json::json!({ "active": model })))
}

#[derive(Debug, Serialize)]
pub(crate) struct InferenceProviderResponse {
    base_url: Option<String>,
    model: Option<String>,
    has_key: bool,
}

/// The configured inference provider (base URL + model + whether a key is set).
/// Never returns the key itself.
pub(crate) async fn runtime_provider() -> Json<InferenceProviderResponse> {
    Json(InferenceProviderResponse {
        base_url: effective_inference_base_url(),
        model: persisted_inference_model().or_else(|| env::var("HOMUN_INFERENCE_MODEL").ok()),
        has_key: resolve_inference_api_key().is_some(),
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetInferenceProviderRequest {
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
}

/// Configure an external OpenAI-compatible provider: base URL + model persisted
/// in the data dir, API key stored in the encrypted secret store (never echoed).
pub(crate) async fn set_runtime_provider(
    State(state): State<AppState>,
    Json(request): Json<SetInferenceProviderRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let persist_err = |message: String| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "provider_persist_failed",
        message,
    };
    if let Some(base) = request
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_persisted_inference_base_url(base).map_err(|error| persist_err(error.to_string()))?;
    }
    if let Some(model) = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_persisted_inference_model(model).map_err(|error| persist_err(error.to_string()))?;
    }
    if let Some(key) = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_persisted_inference_api_key(key).map_err(persist_err)?;
    }
    deliver_model_available_wakes(&state, "primary", "runtime_provider_changed")?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── Provider registry endpoints (Phase 1) ─────────────────────────────────

#[derive(Debug, Serialize)]
pub(crate) struct ProviderModelView {
    id: String,
    vision: bool,
    tools: bool,
    reasoning: bool,
    modality: String,
    context_window: Option<u32>,
    /// Qualitative profile used for ranking ("in cosa eccelle").
    tier: Option<String>,
    strengths: Option<String>,
    profile_source: Option<String>,
    profile_confidence: Option<u8>,
    input_microusd_per_million: Option<u64>,
    output_microusd_per_million: Option<u64>,
    price_source: Option<String>,
    price_version: Option<String>,
    price_effective_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ProviderView {
    id: String,
    label: String,
    kind: String,
    base_url: String,
    enabled: bool,
    has_key: bool,
    active_model: Option<String>,
    models: Vec<ProviderModelView>,
    models_fetched_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ProvidersResponse {
    active_provider_id: Option<String>,
    providers: Vec<ProviderView>,
}

pub(crate) fn provider_view(entry: &ProviderEntry) -> ProviderView {
    ProviderView {
        id: entry.id.clone(),
        label: entry.label.clone(),
        kind: entry.kind.as_str().to_string(),
        base_url: entry.base_url.clone(),
        enabled: entry.enabled,
        has_key: provider_api_key(&entry.id).is_some(),
        active_model: entry.effective_model(),
        models: entry
            .models
            .iter()
            .map(|m| ProviderModelView {
                id: m.id.clone(),
                vision: m.vision,
                tools: m.tools,
                reasoning: m.reasoning,
                modality: m.modality.clone(),
                context_window: m.context_window,
                tier: m.profile.as_ref().map(|p| p.tier.as_str().to_string()),
                strengths: m.profile.as_ref().map(|p| p.strengths.clone()),
                profile_source: m.profile.as_ref().map(|p| p.source.clone()),
                profile_confidence: m.profile.as_ref().map(|p| p.confidence),
                input_microusd_per_million: m
                    .price
                    .as_ref()
                    .and_then(|price| price.input_microusd_per_million),
                output_microusd_per_million: m
                    .price
                    .as_ref()
                    .and_then(|price| price.output_microusd_per_million),
                price_source: m.price.as_ref().map(|price| price.source.clone()),
                price_version: m.price.as_ref().map(|price| price.version.clone()),
                price_effective_at: m.price.as_ref().map(|price| price.effective_at),
            })
            .collect(),
        models_fetched_at: entry.models_fetched_at.clone(),
    }
}

pub(crate) fn providers_response(registry: &ProviderRegistry) -> ProvidersResponse {
    ProvidersResponse {
        active_provider_id: registry.active().map(|p| p.id.clone()),
        providers: registry.providers.iter().map(provider_view).collect(),
    }
}

pub(crate) async fn list_providers() -> Json<ProvidersResponse> {
    Json(providers_response(&load_provider_registry()))
}

#[derive(Debug, Deserialize)]
pub(crate) struct UpsertProviderRequest {
    id: Option<String>,
    label: Option<String>,
    kind: Option<String>,
    base_url: String,
    api_key: Option<String>,
    active_model: Option<String>,
}

/// Adds or updates a provider. The API key (if supplied) goes to the encrypted
/// secret store under the provider id and is never echoed back.
pub(crate) async fn upsert_provider(
    State(state): State<AppState>,
    Json(request): Json<UpsertProviderRequest>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let bad = |message: &str| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "provider_invalid",
        message: message.to_string(),
    };
    let base_url = canonical_provider_base_url(&request.base_url);
    if base_url.is_empty() {
        return Err(bad("base_url must not be empty"));
    }
    let kind = request
        .kind
        .as_deref()
        .and_then(ProviderKind::parse)
        .unwrap_or(ProviderKind::OpenaiCompat);
    let label = request
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| base_url.clone());
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(model_registry::slugify)
        .unwrap_or_else(|| model_registry::slugify(&label));

    let mut registry = load_provider_registry();
    let mut entry = ProviderEntry::new(id.clone(), label, kind, base_url);
    entry.active_model = request
        .active_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    registry.upsert(entry);

    if let Some(key) = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_provider_api_key(&id, key).map_err(|message| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "provider_key_persist_failed",
            message,
        })?;
    }

    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    deliver_model_available_wakes(&state, "primary", "provider_upserted")?;
    Ok(Json(providers_response(&registry)))
}

pub(crate) async fn remove_provider(
    Path(id): Path<String>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let mut registry = load_provider_registry();
    if !registry.remove(&id) {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "provider_not_found",
            message: format!("provider {id} not configured"),
        });
    }
    delete_provider_api_key(&id);
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(providers_response(&registry)))
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetProviderEnabledRequest {
    enabled: bool,
}

/// Enables/disables a provider for routing (no single "default" — each provider
/// is independently on/off; the role resolver only considers enabled ones).
pub(crate) async fn set_provider_enabled(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<SetProviderEnabledRequest>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let mut registry = load_provider_registry();
    if !registry.set_enabled(&id, req.enabled) {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "provider_not_found",
            message: format!("provider {id} not configured"),
        });
    }
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    if req.enabled {
        deliver_model_available_wakes(&state, "primary", "provider_enabled")?;
    }
    Ok(Json(providers_response(&registry)))
}

/// Fetches the provider's live model catalog, infers capability flags, caches it
/// in the registry, and returns the refreshed view.
pub(crate) async fn refresh_provider_models(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let mut registry = load_provider_registry();
    let entry = registry.get(&id).cloned().ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "provider_not_found",
        message: format!("provider {id} not configured"),
    })?;

    let url = entry.models_endpoint();
    let mut request = state
        .http
        .get(&url)
        .timeout(std::time::Duration::from_secs(6));
    let key = provider_api_key(&id);
    if let Some(key) = key.as_deref() {
        match entry.kind {
            ProviderKind::Anthropic => {
                request = request
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01");
            }
            _ if entry.kind.lists_with_bearer() => {
                request = request.bearer_auth(key);
            }
            _ => {}
        }
    }
    let response = request.send().await.map_err(|error| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "provider_models_unreachable",
        message: format!("models unreachable: {error}"),
    })?;
    if !response.status().is_success() {
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "provider_models_http_error",
            message: format!("HTTP {} from the provider", response.status().as_u16()),
        });
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "provider_models_decode_failed",
            message: error.to_string(),
        })?;
    let mut catalog_models =
        model_registry::parse_model_entries(entry.kind, &body, Some(&entry.id));
    let fetched_at = i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX);
    for model in &mut catalog_models {
        if let Some(price) = model.price.as_mut() {
            price.effective_at = fetched_at;
        }
    }
    let ids = catalog_models
        .iter()
        .map(|model| model.id.clone())
        .collect::<Vec<_>>();
    let catalog_by_id = catalog_models
        .into_iter()
        .map(|model| (model.id.clone(), model))
        .collect::<std::collections::HashMap<_, _>>();

    // Ask each model what it can DO. Ollama answers on `/api/show`, so the name heuristic has no
    // business deciding here — it is the fallback for providers that stay SILENT, and using it where
    // the provider speaks is what flagged a retired `-vl` model as the app's only eye while calling
    // eight genuinely multimodal models (gemma4, minimax-m3, kimi, qwen3.5, ministral-3) blind, purely
    // because their names lack the magic substrings. Best-effort per model: `Unknown` keeps the
    // heuristic (fail-safe), `Retired` strips it (see `ModelReport`).
    let mut reported: std::collections::HashMap<String, ModelReport> =
        std::collections::HashMap::new();
    if matches!(entry.kind, ProviderKind::Ollama) {
        let show_endpoint = format!("{}/api/show", ollama_native_root(&entry.base_url));
        for model_id in &ids {
            let Ok(response) = state
                .http
                .post(&show_endpoint)
                .json(&serde_json::json!({ "name": model_id }))
                .timeout(std::time::Duration::from_secs(8))
                .send()
                .await
            else {
                continue;
            };
            let status = response.status().as_u16();
            let show_body = response
                .json::<serde_json::Value>()
                .await
                .unwrap_or(serde_json::Value::Null);
            match classify_model_report(status, &show_body) {
                ModelReport::Unknown => {}
                report => {
                    if report == ModelReport::Retired {
                        eprintln!(
                            "[gateway] catalog: «{model_id}» is retired upstream — dropping its capabilities so no role picks it"
                        );
                    }
                    reported.insert(model_id.clone(), report);
                }
            }
        }
    }
    // The per-process capability memo is now stale for these models (it may hold the very flags we
    // just corrected). Drop it; `warm_ollama_capabilities` refills it from the fixed catalog.
    if let Ok(mut cache) = ollama_capabilities_cache().lock() {
        cache.clear();
    }

    if let Some(stored) = registry.get_mut(&id) {
        // Preserve the user's manual profile edits across a catalog refresh;
        // re-infer everything else (so heuristic fixes apply).
        let user_profiles: std::collections::HashMap<String, model_registry::ModelProfile> = stored
            .models
            .iter()
            .filter_map(|m| {
                m.profile
                    .as_ref()
                    .filter(|p| p.source == "user")
                    .map(|p| (m.id.clone(), p.clone()))
            })
            .collect();
        let old_prices = stored
            .models
            .iter()
            .filter_map(|model| model.price.clone().map(|price| (model.id.clone(), price)))
            .collect::<std::collections::HashMap<_, _>>();
        stored.models =
            refreshed_catalog_models(&ids, &catalog_by_id, &reported, &user_profiles, &old_prices);
        stored.models_fetched_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs().to_string());
    }
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    deliver_model_available_wakes(&state, "primary", "provider_catalog_refreshed")?;
    if let (Ok(store), Ok(mut pricing)) = (state.usage_store.lock(), state.usage_pricing.write()) {
        *pricing = build_usage_pricing_snapshot(&store);
    }
    Ok(Json(providers_response(&registry)))
}

pub(crate) fn provider_registry_persist_error(message: String) -> GatewayError {
    GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "provider_registry_persist_failed",
        message,
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetModelProfileRequest {
    provider_id: String,
    model: String,
    tier: String,
    strengths: Option<String>,
    /// Optional capability overrides (the gate fields). Absent = leave as-is.
    vision: Option<bool>,
    tools: Option<bool>,
    reasoning: Option<bool>,
    context_window: Option<u32>,
}

/// User-curates a model's profile (tier + strengths) and, optionally, its
/// capability flags (vision/tools/context window). Source becomes "user" /
/// confidence 100, so it wins over curated/inferred and drives ranking + gating.
pub(crate) async fn set_model_profile(
    Json(request): Json<SetModelProfileRequest>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let tier = model_registry::ModelTier::parse(&request.tier).ok_or_else(|| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "tier_invalid",
        message: "tier must be fast|balanced|reasoning".to_string(),
    })?;
    let mut registry = load_provider_registry();
    // Keep the existing strengths text when the caller doesn't supply one.
    let strengths = request
        .strengths
        .or_else(|| {
            registry
                .get(&request.provider_id)
                .and_then(|p| p.models.iter().find(|m| m.id == request.model))
                .and_then(|m| m.profile.as_ref().map(|pr| pr.strengths.clone()))
        })
        .unwrap_or_default();
    let profile = model_registry::ModelProfile {
        tier,
        strengths,
        source: "user".to_string(),
        confidence: 100,
    };
    let updated = registry.update_model(&request.provider_id, &request.model, |model| {
        model.profile = Some(profile);
        if let Some(vision) = request.vision {
            model.vision = vision;
        }
        if let Some(tools) = request.tools {
            model.tools = tools;
        }
        if let Some(reasoning) = request.reasoning {
            model.reasoning = reasoning;
        }
        if let Some(context_window) = request.context_window {
            model.context_window = Some(context_window);
        }
    });
    if !updated {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "model_not_found",
            message: format!(
                "model {} not found in {}",
                request.model, request.provider_id
            ),
        });
    }
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(providers_response(&registry)))
}

/// Generates `strengths` + `tier` drafts for the provider's models that only have
/// an inferred placeholder profile (the "generated where not curated" half of the
/// hybrid). Asks a capable model to describe each model id; results are marked
/// source="generated" (medium confidence) and remain user-editable. Curated and
/// user profiles are left untouched.
pub(crate) async fn generate_provider_profiles(
    Path(id): Path<String>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let registry = load_provider_registry();
    let provider = registry.get(&id).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "provider_not_found",
        message: format!("provider {id} not configured"),
    })?;
    // Only fill the inferred placeholders (no profile, or source == "inferred").
    let to_describe: Vec<String> = provider
        .models
        .iter()
        .filter(|m| {
            m.profile
                .as_ref()
                .map(|p| p.source == "inferred")
                .unwrap_or(true)
        })
        .map(|m| m.id.clone())
        .collect();
    if to_describe.is_empty() {
        return Ok(Json(providers_response(&registry)));
    }

    let list = to_describe
        .iter()
        .map(|mid| format!("- {mid}"))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "For each listed model id, indicate what it excels at and the tier.\n\
         tier ∈ {{fast, balanced, reasoning}} (fast=fast/cheap, balanced=strong \
         general use, reasoning=deep reasoning). strengths = ONE concise sentence. \
         If you do not know the model, use tier \"balanced\" and strengths \"\".\n\n\
         Models:\n{list}\n\n\
         Reply ONLY with JSON: {{\"profiles\": [{{\"id\":\"<exact id>\",\"tier\":\"...\",\"strengths\":\"...\"}}]}}."
    );
    let request = GenerateJsonRequest {
        usage: {
            let mut usage = local_first_inference_usage::UsageContext::new(
                uuid::Uuid::new_v4().to_string(),
                local_first_inference_usage::InferencePurpose::Evaluation,
                gateway_user_id().as_str(),
            );
            usage.purpose_detail = Some("model_profile_generation".to_string());
            usage
        },
        prompt,
        max_tokens: 1_200,
        temperature: 0.0,
        wait_if_busy: true,
        request_timeout_seconds: Some(60.0),
        json_schema: None,
        required_keys: vec!["profiles".to_string()],
        repair: true,
    };
    // The provider's HTTP call is blocking; run it off the async runtime.
    let response = tokio::task::spawn_blocking(move || {
        router_for_role("orchestrator").generate_json_with(&Requirements::default(), &request)
    })
    .await
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "profile_generation_join_failed",
        message: error.to_string(),
    })?
    .map_err(|error| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "profile_generation_failed",
        message: format!("profile generation failed: {error:?}"),
    })?;
    if !response.valid {
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "profile_generation_invalid",
            message: response.errors.join("; "),
        });
    }

    // Re-load and apply (the LLM call is async; keep the write atomic-ish).
    let mut registry = load_provider_registry();
    let valid_ids: std::collections::HashSet<&str> =
        to_describe.iter().map(String::as_str).collect();
    if let Some(profiles) = response.json.get("profiles").and_then(Value::as_array) {
        for entry in profiles {
            let model_id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
            if model_id.is_empty() || !valid_ids.contains(model_id) {
                continue;
            }
            let tier = entry
                .get("tier")
                .and_then(Value::as_str)
                .and_then(model_registry::ModelTier::parse)
                .unwrap_or(model_registry::ModelTier::Balanced);
            let strengths = entry
                .get("strengths")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            registry.set_model_profile(
                &id,
                model_id,
                model_registry::ModelProfile {
                    tier,
                    strengths,
                    source: "generated".to_string(),
                    confidence: 50,
                },
            );
        }
    }
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(providers_response(&registry)))
}

// ── Role → model endpoints (Phase 2) ──────────────────────────────────────

#[derive(Debug, Serialize)]
pub(crate) struct RoleView {
    key: &'static str,
    label: &'static str,
    description: &'static str,
    /// True when the role resolves via capability auto-match (no manual pin).
    auto: bool,
    /// The user's explicit pin, if any.
    binding_provider_id: Option<String>,
    binding_model: Option<String>,
    /// What the role actually resolves to right now.
    resolved_provider_id: Option<String>,
    resolved_model: Option<String>,
    resolved_kind: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RolesResponse {
    roles: Vec<RoleView>,
}

pub(crate) fn roles_response(registry: &ProviderRegistry) -> RolesResponse {
    let roles = model_registry::ROLES
        .iter()
        .map(|info| {
            let binding = registry.roles.get(info.key);
            let resolved = if info.key == "privacy_guard" {
                resolve_privacy_guard_role(registry)
            } else {
                registry.resolve_role(info.key)
            };
            RoleView {
                key: info.key,
                label: info.label,
                description: info.description,
                auto: resolved.as_ref().map(|r| r.auto).unwrap_or(true),
                binding_provider_id: binding.and_then(|b| b.provider_id.clone()),
                binding_model: binding.and_then(|b| b.model.clone()),
                resolved_provider_id: resolved.as_ref().map(|r| r.provider_id.clone()),
                resolved_model: resolved.as_ref().map(|r| r.model.clone()),
                resolved_kind: resolved.as_ref().map(|r| r.kind.as_str().to_string()),
            }
        })
        .collect();
    RolesResponse { roles }
}

pub(crate) async fn list_roles() -> Json<RolesResponse> {
    Json(roles_response(&load_provider_registry()))
}

#[derive(Debug, Serialize)]
pub(crate) struct RoutingDecisionsResponse {
    decisions: Vec<RoutingDecision>,
}

/// The recent model-routing decisions (most recent first) — observability for the
/// semantic router: which model was chosen for a task, among which candidates, why.
pub(crate) async fn list_routing_decisions() -> Json<RoutingDecisionsResponse> {
    let mut decisions = load_routing_decisions();
    decisions.reverse();
    Json(RoutingDecisionsResponse { decisions })
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetRoleRequest {
    role: String,
    /// Both present → manual pin; either missing/empty → auto.
    provider_id: Option<String>,
    model: Option<String>,
}

pub(crate) async fn set_role(
    Json(request): Json<SetRoleRequest>,
) -> Result<Json<RolesResponse>, GatewayError> {
    if !model_registry::ROLES.iter().any(|r| r.key == request.role) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "role_unknown",
            message: format!("ruolo sconosciuto: {}", request.role),
        });
    }
    let provider_id = request
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut registry = load_provider_registry();
    match (provider_id, model) {
        (Some(pid), Some(model)) => {
            if registry.get(pid).is_none() {
                return Err(GatewayError {
                    status: StatusCode::NOT_FOUND,
                    code: "provider_not_found",
                    message: format!("provider {pid} not configured"),
                });
            }
            registry.roles.insert(
                request.role.clone(),
                RoleBinding {
                    provider_id: Some(pid.to_string()),
                    model: Some(model.to_string()),
                },
            );
        }
        // Anything else clears the pin → auto.
        _ => {
            registry.roles.remove(&request.role);
        }
    }
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(roles_response(&registry)))
}

pub(crate) async fn runtime_model() -> Json<ActiveModelResponse> {
    Json(active_inference_model_info())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_inputs(backend: &str) -> ActiveModelInputs {
        ActiveModelInputs {
            backend: backend.to_string(),
            model: None,
            cloud_flag: false,
            context_window: None,
            has_api_key: false,
        }
    }

    #[test]
    fn gateway_model_routes_anthropic_with_key_is_capable_cloud() {
        let info = resolve_active_model(&ActiveModelInputs {
            has_api_key: true,
            ..model_inputs("anthropic")
        });
        assert_eq!(info.backend, "anthropic");
        assert_eq!(info.locality, "cloud");
        assert!(info.capable);
        assert!(!info.missing_api_key);
        assert_eq!(info.model, ANTHROPIC_DEFAULT_MODEL);
        assert_eq!(info.context_window, 200_000);
    }

    #[test]
    fn gateway_model_routes_anthropic_without_key_uses_openai_compat() {
        let info = resolve_active_model(&model_inputs("anthropic"));
        assert_eq!(info.backend, "openai-compat");
        assert!(info.capable);
    }

    #[test]
    fn gateway_model_routes_cloud_openai_without_key_flags_missing_key() {
        let info = resolve_active_model(&ActiveModelInputs {
            cloud_flag: true,
            model: Some("minimax-m2.7".to_string()),
            ..model_inputs("openai")
        });
        assert_eq!(info.backend, "openai-compat");
        assert_eq!(info.locality, "cloud");
        assert_eq!(info.model, "minimax-m2.7");
        assert!(info.capable);
        assert!(info.missing_api_key);
    }

    #[test]
    fn gateway_model_routes_keyless_local_openai_is_not_missing_key() {
        let info = resolve_active_model(&ActiveModelInputs {
            cloud_flag: false,
            ..model_inputs("openai")
        });
        assert_eq!(info.backend, "openai-compat");
        assert_eq!(info.locality, "local");
        assert!(!info.missing_api_key);
    }

    #[test]
    fn gateway_model_routes_unknown_backends_use_openai_compat() {
        for backend in ["", "mistralrs", "mlx", "something-else"] {
            let info = resolve_active_model(&model_inputs(backend));
            assert_eq!(info.backend, "openai-compat", "backend: {backend}");
            assert!(info.capable, "backend: {backend}");
            assert_eq!(info.locality, "local", "backend: {backend}");
            assert_eq!(
                info.model, OPENAI_COMPAT_DEFAULT_MODEL,
                "backend: {backend}"
            );
        }
    }
}
