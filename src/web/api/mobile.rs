use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use chrono::{Duration, Utc};
use ring::digest;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::TunnelConfig;
use crate::storage::{global_secrets, MobileDeviceRow, MobilePairingSessionRow, SecretKey};
use crate::web::auth::{require_admin, AuthUser, BearerTokenValue};
use crate::web::server::AppState;

const MIN_PAIRING_TTL_SECS: i64 = 120;
const MAX_PAIRING_TTL_SECS: i64 = 600;
const DEFAULT_PAIRING_TTL_SECS: i64 = 300;
const SERVER_FINGERPRINT_SECRET: &str = "mobile.server_fingerprint_seed";

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/mobile/pairing/sessions", post(create_pairing_session))
        .route("/v1/mobile/pairing/sessions/{id}", get(get_pairing_session))
        .route(
            "/v1/mobile/pairing/sessions/{id}/approve",
            post(approve_pairing_session),
        )
        .route("/v1/mobile/devices", get(list_mobile_devices))
        .route("/v1/mobile/devices/{id}", delete(revoke_mobile_device))
        .route("/v1/mobile/tunnel", get(get_tunnel_config).put(save_tunnel_config))
        .route("/v1/mobile/bootstrap", get(mobile_bootstrap))
}

pub(super) fn public_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/v1/mobile/pairing/claim", post(claim_pairing_session))
        .route(
            "/api/v1/mobile/pairing/sessions/{id}/result",
            get(pairing_result),
        )
}

#[derive(Deserialize)]
struct CreatePairingSessionRequest {
    preferred_base_url: Option<String>,
    ttl_seconds: Option<u64>,
}

#[derive(Serialize)]
struct CreatePairingSessionResponse {
    pairing_id: String,
    status: &'static str,
    expires_at: String,
    qr_payload: PairingQrPayload,
    qr_svg: String,
}

#[derive(Serialize)]
struct PairingQrPayload {
    v: u8,
    #[serde(rename = "type")]
    payload_type: &'static str,
    base_url: String,
    pairing_id: String,
    nonce: String,
    server_fingerprint: String,
    expires_at: String,
}

#[derive(Serialize)]
struct PairingSessionResponse {
    pairing_id: String,
    status: String,
    expires_at: String,
    device: Option<ClaimedDeviceSummary>,
}

#[derive(Serialize)]
struct ClaimedDeviceSummary {
    name: String,
    platform: String,
    app_version: Option<String>,
    has_public_key: bool,
}

#[derive(Deserialize)]
struct ClaimPairingRequest {
    pairing_id: String,
    nonce: String,
    device_name: String,
    platform: String,
    app_version: Option<String>,
    device_public_key: Option<String>,
    push_token: Option<String>,
}

#[derive(Serialize)]
struct ClaimPairingResponse {
    pairing_id: String,
    status: &'static str,
    expires_at: String,
}

#[derive(Deserialize)]
struct ApprovePairingRequest {
    allow_emergency_stop: Option<bool>,
}

#[derive(Serialize)]
struct ApprovePairingResponse {
    pairing_id: String,
    status: &'static str,
    device_id: String,
}

#[derive(Deserialize)]
struct PairingResultQuery {
    nonce: String,
}

#[derive(Serialize)]
struct PairingPendingResponse {
    pairing_id: String,
    status: String,
}

#[derive(Serialize)]
struct PairingApprovedResponse {
    pairing_id: String,
    status: &'static str,
    device_id: String,
    token: String,
    base_url: String,
    server_fingerprint: String,
    capabilities: MobileCapabilities,
}

#[derive(Serialize)]
struct MobileDevicesResponse {
    devices: Vec<MobileDeviceSummary>,
}

#[derive(Serialize)]
struct MobileDeviceSummary {
    id: String,
    name: String,
    platform: String,
    app_version: Option<String>,
    created_at: String,
    last_seen_at: Option<String>,
    revoked: bool,
    can_emergency_stop: bool,
}

#[derive(Serialize)]
struct MobileBootstrapResponse {
    device: BootstrapDevice,
    account: BootstrapAccount,
    server: BootstrapServer,
    capabilities: MobileCapabilities,
}

