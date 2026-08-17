//! Usage analytics and provider budget route owner.
//!
//! Owns the HTTP surface for the local inference usage ledger, provider account
//! snapshots, manual provider budget policy and model-usage suggestions.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use crate::{
    AppState, GatewayError, build_usage_pricing_snapshot, gateway_user_id, gateway_workspace_id,
    inference_locality, load_provider_registry, model_registry, now_epoch_secs, provider_api_key,
    provider_usage, usage_store, usage_suggestions,
};

#[derive(Debug, Deserialize)]
pub(crate) struct UsageWindowQuery {
    #[serde(default = "default_usage_window")]
    window: String,
    #[serde(default)]
    timezone_offset_minutes: i32,
}

fn default_usage_window() -> String {
    "30d".to_string()
}

fn parse_usage_window(value: &str) -> Result<usage_store::UsageWindow, GatewayError> {
    match value {
        "7d" => Ok(usage_store::UsageWindow::SevenDays),
        "30d" => Ok(usage_store::UsageWindow::ThirtyDays),
        "all" => Ok(usage_store::UsageWindow::All),
        _ => Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "usage_window_invalid",
            message: "usage window must be 7d, 30d, or all".to_string(),
        }),
    }
}

fn usage_now_i64() -> i64 {
    i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX)
}

pub(crate) async fn get_usage_summary(
    State(state): State<AppState>,
    Query(query): Query<UsageWindowQuery>,
) -> Result<Json<usage_store::UsageSummary>, GatewayError> {
    let window = parse_usage_window(&query.window)?;
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    let summary = store
        .summary(gateway_user_id().as_str(), window, usage_now_i64())
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "usage_summary_failed",
            message: error.to_string(),
        })?;
    Ok(Json(summary))
}

pub(crate) async fn get_usage_daily(
    State(state): State<AppState>,
    Query(query): Query<UsageWindowQuery>,
) -> Result<Json<usage_store::UsageDailySeries>, GatewayError> {
    let window = parse_usage_window(&query.window)?;
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    let series = store
        .daily_series(
            gateway_user_id().as_str(),
            window,
            usage_now_i64(),
            query.timezone_offset_minutes,
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "usage_daily_failed",
            message: error.to_string(),
        })?;
    Ok(Json(series))
}

async fn usage_breakdown(
    state: AppState,
    query: UsageWindowQuery,
    dimension: usage_store::UsageBreakdownDimension,
) -> Result<Json<Vec<usage_store::UsageBreakdownRow>>, GatewayError> {
    let window = parse_usage_window(&query.window)?;
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    let rows = store
        .breakdown(
            gateway_user_id().as_str(),
            window,
            usage_now_i64(),
            dimension,
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "usage_breakdown_failed",
            message: error.to_string(),
        })?;
    Ok(Json(rows))
}

pub(crate) async fn get_usage_models(
    State(state): State<AppState>,
    Query(query): Query<UsageWindowQuery>,
) -> Result<Json<Vec<usage_store::UsageRouteRow>>, GatewayError> {
    let window = parse_usage_window(&query.window)?;
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    let rows = store
        .model_routes(gateway_user_id().as_str(), window, usage_now_i64())
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "usage_models_failed",
            message: error.to_string(),
        })?;
    Ok(Json(rows))
}

#[derive(Debug, Serialize)]
pub(crate) struct ProviderAccountingRow {
    provider_id: String,
    homun_usage: usage_store::UsageBreakdownRow,
    account_snapshot: Vec<usage_store::ProviderUsageSnapshot>,
    manual_policy: Option<usage_store::ProviderUsagePolicy>,
}

