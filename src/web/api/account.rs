use std::sync::Arc;

use axum::extract::{Multipart, Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Json};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};

use super::super::auth::{hash_password, require_admin, verify_password, AuthUser};
use super::super::server::AppState;

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/account", get(get_account))
        .route(
            "/v1/account/identities",
            get(list_identities).post(add_identity),
        )
        .route(
            "/v1/account/identities/{channel}/{platform_id}",
            axum::routing::delete(remove_identity),
        )
        .route("/v1/account/users", get(list_users).post(create_user))
        .route(
            "/v1/account/users/{user_id}/enabled",
            axum::routing::put(set_user_enabled),
        )
        .route(
            "/v1/account/password",
            axum::routing::post(change_own_password),
        )
        .route("/v1/account/tokens", get(list_tokens).post(create_token))
        .route(
            "/v1/account/tokens/{token_id}",
            axum::routing::delete(delete_token).post(toggle_token),
        )
        .route("/v1/account/avatar", get(get_avatar).post(upload_avatar))
}

// ─── Avatar ─────────────────────────────────────────────────────

/// Inline SVG placeholder served when no avatar file is uploaded.
/// Keeps the `<img>` tag happy with a 200 OK response, avoiding
/// 404s in the browser console while still letting CSS fallback styling work.
const PLACEHOLDER_AVATAR_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#e0e0e0"/><circle cx="32" cy="26" r="10" fill="#9e9e9e"/><path d="M12 56 Q32 38 52 56 Z" fill="#9e9e9e"/></svg>"##;

/// Serve the user's avatar image, or an inline SVG placeholder if none uploaded.
async fn get_avatar(State(_state): State<Arc<AppState>>) -> axum::response::Response {
    let data_dir = crate::config::Config::data_dir();
    // Try common extensions
    for ext in &["png", "jpg", "jpeg", "webp"] {
        let path = data_dir.join(format!("avatar.{ext}"));
        if path.exists() {
            match tokio::fs::read(&path).await {
                Ok(bytes) => {
                    let ct = match *ext {
                        "png" => "image/png",
                        "jpg" | "jpeg" => "image/jpeg",
                        "webp" => "image/webp",
                        _ => "application/octet-stream",
                    };
                    return (
                        StatusCode::OK,
                        [
                            (header::CONTENT_TYPE, ct),
                            (header::CACHE_CONTROL, "max-age=3600"),
                        ],
                        bytes,
                    )
                        .into_response();
                }
                Err(_) => continue,
            }
        }
    }
    // Fallback: inline SVG placeholder, 200 OK — avoids console 404 noise.
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/svg+xml"),
            (header::CACHE_CONTROL, "max-age=3600"),
        ],
        PLACEHOLDER_AVATAR_SVG,
    )
        .into_response()
}

