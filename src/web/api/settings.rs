//! Settings section API — returns HTML fragments for the settings modal.
//!
//! `GET /v1/settings/section/{name}` returns the inner HTML of a settings
//! section, suitable for injection into the settings modal body.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Html,
    routing::get,
    Router,
};

use super::super::pages;
use super::super::server::AppState;

/// Register settings section routes.
pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/v1/settings/section/{name}", get(section_handler))
}

/// Returns HTML fragment for the requested settings section.
/// Auth is enforced by the middleware layer on all `/v1/` routes.
async fn section_handler(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<Html<String>, StatusCode> {
    let html = match name.as_str() {
        "account" => pages::section_account(&state).await,
        "setup" => pages::section_setup(&state).await,
        "appearance" => pages::section_appearance(&state).await,
        "channels" => pages::section_channels(&state).await,
        "browser" => pages::section_browser(&state).await,
        "vault" => pages::section_vault(&state).await,
        "api-keys" => pages::section_api_keys(&state).await,
        "approvals" => pages::section_approvals(&state).await,
        "file-access" => pages::section_file_access(&state).await,
        "shell" => pages::section_shell(&state).await,
        "sandbox" => pages::section_sandbox(&state).await,
        "maintenance" => pages::section_maintenance(&state).await,
        "logs" => pages::section_logs(&state).await,
        "usage" => pages::section_usage(&state).await,
        "health" => pages::section_health(&state).await,
        "history" => pages::section_history(&state).await,
        _ => return Err(StatusCode::NOT_FOUND),
    };

    Ok(Html(html))
}