pub(crate) async fn get_usage_providers(
    State(state): State<AppState>,
    Query(query): Query<UsageWindowQuery>,
) -> Result<Json<Vec<ProviderAccountingRow>>, GatewayError> {
    let window = parse_usage_window(&query.window)?;
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    let rows = store
        .breakdown(
            gateway_user_id().as_str(),
            window,
            usage_now_i64(),
            usage_store::UsageBreakdownDimension::Provider,
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "usage_breakdown_failed",
            message: error.to_string(),
        })?;
    let mut accounting = Vec::with_capacity(rows.len());
    for homun_usage in rows {
        let provider_id = homun_usage.key.clone();
        let account_snapshot = store
            .latest_provider_snapshots(gateway_user_id().as_str(), &provider_id)
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "usage_snapshot_read_failed",
                message: error.to_string(),
            })?;
        let manual_policy = store
            .provider_policy(gateway_user_id().as_str(), &provider_id)
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "usage_policy_read_failed",
                message: error.to_string(),
            })?;
        accounting.push(ProviderAccountingRow {
            provider_id,
            homun_usage,
            account_snapshot,
            manual_policy,
        });
    }
    Ok(Json(accounting))
}

pub(crate) async fn get_usage_processes(
    State(state): State<AppState>,
    Query(query): Query<UsageWindowQuery>,
) -> Result<Json<Vec<usage_store::UsageBreakdownRow>>, GatewayError> {
    usage_breakdown(state, query, usage_store::UsageBreakdownDimension::Purpose).await
}

#[derive(Debug, Deserialize)]
pub(crate) struct UsageSuggestionsQuery {
    #[serde(default = "default_usage_window")]
    window: String,
    #[serde(default = "default_usage_suggestion_scope")]
    scope: String,
}

fn default_usage_suggestion_scope() -> String {
    "home".to_string()
}

pub(crate) async fn get_usage_suggestions(
    State(state): State<AppState>,
    Query(query): Query<UsageSuggestionsQuery>,
) -> Result<Json<Vec<usage_suggestions::ModelSuggestion>>, GatewayError> {
    let window = parse_usage_window(&query.window)?;
    let limit = match query.scope.as_str() {
        "home" => 1,
        "settings" => 5,
        _ => {
            return Err(GatewayError {
                status: StatusCode::BAD_REQUEST,
                code: "usage_suggestion_scope_invalid",
                message: "usage suggestion scope must be home or settings".to_string(),
            });
        }
    };
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    let suggestions = build_usage_suggestions(&store, window, &query.window, limit)?;
    Ok(Json(suggestions))
}

