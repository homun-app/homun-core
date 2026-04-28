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

use crate::storage::Database;
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
async fn list_watches(
    State(state): State<Arc<AppState>>,
    axum::Extension(auth): axum::Extension<AuthUser>,
) -> impl IntoResponse {
    let Some(ref db) = state.db else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "Database not available"})),
        )
            .into_response();
    };

    match list_watches_for_user(db, &auth.user_id).await {
        Ok(watches) => {
            // Enrich each watch with doc_count
            let mut items = Vec::with_capacity(watches.len());
            for w in &watches {
                let doc_count = db.count_sources_by_path_prefix(&w.path).await.unwrap_or(0);
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

    let profile_id = match resolve_watch_profile_id(db, req.profile_id, &auth).await {
        Ok(id) => id,
        Err(status) => return status.into_response(),
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
            Some(profile_id),
            &req.namespace,
            &req.contact_ids,
        )
        .await
    {
        Ok(id) => {
            // Sync contact perimeters: add namespace to each contact's allowed list
            sync_perimeters_add(db, &req.contact_ids, &req.namespace).await;
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
    let profile_id = match resolve_watch_profile_id(db, req.profile_id, &auth).await {
        Ok(id) => id,
        Err(status) => return status.into_response(),
    };

    // Load old watch for perimeter diff
    let old_watch = db.load_knowledge_watch(id).await.ok().flatten();
    if !watch_belongs_to_user(db, id, &auth.user_id).await {
        return StatusCode::NOT_FOUND.into_response();
    }

    match db
        .update_knowledge_watch(
            id,
            &expanded,
            req.recursive,
            req.enabled,
            Some(profile_id),
            &req.namespace,
            &req.contact_ids,
        )
        .await
    {
        Ok(true) => {
            // Sync perimeters: diff old vs new contacts
            if let Some(ref old) = old_watch {
                sync_perimeters_diff(db, old, &req.contact_ids, &req.namespace).await;
            } else {
                sync_perimeters_add(db, &req.contact_ids, &req.namespace).await;
            }
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

    // Load watch before deleting (for perimeter cleanup)
    let old_watch = db.load_knowledge_watch(id).await.ok().flatten();
    if !watch_belongs_to_user(db, id, &auth.user_id).await {
        return StatusCode::NOT_FOUND.into_response();
    }

    match db.delete_knowledge_watch(id).await {
        Ok(true) => {
            // Remove namespace from all associated contacts' perimeters
            if let Some(ref old) = old_watch {
                sync_perimeters_remove(db, old).await;
            }
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

async fn resolve_watch_profile_id(
    db: &Database,
    requested_profile_id: Option<i64>,
    auth: &AuthUser,
) -> Result<i64, StatusCode> {
    if let Some(profile_id) = requested_profile_id {
        let allowed =
            crate::profiles::db::load_profile_by_id_for_user(db.pool(), profile_id, &auth.user_id)
                .await
                .ok()
                .flatten()
                .is_some();
        if allowed {
            return Ok(profile_id);
        }
        return Err(StatusCode::FORBIDDEN);
    }

    crate::profiles::db::ensure_initial_profile_for_user(db.pool(), &auth.user_id, &auth.username)
        .await
        .map(|p| p.id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn watch_belongs_to_user(db: &Database, watch_id: i64, user_id: &str) -> bool {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM knowledge_watches kw
         JOIN profiles p ON p.id = kw.profile_id
         WHERE kw.id = ? AND p.user_id = ?",
    )
    .bind(watch_id)
    .bind(user_id)
    .fetch_one(db.pool())
    .await
    .unwrap_or(0);
    count > 0
}

async fn list_watches_for_user(
    db: &Database,
    user_id: &str,
) -> anyhow::Result<Vec<crate::rag::db::KnowledgeWatch>> {
    let rows = sqlx::query_as::<_, crate::rag::db::KnowledgeWatch>(
        "SELECT kw.id, kw.path, kw.recursive, kw.enabled, kw.profile_id, kw.namespace,
                kw.contact_ids, kw.created_at, kw.updated_at
         FROM knowledge_watches kw
         JOIN profiles p ON p.id = kw.profile_id
         WHERE p.user_id = ?
         ORDER BY kw.created_at DESC",
    )
    .bind(user_id)
    .fetch_all(db.pool())
    .await?;
    Ok(rows)
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

// ── Perimeter sync helpers ───────────────────────────────────────

use crate::contacts::perimeter;

/// Parse contact_ids JSON string into a Vec<i64>.
fn parse_contact_ids(json_str: &str) -> Vec<i64> {
    serde_json::from_str(json_str).unwrap_or_default()
}

/// Add namespace to perimeters of all contacts in the JSON array.
async fn sync_perimeters_add(db: &Database, contact_ids_json: &str, namespace: &str) {
    let ids = parse_contact_ids(contact_ids_json);
    for cid in ids {
        if let Err(e) = perimeter::add_namespace_to_perimeter(db.pool(), cid, namespace).await {
            tracing::warn!(contact_id = cid, error = %e, "Failed to add namespace to perimeter");
        }
    }
}

/// Diff old vs new contacts: add namespace for new contacts, remove for removed ones.
async fn sync_perimeters_diff(
    db: &Database,
    old_watch: &crate::rag::db::KnowledgeWatch,
    new_contact_ids_json: &str,
    new_namespace: &str,
) {
    let old_ids = old_watch.contacts();
    let new_ids: Vec<i64> = parse_contact_ids(new_contact_ids_json);

    // Contacts removed from this watch: remove old namespace from their perimeters
    for cid in &old_ids {
        if !new_ids.contains(cid) {
            if let Err(e) =
                perimeter::remove_namespace_from_perimeter(db.pool(), *cid, &old_watch.namespace)
                    .await
            {
                tracing::warn!(contact_id = cid, error = %e, "Failed to remove namespace from perimeter");
            }
        }
    }

    // Contacts added or retained: ensure new namespace is present
    for cid in &new_ids {
        if let Err(e) = perimeter::add_namespace_to_perimeter(db.pool(), *cid, new_namespace).await
        {
            tracing::warn!(contact_id = cid, error = %e, "Failed to add namespace to perimeter");
        }
    }
}

/// Remove namespace from all contacts associated with a deleted watch.
async fn sync_perimeters_remove(db: &Database, old_watch: &crate::rag::db::KnowledgeWatch) {
    for cid in old_watch.contacts() {
        if let Err(e) =
            perimeter::remove_namespace_from_perimeter(db.pool(), cid, &old_watch.namespace).await
        {
            tracing::warn!(contact_id = cid, error = %e, "Failed to remove namespace from perimeter");
        }
    }
}
