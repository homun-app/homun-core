//! REST API endpoints for the Gateway System.
//!
//! CRUD for gateway instances (channel configurations stored in DB).

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{get, post, put};
use axum::Router;
use serde::{Deserialize, Serialize};
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
        .route("/v1/gateways/diagnostics", get(list_gateway_diagnostics))
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

#[derive(Debug, Serialize)]
struct GatewayDiagnostics {
    id: i64,
    name: String,
    channel_type: String,
    enabled: bool,
    status: &'static str,
    configured: bool,
    issues: Vec<GatewayIssue>,
}

#[derive(Debug, Serialize)]
struct GatewayIssue {
    code: &'static str,
    message: String,
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

/// List non-sensitive gateway diagnostics derived from DB config + vault presence.
async fn list_gateway_diagnostics(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<GatewayDiagnostics>>, ApiErr> {
    let db = require_db(&state)?;
    let list = gateways::db::load_all_gateways(db.pool())
        .await
        .map_err(internal)?;
    let diagnostics = list.iter().map(build_gateway_diagnostics).collect();
    Ok(Json(diagnostics))
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

fn vault_has_secret(key: SecretKey) -> bool {
    crate::storage::global_secrets()
        .ok()
        .and_then(|secrets| secrets.get(&key).ok().flatten())
        .is_some_and(|value| !value.trim().is_empty())
}

fn has_gateway_token(gateway_id: i64, raw: &str) -> bool {
    if raw == "***ENCRYPTED***" || raw.trim().is_empty() {
        vault_has_secret(SecretKey::gateway_token(gateway_id))
    } else {
        true
    }
}

fn has_gateway_app_token(gateway_id: i64, raw: &str) -> bool {
    if raw == "***ENCRYPTED***" || raw.trim().is_empty() {
        vault_has_secret(SecretKey::gateway_app_token(gateway_id))
    } else {
        true
    }
}

fn issue(code: &'static str, message: impl Into<String>) -> GatewayIssue {
    GatewayIssue {
        code,
        message: message.into(),
    }
}

fn build_gateway_diagnostics(gw: &gateways::Gateway) -> GatewayDiagnostics {
    let mut issues = Vec::new();

    if !gw.is_enabled() {
        issues.push(issue("disabled", "Gateway is disabled."));
    }

    match gw.channel_type.as_str() {
        "telegram" => {
            match serde_json::from_str::<crate::config::TelegramConfig>(&gw.config_json) {
                Ok(cfg) => {
                    if !has_gateway_token(gw.id, &cfg.token) {
                        issues.push(issue(
                            "missing_token",
                            format!(
                                "Missing vault secret '{}'.",
                                SecretKey::gateway_token(gw.id)
                            ),
                        ));
                    }
                }
                Err(e) => issues.push(issue("invalid_config_json", e.to_string())),
            }
        }
        "discord" => match serde_json::from_str::<crate::config::DiscordConfig>(&gw.config_json) {
            Ok(cfg) => {
                if !has_gateway_token(gw.id, &cfg.token) {
                    issues.push(issue(
                        "missing_token",
                        format!(
                            "Missing vault secret '{}'.",
                            SecretKey::gateway_token(gw.id)
                        ),
                    ));
                }
            }
            Err(e) => issues.push(issue("invalid_config_json", e.to_string())),
        },
        "slack" => match serde_json::from_str::<crate::config::SlackConfig>(&gw.config_json) {
            Ok(cfg) => {
                if !has_gateway_token(gw.id, &cfg.token) {
                    issues.push(issue(
                        "missing_token",
                        format!(
                            "Missing vault secret '{}'.",
                            SecretKey::gateway_token(gw.id)
                        ),
                    ));
                }
                if !cfg.app_token.trim().is_empty() && !has_gateway_app_token(gw.id, &cfg.app_token)
                {
                    issues.push(issue(
                        "missing_app_token",
                        format!(
                            "Missing vault secret '{}'.",
                            SecretKey::gateway_app_token(gw.id)
                        ),
                    ));
                }
            }
            Err(e) => issues.push(issue("invalid_config_json", e.to_string())),
        },
        "email" => {
            match serde_json::from_str::<crate::config::EmailAccountConfig>(&gw.config_json) {
                Ok(cfg) => {
                    let has_password = has_gateway_token(gw.id, &cfg.password);
                    if !cfg.enabled {
                        issues.push(issue(
                            "account_disabled",
                            "Email account inside this gateway is disabled.",
                        ));
                    }
                    if cfg.imap_host.trim().is_empty() {
                        issues.push(issue("missing_imap_host", "IMAP host is missing."));
                    }
                    if cfg.smtp_host.trim().is_empty() {
                        issues.push(issue("missing_smtp_host", "SMTP host is missing."));
                    }
                    if cfg.username.trim().is_empty() {
                        issues.push(issue("missing_username", "Email username is missing."));
                    }
                    if !has_password {
                        issues.push(issue(
                            "missing_password",
                            format!(
                                "Missing vault secret '{}'.",
                                SecretKey::gateway_token(gw.id)
                            ),
                        ));
                    }
                }
                Err(e) => issues.push(issue("invalid_config_json", e.to_string())),
            }
        }
        "whatsapp" => {
            match serde_json::from_str::<crate::config::WhatsAppConfig>(&gw.config_json) {
                Ok(cfg) => {
                    if cfg.phone_number.trim().is_empty() {
                        issues.push(issue(
                            "pairing_required",
                            "WhatsApp has no phone number configured; QR/pairing is required.",
                        ));
                    }
                    if !cfg.resolved_db_path().exists() {
                        issues.push(issue(
                            "missing_session_db",
                            format!(
                                "WhatsApp session DB does not exist at '{}'.",
                                cfg.resolved_db_path().display()
                            ),
                        ));
                    }
                }
                Err(e) => issues.push(issue("invalid_config_json", e.to_string())),
            }
        }
        ct if ct.starts_with("mcp:") => {
            if gw.config_json.trim().is_empty() || gw.config_json.trim() == "{}" {
                issues.push(issue("empty_config", "MCP channel config is empty."));
            }
        }
        other => issues.push(issue(
            "unknown_channel_type",
            format!("Unknown channel type '{other}'."),
        )),
    }

    let actionable_issues = issues.iter().any(|item| item.code != "disabled");
    let configured = gw.is_enabled() && !actionable_issues;
    let status = if !gw.is_enabled() {
        "disabled"
    } else if configured {
        "ready"
    } else {
        "needs_attention"
    };

    GatewayDiagnostics {
        id: gw.id,
        name: gw.name.clone(),
        channel_type: gw.channel_type.clone(),
        enabled: gw.is_enabled(),
        status,
        configured,
        issues,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn gateway(id: i64, channel_type: &str, config_json: String) -> gateways::Gateway {
        gateways::Gateway {
            id,
            name: "Test".to_string(),
            channel_type: channel_type.to_string(),
            enabled: 1,
            config_json,
            default_profile: String::new(),
            default_agent: String::new(),
            response_mode: "automatic".to_string(),
            user_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn email_diagnostics_report_missing_password() {
        let mut cfg = crate::config::EmailAccountConfig::default();
        cfg.enabled = true;
        cfg.imap_host = "imap.example.com".to_string();
        cfg.smtp_host = "smtp.example.com".to_string();
        cfg.username = "bot@example.com".to_string();
        cfg.password = "***ENCRYPTED***".to_string();
        let gw = gateway(42, "email", serde_json::to_string(&cfg).unwrap());

        let diag = build_gateway_diagnostics(&gw);

        assert_eq!(diag.status, "needs_attention");
        assert!(!diag.configured);
        assert!(diag
            .issues
            .iter()
            .any(|issue| issue.code == "missing_password"));
    }

    #[test]
    fn token_gateway_with_plain_token_is_ready() {
        let cfg = crate::config::TelegramConfig {
            enabled: true,
            token: "plain-token".to_string(),
            ..Default::default()
        };
        let gw = gateway(7, "telegram", serde_json::to_string(&cfg).unwrap());

        let diag = build_gateway_diagnostics(&gw);

        assert_eq!(diag.status, "ready");
        assert!(diag.configured);
        assert!(diag.issues.is_empty());
    }
}