fn build_usage_suggestions(
    store: &usage_store::UsageStore,
    window: usage_store::UsageWindow,
    window_label: &str,
    limit: usize,
) -> Result<Vec<usage_suggestions::ModelSuggestion>, GatewayError> {
    use usage_suggestions::{CandidateFacts, SuggestionInput, SuggestionRequirements};

    let user_id = gateway_user_id();
    let now = usage_now_i64();
    let registry = load_provider_registry();
    let mut suggestions = Vec::new();
    for role in [
        "orchestrator",
        "coding",
        "browser",
        "memory",
        "privacy_guard",
    ] {
        let Some(resolved) = registry.resolve_role(role) else {
            continue;
        };
        let Some(current_provider) = registry.get(&resolved.provider_id) else {
            continue;
        };
        let Some(current_model) = current_provider
            .models
            .iter()
            .find(|m| m.id == resolved.model)
        else {
            continue;
        };
        let Some(current_observed) = store
            .model_usage_facts(
                user_id.as_str(),
                &resolved.provider_id,
                &resolved.model,
                window,
                now,
            )
            .map_err(usage_suggestion_read_error)?
        else {
            continue;
        };
        let current = CandidateFacts {
            provider_id: resolved.provider_id.clone(),
            model_id: resolved.model.clone(),
            locality: inference_locality(&current_provider.base_url),
            enabled: current_provider.enabled,
            tools: current_model.tools,
            vision: current_model.vision,
            reasoning: current_model.reasoning,
            context_window: current_model.context_window.unwrap_or(0),
            tier: registry.tier_for(&resolved.provider_id, &resolved.model),
            predicted_cost_microusd: current_observed.average_cost_microusd,
            headroom_percent: provider_headroom_percent(
                store,
                user_id.as_str(),
                &resolved.provider_id,
            )?,
            median_latency_ms: current_observed.median_latency_ms,
            success_rate_basis_points: current_observed.success_rate_basis_points,
            successful_sample_count: current_observed.successful_sample_count,
            cost_provenance: current_observed.cost_provenance,
        };
        let role_req = model_registry::role_requirements(role);
        let requirements = SuggestionRequirements {
            cloud_allowed: role != "privacy_guard",
            tools: role_req.needs_tools,
            vision: role_req.needs_vision,
            reasoning: current_model.reasoning,
            min_context_window: current_model.context_window.unwrap_or(0),
            minimum_tier: current.tier,
        };
        let mut candidates = Vec::new();
        for provider in registry
            .providers
            .iter()
            .filter(|provider| provider.enabled)
        {
            for model in provider
                .models
                .iter()
                .filter(|model| model.modality == role_req.modality)
            {
                let observed = store
                    .model_usage_facts(user_id.as_str(), &provider.id, &model.id, window, now)
                    .map_err(usage_suggestion_read_error)?;
                let (predicted_cost_microusd, cost_provenance) = predicted_candidate_cost(
                    model,
                    inference_locality(&provider.base_url),
                    &current_observed,
                );
                candidates.push(CandidateFacts {
                    provider_id: provider.id.clone(),
                    model_id: model.id.clone(),
                    locality: inference_locality(&provider.base_url),
                    enabled: provider.enabled,
                    tools: model.tools,
                    vision: model.vision,
                    reasoning: model.reasoning,
                    context_window: model.context_window.unwrap_or(0),
                    tier: registry.tier_for(&provider.id, &model.id),
                    predicted_cost_microusd: observed
                        .as_ref()
                        .and_then(|facts| facts.average_cost_microusd)
                        .or(predicted_cost_microusd),
                    headroom_percent: provider_headroom_percent(
                        store,
                        user_id.as_str(),
                        &provider.id,
                    )?,
                    median_latency_ms: observed.as_ref().and_then(|facts| facts.median_latency_ms),
                    success_rate_basis_points: observed
                        .as_ref()
                        .and_then(|facts| facts.success_rate_basis_points),
                    successful_sample_count: observed
                        .as_ref()
                        .map(|facts| facts.successful_sample_count)
                        .unwrap_or(0),
                    cost_provenance: observed
                        .as_ref()
                        .filter(|facts| facts.average_cost_microusd.is_some())
                        .map(|facts| facts.cost_provenance)
                        .unwrap_or(cost_provenance),
                });
            }
        }
        if let Some(suggestion) = usage_suggestions::suggest(&SuggestionInput {
            role: role.to_string(),
            window: window_label.to_string(),
            requirements,
            current,
            candidates,
        }) && !store
            .is_suggestion_suppressed(user_id.as_str(), &suggestion.suggestion_key, now)
            .map_err(usage_suggestion_read_error)?
        {
            suggestions.push(suggestion);
            if suggestions.len() == limit {
                break;
            }
        }
    }
    Ok(suggestions)
}

fn usage_suggestion_read_error(error: impl std::fmt::Display) -> GatewayError {
    GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_suggestion_read_failed",
        message: error.to_string(),
    }
}

fn predicted_candidate_cost(
    model: &model_registry::ModelEntry,
    locality: local_first_inference_usage::Locality,
    current: &usage_store::ModelUsageFacts,
) -> (Option<u64>, local_first_inference_usage::CostProvenance) {
    use local_first_inference_usage::CostProvenance;
    if locality == local_first_inference_usage::Locality::Local && model.price.is_none() {
        return (Some(0), CostProvenance::NotBilled);
    }
    let Some(price) = model.price.as_ref() else {
        return (None, CostProvenance::Unavailable);
    };
    let components = [
        (
            current.average_input_tokens,
            price.input_microusd_per_million,
        ),
        (
            current.average_output_tokens,
            price.output_microusd_per_million,
        ),
        (
            current.average_reasoning_tokens,
            price.reasoning_microusd_per_million,
        ),
    ];
    let mut total = 0_u128;
    let mut known = false;
    for (tokens, rate) in components {
        if tokens == 0 {
            continue;
        }
        let Some(rate) = rate else {
            return (None, CostProvenance::Unavailable);
        };
        known = true;
        total = total.saturating_add(u128::from(tokens).saturating_mul(u128::from(rate)));
    }
    if !known {
        return (None, CostProvenance::Unavailable);
    }
    (
        u64::try_from(total / 1_000_000).ok(),
        CostProvenance::CatalogEstimated,
    )
}