#[derive(Serialize)]
struct MobileTunnelConfigResponse {
    tunnel: MobileTunnelConfigView,
    current_public_url: Option<String>,
    pairing_ready: bool,
    message: String,
}

#[derive(Serialize)]
struct MobileTunnelConfigView {
    enabled: bool,
    provider: String,
    has_auth_token: bool,
    reserved_url: String,
    custom_command: String,
    custom_args: Vec<String>,
}

#[derive(Deserialize)]
struct SaveMobileTunnelConfigRequest {
    enabled: bool,
    provider: String,
    auth_token: Option<String>,
    reserved_url: Option<String>,
    custom_command: Option<String>,
    custom_args: Option<Vec<String>>,
}

#[derive(Serialize)]
struct BootstrapDevice {
    id: String,
    name: String,
    platform: String,
}

#[derive(Serialize)]
struct BootstrapAccount {
    username: String,
}

#[derive(Serialize)]
struct BootstrapServer {
    base_url: String,
    fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
struct MobileCapabilities {
    chat: bool,
    approvals: bool,
    activity_feed: bool,
    emergency_stop: bool,
}

async fn create_pairing_session(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Json(body): Json<CreatePairingSessionRequest>,
) -> Result<Json<CreatePairingSessionResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;
    let db = require_db(&state)?;

    let base_url = resolve_public_base_url(&state, body.preferred_base_url)?;
    let server_fingerprint = server_fingerprint().map_err(internal_error)?;
    let pairing_id = format!("pair_{}", Uuid::new_v4().simple());
    let nonce = random_secret(32).map_err(internal_error)?;
    let nonce_hash = sha256_hex(&nonce);
    let ttl_secs = clamp_ttl(body.ttl_seconds);
    let expires_at = (Utc::now() + Duration::seconds(ttl_secs)).to_rfc3339();

    db.insert_mobile_pairing_session(
        &pairing_id,
        &auth.user_id,
        "created",
        &nonce_hash,
        &base_url,
        &server_fingerprint,
        &expires_at,
    )
    .await
    .map_err(internal_error)?;

    let qr_payload = PairingQrPayload {
        v: 1,
        payload_type: "homun_mobile_pair",
        base_url: base_url.clone(),
        pairing_id: pairing_id.clone(),
        nonce: nonce.clone(),
        server_fingerprint: server_fingerprint.clone(),
        expires_at: expires_at.clone(),
    };
    let qr_json = serde_json::to_string(&qr_payload).map_err(|error| internal_error(error.into()))?;

    Ok(Json(CreatePairingSessionResponse {
        pairing_id,
        status: "created",
        expires_at,
        qr_payload,
        qr_svg: render_qr_svg(&qr_json),
    }))
}

async fn get_pairing_session(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(pairing_id): Path<String>,
) -> Result<Json<PairingSessionResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;
    let db = require_db(&state)?;
    let pairing = load_owned_pairing_session(db, &auth.user_id, &pairing_id).await?;
    let status = effective_pairing_status(&pairing);

    Ok(Json(PairingSessionResponse {
        pairing_id: pairing.id,
        status,
        expires_at: pairing.expires_at,
        device: pairing
            .device_name
            .as_ref()
            .zip(pairing.platform.as_ref())
            .map(|(name, platform)| ClaimedDeviceSummary {
                name: name.clone(),
                platform: platform.clone(),
                app_version: pairing.app_version.clone(),
                has_public_key: pairing.device_public_key.is_some(),
            }),
    }))
}

