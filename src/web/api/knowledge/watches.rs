//! CRUD API for knowledge watches (monitored folders).
//!
//! Endpoints for managing directories that are automatically watched
//! and ingested into the RAG knowledge base.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use crate::web::auth::{check_write, AuthUser};
use crate::web::server::AppState;

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/v1/knowledge/watches",
            get(list_watches).post(create_watch),
        )
        .route(
            "/v1/knowledge/watches/{id}",
            axum::routing::put(update_watch).delete(delete_watch),
        )
}

#[derive(Deserialize)]
struct CreateWatchRequest {
    path: String,
    #[serde(default = "default_true")]
    recursive: bool,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    profile_id: Option<i64>,
    #[serde(default = "default_namespace")]
    namespace: String,
    /// JSON array of contact IDs, e.g. [1, 5, 12].
    #[serde(default = "default_empty_array")]
    contact_ids: String,
}

#[derive(Deserialize)]
struct UpdateWatchRequest {
    path: String,
    #[serde(default = "default_true")]
    recursive: bool,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    profile_id: Option<i64>,
    #[serde(default = "default_namespace")]
    namespace: String,
    #[serde(default = "default_empty_array")]
    contact_ids: String,
}

fn default_true() -> bool {
    true
}
fn default_namespace() -> String {
    "_private".to_string()
}
fn default_empty_array() -> String {
    "[]".to_string()
}

/// GET /api/v1/knowledge/watches — list all watches with doc counts.
async fn list_watches(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let Some(ref db) = state.db else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "Database not available"})),
        )
            .into_response();
    };

    match db.list_knowledge_watches().await {
        Ok(watches) => {
            // Enrich each watch with doc_count
            let mut items = Vec::with_capacity(watches.len());
            for w in &watches {
                let doc_count = db
                    .count_sources_by_path_prefix(&w.path)
                    .await
                    .unwrap_or(0);
                items.push(serde_json::json!({
                    "id": w.id,
                    "path": w.path,
                    "recursive": w.is_recursive(),
                    "enabled": w.is_enabled(),
                    "profile_id": w.profile_id,
                    "namespace": w.namespace,
                    "contact_ids": w.contacts(),
                    "doc_count": doc_count,
                    "created_at": w.created_at,
                    "updated_at": w.updated_at,
                }));
            }
            Json(serde_json::json!({"watches": items})).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

/// POST /api/v1/knowledge/watches — create a new watch.
async fn create_watch(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Json(req): Json<CreateWatchRequest>,
) -> impl IntoResponse {
    if let Err(status) = check_write(&auth) {
        return status.into_response();
    }
    let Some(ref db) = state.db else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "Database not available"})),
        )
            .into_response();
    };

    // Expand tilde in path
    let expanded = expand_path(&req.path);

    // Validate: path should be a directory (or not exist yet — user may add it later)
    let p = std::path::Path::new(&expanded);
    if p.exists() && !p.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Path exists but is not a directory"})),
        )
            .into_response();
    }

    match db
        .insert_knowledge_watch(
            &expanded,
            req.recursive,
            req.profile_id,
            &req.namespace,
            &req.contact_ids,
        )
        .await
    {
        Ok(id) => {
            // Signal watcher to reload
            notify_watcher(&state).await;

            Json(serde_json::json!({"ok": true, "id": id})).into_response()
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("UNIQUE constraint") {
                (
                    StatusCode::CONFLICT,
                    Json(serde_json::json!({"error": "A watch for this path already exists"})),
                )
                    .into_response()
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": msg})),
                )
                    .into_response()
            }
        }
    }
}

/// PUT /api/v1/knowledge/watches/{id} — update a watch.
async fn update_watch(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateWatchRequest>,
) -> impl IntoResponse {
    if let Err(status) = check_write(&auth) {
        return status.into_response();
    }
    let Some(ref db) = state.db else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "Database not available"})),
        )
            .into_response();
    };

    let expanded = expand_path(&req.path);

    match db
        .update_knowledge_watch(
            id,
            &expanded,
            req.recursive,
            req.enabled,
            req.profile_id,
            &req.namespace,
            &req.contact_ids,
        )
        .await
    {
        Ok(true) => {
            notify_watcher(&state).await;
            Json(serde_json::json!({"ok": true})).into_response()
        }
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Watch not found"})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

/// DELETE /api/v1/knowledge/watches/{id} — delete a watch.
async fn delete_watch(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    if let Err(status) = check_write(&auth) {
        return status.into_response();
    }
    let Some(ref db) = state.db else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "Database not available"})),
        )
            .into_response();
    };

    match db.delete_knowledge_watch(id).await {
        Ok(true) => {
            notify_watcher(&state).await;
            Json(serde_json::json!({"ok": true})).into_response()
        }
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Watch not found"})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

/// Expand `~/` prefix to the user's home directory.
fn expand_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

/// Signal the RAG watcher to reload its watch list from DB.
async fn notify_watcher(state: &AppState) {
    #[cfg(feature = "embeddings")]
    if let Some(ref tx) = state.watch_update_tx {
        let _ = tx.send(crate::rag::watcher::WatchUpdate::Reload).await;
    }
}
