//! Onboarding wizard — status and completion endpoints.
//!
//! Tracks which setup steps are done so the JS wizard can resume from the right place.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{get, post};
use axum::Router;
use serde::Serialize;

use super::super::server::AppState;

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/onboarding/status", get(onboarding_status))
        .route("/v1/onboarding/complete", post(onboarding_complete))
}

/// Full onboarding status — tells the JS wizard which steps to skip.
#[derive(Serialize)]
struct OnboardingStatus {
    completed: bool,
    /// Whether an admin user with password exists.
    has_account: bool,
    has_provider: bool,
    has_model: bool,
    /// Whether a non-default profile or SOUL.md exists.
    has_profile: bool,
    /// Number of configured gateways (channels in DB).
    gateways_count: i64,
    user_name: String,
    language: String,
    timezone: String,
    model: String,
}

/// GET /v1/onboarding/status
async fn onboarding_status(State(state): State<Arc<AppState>>) -> Json<OnboardingStatus> {
    let config = state.config.read().await;

    let has_provider = config
        .resolve_provider(&config.agent.model)
        .map(|(n, _)| n != "none")
        .unwrap_or(false);

    // Check if admin account exists
    let has_account = if let Some(db) = &state.db {
        db.count_users_with_password().await.unwrap_or(0) > 0
    } else {
        false
    };

    // Check if a profile with content exists (non-default or has profile_json)
    let has_profile = if let Some(db) = &state.db {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM profiles WHERE slug != 'default' OR profile_json != '{}'")
                .fetch_one(db.pool())
                .await
                .unwrap_or(0);
        count > 0
    } else {
        false
    };

    // Count gateways in DB
    let gateways_count = if let Some(db) = &state.db {
        crate::gateways::db::count_gateways(db.pool())
            .await
            .unwrap_or(0)
    } else {
        0
    };

    Json(OnboardingStatus {
        completed: config.ui.onboarding_completed,
        has_account,
        has_provider,
        has_model: !config.agent.model.is_empty(),
        has_profile,
        gateways_count,
        user_name: config.agent.user_name.clone(),
        language: config.ui.language.clone(),
        timezone: config.agent.timezone.clone(),
        model: config.agent.model.clone(),
    })
}

/// POST /v1/onboarding/complete — mark the wizard as done.
async fn onboarding_complete(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let mut config = state.config.read().await.clone();
    config.ui.onboarding_completed = true;
    state
        .save_config(config)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({"ok": true})))
}