async fn claim_pairing_session(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ClaimPairingRequest>,
) -> Result<Json<ClaimPairingResponse>, (StatusCode, Json<serde_json::Value>)> {
    let db = require_db(&state)?;
    let pairing = db
        .load_mobile_pairing_session(&body.pairing_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("pairing_not_found", "Pairing session not found"))?;

    if is_pairing_expired(&pairing) {
        return Err(gone("pairing_expired", "Pairing session has expired"));
    }
    if pairing.status != "created" {
        return Err(conflict(
            "pairing_already_claimed",
            "Pairing session is no longer claimable",
        ));
    }
    validate_pairing_nonce(&pairing, &body.nonce)?;
    validate_platform(&body.platform)?;

    if body.device_name.trim().is_empty() || body.device_name.len() > 80 {
        return Err(bad_request(
            "invalid_device_name",
            "Device name must be between 1 and 80 characters",
        ));
    }

    let claimed = db
        .claim_mobile_pairing_session(
            &pairing.id,
            body.device_name.trim(),
            &body.platform,
            body.app_version.as_deref(),
            body.device_public_key.as_deref(),
            body.push_token.as_deref(),
        )
        .await
        .map_err(internal_error)?;

    if !claimed {
        return Err(conflict(
            "pairing_already_claimed",
            "Pairing session was claimed concurrently",
        ));
    }

    Ok(Json(ClaimPairingResponse {
        pairing_id: pairing.id,
        status: "claimed",
        expires_at: pairing.expires_at,
    }))
}

async fn approve_pairing_session(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(pairing_id): Path<String>,
    Json(body): Json<ApprovePairingRequest>,
) -> Result<Json<ApprovePairingResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;
    let db = require_db(&state)?;
    let pairing = load_owned_pairing_session(db, &auth.user_id, &pairing_id).await?;

    if is_pairing_expired(&pairing) {
        return Err(gone("pairing_expired", "Pairing session has expired"));
    }
    if pairing.status != "claimed" {
        return Err(conflict(
            "pairing_not_claimed",
            "Pairing session is not waiting for approval",
        ));
    }

    let device_name = pairing
        .device_name
        .as_deref()
        .ok_or_else(|| bad_request("invalid_pairing", "Missing claimed device name"))?;
    let platform = pairing
        .platform
        .as_deref()
        .ok_or_else(|| bad_request("invalid_pairing", "Missing claimed device platform"))?;

    let allow_emergency_stop = body.allow_emergency_stop.unwrap_or(false);
    let device_id = format!("mob_{}", Uuid::new_v4().simple());
    let token_scope = if allow_emergency_stop {
        "mobile_stop"
    } else {
        "mobile"
    };
    let token = format!("hm_mobile_{}", Uuid::new_v4().simple());
    let token_name = format!("Mobile App - {}", device_name);

    db.approve_mobile_pairing_session(
        &pairing.id,
        &device_id,
        &auth.user_id,
        device_name,
        platform,
        pairing.app_version.as_deref(),
        pairing.device_public_key.as_deref(),
        pairing.device_push_token.as_deref(),
        &token,
        &token_name,
        token_scope,
        &pairing.server_fingerprint,
        allow_emergency_stop,
    )
    .await
    .map_err(internal_error)?;

    Ok(Json(ApprovePairingResponse {
        pairing_id: pairing.id,
        status: "approved",
        device_id,
    }))
}

async fn pairing_result(
    State(state): State<Arc<AppState>>,
    Path(pairing_id): Path<String>,
    Query(query): Query<PairingResultQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let db = require_db(&state)?;
    let pairing = db
        .load_mobile_pairing_session(&pairing_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("pairing_not_found", "Pairing session not found"))?;

    validate_pairing_nonce(&pairing, &query.nonce)?;

    if is_pairing_expired(&pairing) {
        return Err(gone("pairing_expired", "Pairing session has expired"));
    }

    match pairing.status.as_str() {
        "approved" => {
            let device = load_pairing_device(db, &pairing).await?;
            let response = PairingApprovedResponse {
                pairing_id: pairing.id.clone(),
                status: "approved",
                device_id: device.id.clone(),
                token: device.token.clone(),
                base_url: pairing.base_url.clone(),
                server_fingerprint: pairing.server_fingerprint.clone(),
                capabilities: capabilities_for_scope(token_scope(&device)),
            };
            db.complete_mobile_pairing_session(&pairing.id)
                .await
                .map_err(internal_error)?;
            Ok(Json(
                serde_json::to_value(response)
                    .map_err(|error| internal_error(error.into()))?,
            ))
        }
        "completed" => Ok(Json(serde_json::json!({
            "pairing_id": pairing.id,
            "status": "completed"
        }))),
        status => Ok(Json(
            serde_json::to_value(PairingPendingResponse {
                pairing_id: pairing.id,
                status: status.to_string(),
            })
            .map_err(|error| internal_error(error.into()))?,
        )),
    }
}

