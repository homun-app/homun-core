//! REST API endpoints for the Gateway System.
//!
//! CRUD for gateway instances (channel configurations stored in DB).

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{get, post, put};
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};

use super::super::server::AppState;
use crate::gateways;
use crate::storage::{Database, SecretKey};
use crate::web::auth::{require_write, AuthUser};

type ApiErr = (StatusCode, Json<Value>);

fn require_db(state: &AppState) -> Result<&Database, ApiErr> {
    state.db.as_ref().ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "Database not available"})),
        )
    })
}

fn internal(e: anyhow::Error) -> ApiErr {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": e.to_string()})),
    )
}

fn not_found(msg: &str) -> ApiErr {
    (StatusCode::NOT_FOUND, Json(json!({"error": msg})))
}

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/gateways", get(list_gateways).post(create_gateway))
        .route(
            "/v1/gateways/{id}",
            get(get_gateway).put(update_gateway).delete(delete_gateway),
        )
}

// ── Request types ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateGatewayRequest {
    name: String,
    channel_type: String,
    config_json: Option<String>,
    default_profile: Option<String>,
    default_agent: Option<String>,
    response_mode: Option<String>,
    /// Primary token (bot token, password, etc.) — stored encrypted in vault.
    token: Option<String>,
    /// Secondary token (e.g. Slack app_token) — stored encrypted in vault.
    app_token: Option<String>,
}

#[derive(Deserialize)]
struct UpdateGatewayRequest {
    name: Option<String>,
    enabled: Option<bool>,
    config_json: Option<String>,
    default_profile: Option<String>,
    default_agent: Option<String>,
    response_mode: Option<String>,
    /// If provided, updates the primary token in vault.
    token: Option<String>,
    /// If provided, updates the secondary token in vault.
    app_token: Option<String>,
}

// ── Handlers ────────────────────────────────────────────────────────

/// List all gateways (tokens masked in config_json).
async fn list_gateways(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<gateways::Gateway>>, ApiErr> {
    let db = require_db(&state)?;
    let mut list = gateways::db::load_all_gateways(db.pool())
        .await
        .map_err(internal)?;
    for gw in &mut list {
        gw.config_json = mask_tokens_in_json(&gw.config_json);
    }
    Ok(Json(list))
}

/// Create a new gateway.
async fn create_gateway(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Json(body): Json<CreateGatewayRequest>,
) -> Result<(StatusCode, Json<gateways::Gateway>), ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;

    let config_json = body.config_json.as_deref().unwrap_or("{}");
    let default_profile = body.default_profile.as_deref().unwrap_or("");
    let default_agent = body.default_agent.as_deref().unwrap_or("");
    let response_mode = body.response_mode.as_deref().unwrap_or("automatic");

    let user_id = Some(crate::user::DEFAULT_ADMIN_USER_ID);
    let id = gateways::db::insert_gateway(
        db.pool(),
        &body.name,
        &body.channel_type,
        config_json,
        default_profile,
        default_agent,
        response_mode,
        user_id,
    )
    .await
    .map_err(internal)?;

    // Store tokens in vault
    store_token_if_provided(&body.token, SecretKey::gateway_token(id));
    store_token_if_provided(&body.app_token, SecretKey::gateway_app_token(id));

    let mut gw = gateways::db::load_gateway_by_id(db.pool(), id)
        .await
        .map_err(internal)?
        .ok_or_else(|| not_found("Gateway created but not found"))?;
    gw.config_json = mask_tokens_in_json(&gw.config_json);

    Ok((StatusCode::CREATED, Json(gw)))
}

