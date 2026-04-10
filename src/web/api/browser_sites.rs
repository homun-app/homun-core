//! REST API for browser allowed sites management.
//!
//! CRUD endpoints for the `browser_allowed_sites` table.
//! Also exposes site memory read/delete for the Web UI.

use std::sync::Arc;

use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{delete, get, post};
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::web::server::AppState;

#[derive(Deserialize)]
struct UpsertSiteRequest {
    domain: String,
    mode: String,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Serialize)]
struct SiteActionResponse {
    success: bool,
    message: String,
}

#[derive(Serialize)]
struct SiteMemoryResponse {
    domain: String,
    exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

/// GET /v1/browser/allowed-sites — list all allowed sites.
async fn list_sites(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::storage::BrowserAllowedSiteRow>>, StatusCode> {
    let db = state.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let sites = db
        .list_browser_allowed_sites()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(sites))
}

/// POST /v1/browser/allowed-sites — add or update an allowed site.
async fn upsert_site(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpsertSiteRequest>,
) -> Result<Json<SiteActionResponse>, StatusCode> {
    let db = state.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    // Validate mode
    if !["headless", "visible", "auto"].contains(&req.mode.as_str()) {
        return Ok(Json(SiteActionResponse {
            success: false,
            message: format!(
                "Invalid mode '{}'. Must be headless, visible, or auto.",
                req.mode
            ),
        }));
    }

    // Normalize domain (strip scheme, www, trailing slashes)
    let domain = normalize_domain(&req.domain);
    if domain.is_empty() {
        return Ok(Json(SiteActionResponse {
            success: false,
            message: "Domain cannot be empty.".to_string(),
        }));
    }

    db.upsert_browser_allowed_site(&domain, &req.mode, "user", req.notes.as_deref())
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(SiteActionResponse {
        success: true,
        message: format!("Site '{domain}' saved with mode '{}'.", req.mode),
    }))
}

/// DELETE /v1/browser/allowed-sites/{domain} — remove an allowed site.
async fn delete_site(
    State(state): State<Arc<AppState>>,
    AxumPath(domain): AxumPath<String>,
) -> Result<Json<SiteActionResponse>, StatusCode> {
    let db = state.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let deleted = db
        .delete_browser_allowed_site(&domain)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if deleted {
        Ok(Json(SiteActionResponse {
            success: true,
            message: format!("Site '{domain}' removed."),
        }))
    } else {
        Ok(Json(SiteActionResponse {
            success: false,
            message: format!("Site '{domain}' not found."),
        }))
    }
}

/// GET /v1/browser/site-memory/{domain} — read site memory file content.
async fn get_site_memory(
    State(_state): State<Arc<AppState>>,
    AxumPath(domain): AxumPath<String>,
) -> Json<SiteMemoryResponse> {
    let data_dir = crate::config::Config::data_dir();
    let brain_dir = data_dir.join("brain");

    let memory = crate::browser::site_memory::load_site_memory(&brain_dir, None, &domain).await;

    match memory {
        Some(mem) => {
            let ctx = crate::browser::site_memory::format_memory_for_context(&mem);
            Json(SiteMemoryResponse {
                domain,
                exists: true,
                content: Some(ctx),
            })
        }
        None => Json(SiteMemoryResponse {
            domain,
            exists: false,
            content: None,
        }),
    }
}

/// DELETE /v1/browser/site-memory/{domain} — delete site memory (force re-learn).
async fn delete_site_memory(
    State(_state): State<Arc<AppState>>,
    AxumPath(domain): AxumPath<String>,
) -> Json<SiteActionResponse> {
    let data_dir = crate::config::Config::data_dir();
    let brain_dir = data_dir.join("brain");
    let path = brain_dir.join("sites").join(format!("{domain}.md"));

    if path.exists() {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Json(SiteActionResponse {
                success: true,
                message: format!(
                    "Site memory for '{domain}' deleted. Will re-learn on next visit."
                ),
            }),
            Err(e) => Json(SiteActionResponse {
                success: false,
                message: format!("Failed to delete site memory: {e}"),
            }),
        }
    } else {
        Json(SiteActionResponse {
            success: false,
            message: format!("No site memory found for '{domain}'."),
        })
    }
}

/// Normalize a domain string: strip scheme, www., trailing slashes.
fn normalize_domain(input: &str) -> String {
    let s = input
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.")
        .trim_end_matches('/');
    // Take only the host part (before any path)
    s.split('/').next().unwrap_or("").to_lowercase()
}

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/v1/browser/allowed-sites",
            get(list_sites).post(upsert_site),
        )
        .route("/v1/browser/allowed-sites/{domain}", delete(delete_site))
        .route(
            "/v1/browser/site-memory/{domain}",
            get(get_site_memory).delete(delete_site_memory),
        )
}