async fn list_mobile_devices(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
) -> Result<Json<MobileDevicesResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;
    let db = require_db(&state)?;
    let devices = db
        .load_mobile_devices(&auth.user_id)
        .await
        .map_err(internal_error)?;

    Ok(Json(MobileDevicesResponse {
        devices: devices.into_iter().map(device_summary).collect(),
    }))
}

async fn revoke_mobile_device(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;
    let db = require_db(&state)?;
    let device = db
        .load_mobile_device(&device_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("device_not_found", "Mobile device not found"))?;

    if device.user_id != auth.user_id {
        return Err(not_found("device_not_found", "Mobile device not found"));
    }

    let revoked = db
        .revoke_mobile_device(&device_id)
        .await
        .map_err(internal_error)?;

    if !revoked {
        return Err(not_found("device_not_found", "Mobile device not found"));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn mobile_bootstrap(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    token: Option<axum::Extension<BearerTokenValue>>,
) -> Result<Json<MobileBootstrapResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_mobile_scope(&auth)?;
    let db = require_db(&state)?;
    let token = token
        .map(|axum::Extension(token)| token)
        .ok_or_else(|| unauthorized("invalid_mobile_token", "Missing mobile bearer token"))?;
    let device = db
        .load_mobile_device_by_token(&token.0)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| unauthorized("invalid_mobile_token", "Unknown mobile device token"))?;
    let capabilities = capabilities_for_scope(token_scope(&device));

    let base_url = state
        .public_base_url
        .clone()
        .unwrap_or_else(|| "https://127.0.0.1:18443".to_string());

    Ok(Json(MobileBootstrapResponse {
        device: BootstrapDevice {
            id: device.id,
            name: device.name,
            platform: device.platform,
        },
        account: BootstrapAccount {
            username: auth.username,
        },
        server: BootstrapServer {
            base_url,
            fingerprint: device.server_fingerprint_at_pair,
        },
        capabilities,
    }))
}

async fn get_tunnel_config(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
) -> Result<Json<MobileTunnelConfigResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;
    let config = state.config.read().await;
    let tunnel = config.channels.web.tunnel.clone().unwrap_or(TunnelConfig {
        enabled: false,
        provider: "cloudflare".to_string(),
        auth_token: String::new(),
        reserved_url: String::new(),
        custom_command: String::new(),
        custom_args: Vec::new(),
    });
    let current_public_url = state.public_base_url.clone();
    drop(config);

    let pairing_ready = current_public_url.is_some();
    let message = if pairing_ready {
        "Mobile pairing can generate a reachable QR code.".to_string()
    } else if tunnel.enabled {
        "Tunnel is configured but not active yet. Restart Homun to apply the change.".to_string()
    } else {
        "No mobile-reachable URL available yet. Enable a tunnel or configure a public domain."
            .to_string()
    };

    Ok(Json(MobileTunnelConfigResponse {
        tunnel: MobileTunnelConfigView {
            enabled: tunnel.enabled,
            provider: tunnel.provider,
            has_auth_token: !tunnel.auth_token.trim().is_empty(),
            reserved_url: tunnel.reserved_url,
            custom_command: tunnel.custom_command,
            custom_args: tunnel.custom_args,
        },
        current_public_url,
        pairing_ready,
        message,
    }))
}