/// Upload a new avatar image (multipart form).
async fn upload_avatar(
    State(_state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> axum::response::Response {
    let data_dir = crate::config::Config::data_dir();

    while let Ok(Some(field)) = multipart.next_field().await {
        let content_type = field.content_type().unwrap_or("").to_string();
        let ext = match content_type.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            _ => continue,
        };

        match field.bytes().await {
            Ok(bytes) => {
                if bytes.len() > 2 * 1024 * 1024 {
                    return (StatusCode::BAD_REQUEST, "Image too large (max 2MB)").into_response();
                }
                // Remove old avatars
                for old_ext in &["png", "jpg", "jpeg", "webp"] {
                    let _ =
                        tokio::fs::remove_file(data_dir.join(format!("avatar.{old_ext}"))).await;
                }
                // Save new
                let path = data_dir.join(format!("avatar.{ext}"));
                if let Err(e) = tokio::fs::write(&path, &bytes).await {
                    tracing::error!("Failed to save avatar: {e}");
                    return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to save").into_response();
                }
                return (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response();
            }
            Err(_) => continue,
        }
    }

    (StatusCode::BAD_REQUEST, "No image field found").into_response()
}

#[derive(Debug, Serialize)]
struct AccountResponse {
    id: String,
    username: String,
    role: String,
    enabled: bool,
    must_change_password: bool,
    created_at: String,
}

#[derive(Debug, Serialize)]
struct UserAccountResponse {
    id: String,
    username: String,
    roles: Vec<String>,
    enabled: bool,
    must_change_password: bool,
    has_password: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct IdentityResponse {
    channel: String,
    platform_id: String,
    display_name: Option<String>,
    created_at: String,
}

/// Token listed in GET response — masked, no full token.
#[derive(Debug, Serialize)]
struct TokenResponse {
    /// Stable identifier (first 16 chars of the token) — used for delete/toggle.
    token_id: String,
    /// Masked display value, e.g. `wh_****…abcd`.
    display_token: String,
    name: String,
    enabled: bool,
    scope: String,
    last_used: Option<String>,
    created_at: String,
    expires_at: Option<String>,
}

/// Token returned on creation — includes the full token (shown once).
#[derive(Debug, Serialize)]
struct CreateTokenResponse {
    /// Full token value — copy it now, it won't be shown again.
    token: String,
    token_id: String,
    name: String,
    scope: String,
    expires_at: Option<String>,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct AddIdentityRequest {
    channel: String,
    platform_id: String,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateTokenRequest {
    name: String,
    /// Token scope: "admin" (default), "read", "write"
    scope: Option<String>,
    /// Optional expiry duration: "7d", "30d", "90d". Omit or null for no expiry.
    expires_in: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateUserRequest {
    username: String,
    password: String,
    role: Option<String>,
    must_change_password: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct SetUserEnabledRequest {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct ChangePasswordRequest {
    current_password: String,
    new_password: String,
}

fn user_response(row: crate::storage::UserRow) -> UserAccountResponse {
    let roles: Vec<String> = serde_json::from_str(&row.roles).unwrap_or_default();
    UserAccountResponse {
        id: row.id,
        username: row.username,
        roles,
        enabled: row.enabled != 0,
        must_change_password: row.must_change_password != 0,
        has_password: row
            .password_hash
            .as_ref()
            .map(|value| !value.is_empty())
            .unwrap_or(false),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// Get the owner account info (first user in database)
async fn get_account(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Option<AccountResponse>>, (StatusCode, Json<serde_json::Value>)> {
    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    let users = db.load_all_users().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    // Return the first user (owner)
    let owner = users.into_iter().next().map(|u| {
        let roles: Vec<String> = serde_json::from_str(&u.roles).unwrap_or_default();
        let role = roles.first().cloned().unwrap_or_else(|| "user".to_string());
        AccountResponse {
            id: u.id,
            username: u.username,
            role,
            enabled: u.enabled != 0,
            must_change_password: u.must_change_password != 0,
            created_at: u.created_at,
        }
    });

    Ok(Json(owner))
}

/// Change the current session user's local password.
async fn change_own_password(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    if req.new_password.len() < 8 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Password must be at least 8 characters"})),
        ));
    }
    if req.current_password == req.new_password {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "New password must be different"})),
        ));
    }

    let user = db
        .load_user(&auth.user_id)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "User not found"})),
            )
        })?;

    let current_hash = user.password_hash.as_deref().ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Account has no password set"})),
        )
    })?;
    if !verify_password(&req.current_password, current_hash) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Current password is invalid"})),
        ));
    }

    let new_hash = hash_password(&req.new_password).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;
    db.set_user_password_hash(&auth.user_id, &new_hash)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        })?;
    db.set_user_must_change_password(&auth.user_id, false)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        })?;

    Ok(Json(serde_json::json!({"ok": true})))
}

/// List local users. Admin only.
async fn list_users(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
) -> Result<Json<Vec<UserAccountResponse>>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;
    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    let users = db.load_all_users().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    Ok(Json(users.into_iter().map(user_response).collect()))
}

/// Create a local user with an initial password. Admin only.
async fn create_user(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Json(req): Json<CreateUserRequest>,
) -> Result<(StatusCode, Json<UserAccountResponse>), (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;
    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    let username = req.username.trim();
    if username.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Username is required"})),
        ));
    }
    if req.password.len() < 8 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Password must be at least 8 characters"})),
        ));
    }

    let role = match req.role.as_deref().unwrap_or("user") {
        "admin" => "admin",
        "user" => "user",
        "guest" => "guest",
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Invalid role"})),
            ))
        }
    };
    let user_id = uuid::Uuid::new_v4().to_string();
    let password_hash = hash_password(&req.password).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    db.create_user(&user_id, username, &[role])
        .await
        .map_err(|e| {
            let status = if e.to_string().contains("UNIQUE") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(serde_json::json!({"error": e.to_string()})))
        })?;
    db.set_user_password_hash(&user_id, &password_hash)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        })?;
    if req.must_change_password.unwrap_or(true) {
        db.set_user_must_change_password(&user_id, true)
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e.to_string()})),
                )
            })?;
    }

    let row = db
        .load_user(&user_id)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Created user not found"})),
            )
        })?;

    Ok((StatusCode::CREATED, Json(user_response(row))))
}

/// Enable or disable a local user. Admin only.
async fn set_user_enabled(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(user_id): Path<String>,
    Json(req): Json<SetUserEnabledRequest>,
) -> Result<Json<UserAccountResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;
    if user_id == auth.user_id && !req.enabled {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Cannot disable the current user"})),
        ));
    }
    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    let updated = db
        .set_user_enabled(&user_id, req.enabled)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        })?;
    if !updated {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "User not found"})),
        ));
    }
    let row = db
        .load_user(&user_id)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "User not found"})),
            )
        })?;

    Ok(Json(user_response(row)))
}

