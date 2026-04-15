//! Update checker API endpoint (UPD-1).
//!
//! Single read-only endpoint that returns the cached `UpdateInfo` from
//! `AppState.update_status`. The poller that populates this cache lives
//! in `main.rs` `Commands::Gateway` — it runs once per day and writes
//! the result through the same `Arc<RwLock>`.
//!
//! The endpoint is auth-gated (it lives under the protected `/api/v1`
//! tree in the router merge) so external scrapers cannot enumerate
//! Homun installations or fingerprint the binary version.

use std::sync::Arc;

use axum::extract::State;
use axum::response::Json;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::updates::UpdateInfo;
use crate::web::server::AppState;

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/v1/updates/status", get(get_update_status))
}

/// Response body shape — mirrors UpdateInfo plus the `check_enabled` flag
/// so the UI can distinguish "checks disabled" from "no update yet".
#[derive(Serialize)]
struct UpdateStatusResponse {
    /// `true` if `[updates] check_enabled = true`. When false, all other
    /// fields are `None` and the UI hides the chip without flashing
    /// "no update available".
    check_enabled: bool,
    /// `Some(...)` when the background poller has written at least one
    /// successful result. `None` immediately after boot (poll runs after
    /// INITIAL_DELAY seconds) or if every poll has failed so far.
    #[serde(skip_serializing_if = "Option::is_none")]
    info: Option<UpdateInfo>,
}

async fn get_update_status(State(state): State<Arc<AppState>>) -> Json<UpdateStatusResponse> {
    let check_enabled = state.config.read().await.updates.check_enabled;
    let info = if check_enabled {
        state.update_status.read().await.clone()
    } else {
        None
    };

    Json(UpdateStatusResponse {
        check_enabled,
        info,
    })
}