async fn save_tunnel_config(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Json(body): Json<SaveMobileTunnelConfigRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;

    let provider = body.provider.trim().to_lowercase();
    if !matches!(provider.as_str(), "cloudflare" | "ngrok" | "custom") {
        return Err(bad_request(
            "invalid_provider",
            "Tunnel provider must be cloudflare, ngrok, or custom",
        ));
    }

    if provider == "custom"
        && body
            .custom_command
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
        && body.enabled
    {
        return Err(bad_request(
            "missing_custom_command",
            "custom_command is required when provider is custom",
        ));
    }

    if provider == "ngrok" {
        if let Some(url) = body.reserved_url.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Err(bad_request(
                    "invalid_reserved_url",
                    "reserved_url must start with http:// or https://",
                ));
            }
        }
    }

    let mut config = state.config.read().await.clone();
    let existing = config.channels.web.tunnel.clone();
    let auth_token = body
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| existing.as_ref().map(|item| item.auth_token.clone()))
        .unwrap_or_default();

    config.channels.web.tunnel = Some(TunnelConfig {
        enabled: body.enabled,
        provider,
        auth_token,
        reserved_url: body
            .reserved_url
            .unwrap_or_default()
            .trim()
            .to_string(),
        custom_command: body
            .custom_command
            .unwrap_or_default()
            .trim()
            .to_string(),
        custom_args: body
            .custom_args
            .unwrap_or_default()
            .into_iter()
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
    });

    state.save_config(config).await.map_err(internal_error)?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "message": "Tunnel configuration saved. Restart Homun to apply the change."
    })))
}

fn require_db(state: &AppState) -> Result<&crate::storage::Database, (StatusCode, Json<serde_json::Value>)> {
    state
        .db
        .as_ref()
        .ok_or_else(|| internal_server_error("no_database", "Database not available"))
}

async fn load_owned_pairing_session(
    db: &crate::storage::Database,
    user_id: &str,
    pairing_id: &str,
) -> Result<MobilePairingSessionRow, (StatusCode, Json<serde_json::Value>)> {
    let pairing = db
        .load_mobile_pairing_session(pairing_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("pairing_not_found", "Pairing session not found"))?;

    if pairing.user_id != user_id {
        return Err(not_found("pairing_not_found", "Pairing session not found"));
    }

    Ok(pairing)
}

fn resolve_public_base_url(
    state: &AppState,
    preferred_base_url: Option<String>,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    if let Some(url) = preferred_base_url {
        let trimmed = url.trim();
        if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
            return Ok(trimmed.to_string());
        }
        return Err(bad_request(
            "invalid_base_url",
            "preferred_base_url must start with http:// or https://",
        ));
    }

    state.public_base_url.clone().ok_or_else(|| {
        bad_request(
            "no_public_base_url",
            "No mobile-reachable base URL available. Configure a tunnel or a public/LAN domain for the web UI.",
        )
    })
}

fn clamp_ttl(ttl_seconds: Option<u64>) -> i64 {
    ttl_seconds
        .map(|ttl| ttl as i64)
        .unwrap_or(DEFAULT_PAIRING_TTL_SECS)
        .clamp(MIN_PAIRING_TTL_SECS, MAX_PAIRING_TTL_SECS)
}

fn effective_pairing_status(pairing: &MobilePairingSessionRow) -> String {
    if is_pairing_expired(pairing) && !matches!(pairing.status.as_str(), "completed" | "revoked") {
        "expired".to_string()
    } else {
        pairing.status.clone()
    }
}

fn is_pairing_expired(pairing: &MobilePairingSessionRow) -> bool {
    chrono::DateTime::parse_from_rfc3339(&pairing.expires_at)
        .map(|expiry| Utc::now() > expiry)
        .unwrap_or(false)
}

fn validate_pairing_nonce(
    pairing: &MobilePairingSessionRow,
    nonce: &str,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if sha256_hex(nonce) == pairing.nonce_hash {
        Ok(())
    } else {
        Err(forbidden(
            "invalid_nonce",
            "Pairing nonce is invalid or already used",
        ))
    }
}

fn validate_platform(platform: &str) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if matches!(platform, "ios" | "android") {
        Ok(())
    } else {
        Err(bad_request(
            "invalid_platform",
            "platform must be either ios or android",
        ))
    }
}