fn provider_headroom_percent(
    store: &usage_store::UsageStore,
    user_id: &str,
    provider_id: &str,
) -> Result<Option<u8>, GatewayError> {
    let snapshots = store
        .latest_provider_snapshots(user_id, provider_id)
        .map_err(usage_suggestion_read_error)?;
    for snapshot in snapshots {
        let Some(limit) = snapshot.limit_value.filter(|value| *value > 0) else {
            continue;
        };
        let Some(remaining) = snapshot
            .remaining_value
            .or_else(|| snapshot.used_value.map(|used| limit.saturating_sub(used)))
        else {
            continue;
        };
        return Ok(Some(
            u8::try_from(remaining.saturating_mul(100) / limit)
                .unwrap_or(100)
                .min(100),
        ));
    }
    Ok(None)
}

fn find_usage_suggestion(
    store: &usage_store::UsageStore,
    suggestion_key: &str,
) -> Result<Option<usage_suggestions::ModelSuggestion>, GatewayError> {
    for (window, label) in [
        (usage_store::UsageWindow::SevenDays, "7d"),
        (usage_store::UsageWindow::ThirtyDays, "30d"),
        (usage_store::UsageWindow::All, "all"),
    ] {
        if let Some(suggestion) = build_usage_suggestions(store, window, label, 5)?
            .into_iter()
            .find(|suggestion| suggestion.suggestion_key == suggestion_key)
        {
            return Ok(Some(suggestion));
        }
    }
    Ok(None)
}

pub(crate) async fn apply_usage_suggestion(
    State(state): State<AppState>,
    Path(suggestion_key): Path<String>,
    Json(request): Json<usage_suggestions::ApplyUsageSuggestionRequest>,
) -> Result<Json<usage_suggestions::ApplyInstruction>, GatewayError> {
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    let suggestion =
        find_usage_suggestion(&store, &suggestion_key)?.ok_or_else(|| GatewayError {
            status: StatusCode::CONFLICT,
            code: "usage_suggestion_stale",
            message: "the suggestion is no longer available".to_string(),
        })?;
    let instruction = usage_suggestions::validate_apply_request(
        &request,
        &suggestion.action_scopes,
        &suggestion.target_provider,
        &suggestion.target_model,
        &suggestion.role,
    )
    .map_err(|code| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code,
        message: "explicit confirmation is required for this suggestion action".to_string(),
    })?;
    let action_name = match request.action {
        usage_suggestions::SuggestionActionScope::UseForTask => "used_for_task",
        usage_suggestions::SuggestionActionScope::ChangeRolePreference => "preference_changed",
    };
    store
        .append_suggestion_action(&usage_store::SuggestionAction {
            action_id: uuid::Uuid::new_v4().to_string(),
            suggestion_key,
            user_id: gateway_user_id().as_str().to_string(),
            workspace_id: Some(gateway_workspace_id().as_str().to_string()),
            thread_id: request.thread_id,
            current_provider: suggestion.current_provider,
            current_model: suggestion.current_model,
            target_provider: suggestion.target_provider,
            target_model: suggestion.target_model,
            role: suggestion.role,
            action: action_name.to_string(),
            scoring_policy_version: suggestion.scoring_policy_version,
            created_at: usage_now_i64(),
        })
        .map_err(usage_suggestion_read_error)?;
    Ok(Json(instruction))
}