/// Get a single gateway by ID (tokens masked).
async fn get_gateway(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<gateways::Gateway>, ApiErr> {
    let db = require_db(&state)?;
    let mut gw = gateways::db::load_gateway_by_id(db.pool(), id)
        .await
        .map_err(internal)?
        .ok_or_else(|| not_found("Gateway not found"))?;
    gw.config_json = mask_tokens_in_json(&gw.config_json);
    Ok(Json(gw))
}

/// Update a gateway's mutable fields.
async fn update_gateway(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateGatewayRequest>,
) -> Result<Json<gateways::Gateway>, ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;

    let existing = gateways::db::load_gateway_by_id(db.pool(), id)
        .await
        .map_err(internal)?
        .ok_or_else(|| not_found("Gateway not found"))?;

    let name = body.name.as_deref().unwrap_or(&existing.name);
    let enabled = body.enabled.unwrap_or(existing.is_enabled());
    let config_json = body.config_json.as_deref().unwrap_or(&existing.config_json);
    let default_profile = body
        .default_profile
        .as_deref()
        .unwrap_or(&existing.default_profile);
    let default_agent = body
        .default_agent
        .as_deref()
        .unwrap_or(&existing.default_agent);
    let response_mode = body
        .response_mode
        .as_deref()
        .unwrap_or(&existing.response_mode);

    gateways::db::update_gateway(
        db.pool(),
        id,
        name,
        enabled,
        config_json,
        default_profile,
        default_agent,
        response_mode,
    )
    .await
    .map_err(internal)?;

    // Update tokens in vault if provided
    store_token_if_provided(&body.token, SecretKey::gateway_token(id));
    store_token_if_provided(&body.app_token, SecretKey::gateway_app_token(id));

    let mut gw = gateways::db::load_gateway_by_id(db.pool(), id)
        .await
        .map_err(internal)?
        .ok_or_else(|| not_found("Gateway not found after update"))?;
    gw.config_json = mask_tokens_in_json(&gw.config_json);
    Ok(Json(gw))
}

/// Delete a gateway and its vault tokens.
async fn delete_gateway(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;

    // Clear vault tokens (set to empty — vault has no remove method)
    if let Ok(secrets) = crate::storage::global_secrets() {
        let _ = secrets.set(&SecretKey::gateway_token(id), "");
        let _ = secrets.set(&SecretKey::gateway_app_token(id), "");
    }

    gateways::db::delete_gateway(db.pool(), id)
        .await
        .map_err(internal)?;

    Ok(Json(json!({"ok": true})))
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Store a token in the vault if provided and non-empty.
fn store_token_if_provided(token: &Option<String>, key: SecretKey) {
    if let Some(t) = token {
        if !t.is_empty() {
            if let Ok(secrets) = crate::storage::global_secrets() {
                if let Err(e) = secrets.set(&key, t) {
                    tracing::warn!(error = %e, key = %key, "Failed to store token in vault");
                }
            }
        }
    }
}

/// Mask sensitive fields (token, password, app_token) in a JSON string.
///
/// Replaces values of keys ending with "token" or "password" with masked versions
/// showing only the last 4 characters.
fn mask_tokens_in_json(json_str: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<Value>(json_str) else {
        return json_str.to_string();
    };

    if let Some(obj) = v.as_object_mut() {
        let sensitive_keys: Vec<String> = obj
            .keys()
            .filter(|k| {
                let lower = k.to_lowercase();
                lower.contains("token") || lower.contains("password") || lower == "api_key"
            })
            .cloned()
            .collect();

        for key in sensitive_keys {
            if let Some(Value::String(val)) = obj.get(&key) {
                if !val.is_empty() && val != "***ENCRYPTED***" {
                    let masked = mask_value(val);
                    obj.insert(key, Value::String(masked));
                }
            }
        }
    }

    serde_json::to_string(&v).unwrap_or_else(|_| json_str.to_string())
}

/// Mask a secret value, showing only the last 4 chars.
fn mask_value(value: &str) -> String {
    if value.len() <= 4 {
        return "••••••••".to_string();
    }
    let visible = &value[value.len() - 4..];
    format!("{}{visible}", "•".repeat((value.len().min(20)) - 4))
}