fn require_mobile_scope(
    auth: &AuthUser,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    match &auth.auth_method {
        crate::web::auth::AuthMethod::BearerToken { scope }
            if matches!(scope.as_str(), "mobile" | "mobile_stop") =>
        {
            Ok(())
        }
        _ => Err(forbidden(
            "mobile_scope_required",
            "Mobile bearer token required",
        )),
    }
}

fn token_scope(device: &MobileDeviceRow) -> &'static str {
    if device.can_emergency_stop {
        "mobile_stop"
    } else {
        "mobile"
    }
}

fn capabilities_for_scope(scope: &str) -> MobileCapabilities {
    MobileCapabilities {
        chat: true,
        approvals: false,
        activity_feed: false,
        emergency_stop: scope == "mobile_stop",
    }
}

fn device_summary(device: MobileDeviceRow) -> MobileDeviceSummary {
    MobileDeviceSummary {
        id: device.id,
        name: device.name,
        platform: device.platform,
        app_version: device.app_version,
        created_at: device.created_at,
        last_seen_at: device.last_seen_at,
        revoked: device.revoked_at.is_some(),
        can_emergency_stop: device.can_emergency_stop,
    }
}

fn random_secret(len: usize) -> anyhow::Result<String> {
    let rng = SystemRandom::new();
    let mut bytes = vec![0u8; len];
    rng.fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("failed to generate random secret"))?;
    Ok(B64.encode(bytes))
}

fn render_qr_svg(content: &str) -> String {
    match qrcodegen::QrCode::encode_text(content, qrcodegen::QrCodeEcc::Medium) {
        Ok(code) => {
            let border = 4;
            let size = code.size() + border * 2;
            let mut svg = format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" shape-rendering=\"crispEdges\">\
                 <rect width=\"100%\" height=\"100%\" fill=\"white\"/>"
            );

            for y in 0..code.size() {
                for x in 0..code.size() {
                    if code.get_module(x, y) {
                        svg.push_str(&format!(
                            "<rect x=\"{}\" y=\"{}\" width=\"1\" height=\"1\" fill=\"#111827\"/>",
                            x + border,
                            y + border
                        ));
                    }
                }
            }

            svg.push_str("</svg>");
            svg
        }
        Err(error) => {
            tracing::error!(%error, "Failed to render mobile pairing QR SVG");
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 240 240\">\
             <rect width=\"240\" height=\"240\" fill=\"#f8fafc\" rx=\"20\"/>\
             <text x=\"120\" y=\"120\" text-anchor=\"middle\" font-size=\"14\" fill=\"#991b1b\">QR unavailable</text>\
             </svg>"
                .to_string()
        }
    }
}

fn sha256_hex(input: &str) -> String {
    let digest = digest::digest(&digest::SHA256, input.as_bytes());
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn server_fingerprint() -> anyhow::Result<String> {
    let secrets = global_secrets()?;
    let key = SecretKey::custom(SERVER_FINGERPRINT_SECRET);
    let seed = if let Some(seed) = secrets.get(&key)? {
        seed
    } else {
        let seed = random_secret(32)?;
        secrets.set(&key, &seed)?;
        seed
    };

    Ok(format!("sha256:{}", sha256_hex(&seed)))
}

async fn load_pairing_device(
    db: &crate::storage::Database,
    pairing: &MobilePairingSessionRow,
) -> Result<MobileDeviceRow, (StatusCode, Json<serde_json::Value>)> {
    let device_id = pairing
        .device_id
        .as_deref()
        .ok_or_else(|| internal_server_error("missing_device", "Approved pairing has no device"))?;

    db.load_mobile_device(device_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| internal_server_error("missing_device", "Approved device not found"))
}

fn bad_request(error: &str, message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
}

fn unauthorized(error: &str, message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
}

fn forbidden(error: &str, message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
}

fn not_found(error: &str, message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
}

fn conflict(error: &str, message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
}

fn gone(error: &str, message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::GONE,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
}

fn internal_server_error(error: &str, message: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": error, "message": message })),
    )
}

fn internal_error(error: anyhow::Error) -> (StatusCode, Json<serde_json::Value>) {
    tracing::error!(error = %error, "Mobile API request failed");
    internal_server_error("internal_error", &error.to_string())
}
