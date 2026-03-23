//! REST API for shared resources.
//!
//! Manage sharing of skills, MCP servers, tools, and namespaces with contacts.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};

use super::super::server::AppState;
use crate::sharing;
use crate::storage::Database;
use crate::web::auth::{require_write, AuthUser};

type ApiErr = (StatusCode, Json<Value>);

fn require_db(state: &AppState) -> Result<&Database, ApiErr> {
    state.db.as_ref().ok_or_else(|| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "Database not available"})))
    })
}

fn internal(e: anyhow::Error) -> ApiErr {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()})))
}

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/sharing/resources", get(list_resources).post(create_resource))
        .route("/v1/sharing/resources/{id}", get(get_resource_access).delete(delete_resource))
        .route("/v1/sharing/resources/{id}/access", post(grant_access))
        .route(
            "/v1/sharing/resources/{id}/access/{contact_id}",
            axum::routing::delete(revoke_access),
        )
        .route("/v1/sharing/contacts/{contact_id}", get(contact_access))
}

// ── Request types ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateResourceRequest {
    resource_type: String,
    resource_id: String,
    owner_profile_id: i64,
    description: Option<String>,
}

#[derive(Deserialize)]
struct GrantAccessRequest {
    contact_id: i64,
    permission: Option<String>,
    scope_json: Option<String>,
}

// ── Handlers ────────────────────────────────────────────────────────

/// List all shared resources.
async fn list_resources(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<sharing::SharedResource>>, ApiErr> {
    let db = require_db(&state)?;
    let list = sharing::db::list_all_resources(db.pool()).await.map_err(internal)?;
    Ok(Json(list))
}

/// Create a shared resource.
async fn create_resource(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Json(body): Json<CreateResourceRequest>,
) -> Result<(StatusCode, Json<Value>), ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;
    let id = sharing::db::create_resource(
        db.pool(),
        &body.resource_type,
        &body.resource_id,
        body.owner_profile_id,
        body.description.as_deref().unwrap_or(""),
    )
    .await
    .map_err(internal)?;
    Ok((StatusCode::CREATED, Json(json!({"ok": true, "id": id}))))
}

/// List access grants for a shared resource.
async fn get_resource_access(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<Vec<sharing::SharedResourceAccess>>, ApiErr> {
    let db = require_db(&state)?;
    let access = sharing::db::list_access_for_resource(db.pool(), id)
        .await
        .map_err(internal)?;
    Ok(Json(access))
}

/// Delete a shared resource (cascades to all access grants).
async fn delete_resource(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;
    sharing::db::delete_resource(db.pool(), id).await.map_err(internal)?;
    Ok(Json(json!({"ok": true})))
}

/// Grant a contact access to a shared resource.
async fn grant_access(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(resource_id): Path<i64>,
    Json(body): Json<GrantAccessRequest>,
) -> Result<Json<Value>, ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;
    sharing::db::grant_access(
        db.pool(),
        resource_id,
        body.contact_id,
        body.permission.as_deref().unwrap_or("read"),
        body.scope_json.as_deref().unwrap_or("{}"),
    )
    .await
    .map_err(internal)?;
    Ok(Json(json!({"ok": true})))
}

/// Revoke a contact's access to a shared resource.
async fn revoke_access(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path((resource_id, contact_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, ApiErr> {
    require_write(&auth)?;
    let db = require_db(&state)?;
    sharing::db::revoke_access(db.pool(), resource_id, contact_id)
        .await
        .map_err(internal)?;
    Ok(Json(json!({"ok": true})))
}

/// Get all shared resources accessible to a contact.
async fn contact_access(
    State(state): State<Arc<AppState>>,
    Path(contact_id): Path<i64>,
) -> Result<Json<sharing::ContactSharedAccess>, ApiErr> {
    let db = require_db(&state)?;
    let access = sharing::db::resolve_contact_access(db.pool(), contact_id)
        .await
        .map_err(internal)?;
    Ok(Json(access))
}