/// List all channel identities for the owner
async fn list_identities(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<IdentityResponse>>, (StatusCode, Json<serde_json::Value>)> {
    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    // Get owner user ID
    let users = db.load_all_users().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    let owner = match users.into_iter().next() {
        Some(u) => u,
        None => return Ok(Json(Vec::new())),
    };

    let identities = db.load_user_identities(&owner.id).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    let response: Vec<IdentityResponse> = identities
        .into_iter()
        .map(|i| IdentityResponse {
            channel: i.channel,
            platform_id: i.platform_id,
            display_name: i.display_name,
            created_at: i.created_at,
        })
        .collect();

    Ok(Json(response))
}

/// Add a new channel identity
async fn add_identity(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AddIdentityRequest>,
) -> Result<Json<IdentityResponse>, (StatusCode, Json<serde_json::Value>)> {
    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    // Get owner user ID
    let users = db.load_all_users().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    let owner = match users.into_iter().next() {
        Some(u) => u,
        None => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "No owner user found. Create one first."})),
            ))
        }
    };

    db.add_user_identity(
        &owner.id,
        &body.channel,
        &body.platform_id,
        body.display_name.as_deref(),
    )
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    Ok(Json(IdentityResponse {
        channel: body.channel,
        platform_id: body.platform_id,
        display_name: body.display_name,
        created_at: chrono::Utc::now().to_rfc3339(),
    }))
}

/// Remove a channel identity
async fn remove_identity(
    State(state): State<Arc<AppState>>,
    Path((channel, platform_id)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    // Get owner user ID
    let users = db.load_all_users().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    let owner = match users.into_iter().next() {
        Some(u) => u,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "No owner user found"})),
            ))
        }
    };

    let removed = db
        .remove_user_identity(&owner.id, &channel, &platform_id)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        })?;

    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Identity not found"})),
        ))
    }
}

/// List all webhook tokens for the owner
async fn list_tokens(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<TokenResponse>>, (StatusCode, Json<serde_json::Value>)> {
    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    // Get owner user ID
    let users = db.load_all_users().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    let owner = match users.into_iter().next() {
        Some(u) => u,
        None => return Ok(Json(Vec::new())),
    };

    let tokens = db.load_webhook_tokens(&owner.id).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    let response: Vec<TokenResponse> = tokens
        .into_iter()
        .map(|t| {
            let token_id = t.token.chars().take(16).collect::<String>();
            let last4 = if t.token.len() > 4 {
                &t.token[t.token.len() - 4..]
            } else {
                &t.token
            };
            TokenResponse {
                token_id,
                display_token: format!("wh_****…{last4}"),
                name: t.name,
                enabled: t.enabled,
                scope: t.scope,
                last_used: t.last_used,
                created_at: t.created_at,
                expires_at: t.expires_at,
            }
        })
        .collect();

    Ok(Json(response))
}

/// Create a new webhook token (admin-only).
async fn create_token(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Json(body): Json<CreateTokenRequest>,
) -> Result<Json<CreateTokenResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;

    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    // Get owner user ID
    let users = db.load_all_users().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    let owner = match users.into_iter().next() {
        Some(u) => u,
        None => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "No owner user found. Create one first."})),
            ))
        }
    };

    // Compute expiry timestamp from duration string
    let expires_at = match body.expires_in.as_deref() {
        Some("7d") => Some(chrono::Utc::now() + chrono::Duration::days(7)),
        Some("30d") => Some(chrono::Utc::now() + chrono::Duration::days(30)),
        Some("90d") => Some(chrono::Utc::now() + chrono::Duration::days(90)),
        _ => None,
    };
    let expires_at_str = expires_at.map(|dt| dt.to_rfc3339());

    // Generate token
    let token = format!("wh_{}", uuid::Uuid::new_v4().simple());
    let token_id = token.chars().take(16).collect::<String>();

    let scope = body.scope.as_deref().unwrap_or("admin");
    db.create_webhook_token(
        &token,
        &owner.id,
        &body.name,
        scope,
        expires_at_str.as_deref(),
    )
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    Ok(Json(CreateTokenResponse {
        token,
        token_id,
        name: body.name,
        scope: scope.to_string(),
        expires_at: expires_at_str,
        created_at: chrono::Utc::now().to_rfc3339(),
    }))
}

/// Delete a webhook token by prefix ID (admin-only).
async fn delete_token(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(token_id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;

    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    // Resolve the full token from the prefix
    let row = db.find_token_by_prefix(&token_id).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    let row = row.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Token not found"})),
        )
    })?;

    db.delete_webhook_token(&row.token).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    Ok(StatusCode::NO_CONTENT)
}

/// Toggle a webhook token enable/disable by prefix ID (admin-only).
async fn toggle_token(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(token_id): Path<String>,
) -> Result<Json<TokenResponse>, (StatusCode, Json<serde_json::Value>)> {
    require_admin(&auth)?;

    let db = match &state.db {
        Some(db) => db,
        None => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Database not available"})),
            ))
        }
    };

    // Resolve full token from prefix
    let row = db.find_token_by_prefix(&token_id).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
    })?;

    let row = row.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Token not found"})),
        )
    })?;

    let new_enabled = !row.enabled;
    db.toggle_webhook_token(&row.token, new_enabled)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        })?;

    let display_last4 = if row.token.len() > 4 {
        &row.token[row.token.len() - 4..]
    } else {
        &row.token
    };

    Ok(Json(TokenResponse {
        token_id,
        display_token: format!("wh_****…{display_last4}"),
        name: row.name,
        enabled: new_enabled,
        scope: row.scope,
        last_used: row.last_used,
        created_at: row.created_at,
        expires_at: row.expires_at,
    }))
}
