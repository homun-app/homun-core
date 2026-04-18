//! User-curated favorite models API.
//!
//! Manages `[favorites]` config — full provider-prefixed model IDs that the
//! user has marked as favorite. Surfaced in UI dropdowns at the top via the
//! ⭐ Favorites group, cross-provider.
//!
//! Storage: persisted via `save_config_section(SECTION_FAVORITES)` → DB
//! `settings` table (JSON section), with TOML backup.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Json;
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::config::SECTION_FAVORITES;

use super::super::server::AppState;

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/favorites/models", axum::routing::get(list_favorites))
        .route(
            "/v1/favorites/models/toggle",
            axum::routing::post(toggle_favorite),
        )
}

// ── Response/request types ──────────────────────────────────────────

#[derive(Serialize)]
struct FavoritesResponse {
    models: Vec<String>,
}

#[derive(Deserialize)]
struct ToggleRequest {
    /// Full provider-prefixed model id, e.g. `"ollama/qwen3.5:397b-cloud"`.
    model: String,
}

#[derive(Serialize)]
struct ToggleResponse {
    models: Vec<String>,
    /// `true` if the model was added, `false` if it was removed.
    added: bool,
}

// ── Handlers ────────────────────────────────────────────────────────

async fn list_favorites(State(state): State<Arc<AppState>>) -> Json<FavoritesResponse> {
    let config = state.config.read().await;
    Json(FavoritesResponse {
        models: config.favorites.models.clone(),
    })
}

async fn toggle_favorite(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ToggleRequest>,
) -> Result<Json<ToggleResponse>, (StatusCode, String)> {
    let trimmed = req.model.trim().to_string();
    if trimmed.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "model id is required".to_string()));
    }

    // Mutate in-memory config (Arc<RwLock<Config>> is shared with AgentLoop)
    let added = {
        let mut config = state.config.write().await;
        if let Some(pos) = config.favorites.models.iter().position(|m| m == &trimmed) {
            config.favorites.models.remove(pos);
            false
        } else {
            config.favorites.models.push(trimmed.clone());
            true
        }
    };

    // Persist to DB (primary) + TOML (backup)
    if let Err(e) = state.save_config_section(SECTION_FAVORITES).await {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to persist favorites: {e}"),
        ));
    }

    let models = state.config.read().await.favorites.models.clone();
    Ok(Json(ToggleResponse { models, added }))
}