pub(crate) async fn dismiss_usage_suggestion(
    State(state): State<AppState>,
    Path(suggestion_key): Path<String>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    let suggestion =
        find_usage_suggestion(&store, &suggestion_key)?.ok_or_else(|| GatewayError {
            status: StatusCode::CONFLICT,
            code: "usage_suggestion_stale",
            message: "the suggestion is no longer available".to_string(),
        })?;
    store
        .append_suggestion_action(&usage_store::SuggestionAction {
            action_id: uuid::Uuid::new_v4().to_string(),
            suggestion_key,
            user_id: gateway_user_id().as_str().to_string(),
            workspace_id: Some(gateway_workspace_id().as_str().to_string()),
            thread_id: None,
            current_provider: suggestion.current_provider,
            current_model: suggestion.current_model,
            target_provider: suggestion.target_provider,
            target_model: suggestion.target_model,
            role: suggestion.role,
            action: "dismissed".to_string(),
            scoring_policy_version: suggestion.scoring_policy_version,
            created_at: usage_now_i64(),
        })
        .map_err(usage_suggestion_read_error)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetProviderUsagePolicyRequest {
    monthly_budget_microusd: Option<u64>,
    #[serde(default = "default_usage_currency")]
    currency: String,
    reset_day: Option<u8>,
    timezone: Option<String>,
    alert_threshold_percent: Option<u8>,
    #[serde(default)]
    pricing_overrides: Vec<usage_store::ModelPriceOverride>,
}

fn default_usage_currency() -> String {
    "USD".to_string()
}

pub(crate) async fn get_usage_provider_policy(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
) -> Result<Json<Option<usage_store::ProviderUsagePolicy>>, GatewayError> {
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    let policy = store
        .provider_policy(gateway_user_id().as_str(), &provider_id)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "usage_policy_read_failed",
            message: error.to_string(),
        })?;
    Ok(Json(policy))
}

pub(crate) async fn set_usage_provider_policy(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
    Json(request): Json<SetProviderUsagePolicyRequest>,
) -> Result<Json<usage_store::ProviderUsagePolicy>, GatewayError> {
    if load_provider_registry().get(&provider_id).is_none() {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "provider_not_found",
            message: format!("provider {provider_id} not configured"),
        });
    }
    let policy = usage_store::ProviderUsagePolicy {
        user_id: gateway_user_id().as_str().to_string(),
        provider_id: provider_id.clone(),
        monthly_budget_microusd: request.monthly_budget_microusd,
        currency: request.currency,
        reset_day: request.reset_day,
        timezone: request.timezone,
        alert_threshold_percent: request.alert_threshold_percent,
        pricing_overrides: request.pricing_overrides,
    };
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    store
        .upsert_provider_policy(&policy, usage_now_i64())
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "usage_policy_invalid",
            message: error.to_string(),
        })?;
    if let Ok(mut pricing) = state.usage_pricing.write() {
        *pricing = build_usage_pricing_snapshot(&store);
    }
    Ok(Json(policy))
}

pub(crate) async fn refresh_usage_provider(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
) -> Result<Json<Vec<usage_store::ProviderUsageSnapshot>>, GatewayError> {
    let provider = load_provider_registry()
        .get(&provider_id)
        .cloned()
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "provider_not_found",
            message: format!("provider {provider_id} not configured"),
        })?;
    let snapshots = provider_usage::refresh_provider_usage(
        &state.http,
        gateway_user_id().as_str(),
        &provider_id,
        provider.kind,
        &provider.base_url,
        provider_api_key(&provider_id).as_deref(),
        usage_now_i64(),
    )
    .await;
    let store = state.usage_store.lock().map_err(|_| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "usage_store_unavailable",
        message: "usage store unavailable".to_string(),
    })?;
    for snapshot in &snapshots {
        store
            .append_provider_snapshot(snapshot)
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "usage_snapshot_write_failed",
                message: error.to_string(),
            })?;
    }
    let latest = store
        .latest_provider_snapshots(gateway_user_id().as_str(), &provider_id)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "usage_snapshot_read_failed",
            message: error.to_string(),
        })?;
    Ok(Json(latest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_window_accepts_supported_values() {
        assert_eq!(
            parse_usage_window("7d").unwrap(),
            usage_store::UsageWindow::SevenDays
        );
        assert_eq!(
            parse_usage_window("30d").unwrap(),
            usage_store::UsageWindow::ThirtyDays
        );
        assert_eq!(
            parse_usage_window("all").unwrap(),
            usage_store::UsageWindow::All
        );
    }

    #[test]
    fn usage_window_rejects_unknown_values() {
        let error = parse_usage_window("90d").unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code, "usage_window_invalid");
    }
}
