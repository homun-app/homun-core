//! Request trace API — list and retrieve execution traces.
//!
//! Traces are JSON files written to `~/.homun/traces/` by the agent loop.

use std::sync::Arc;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use super::super::server::AppState;
use crate::agent::request_trace::{list_traces, read_trace, RequestTrace, TraceStatus};
use crate::utils::text::truncate_str;

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/traces", get(list_handler))
        .route("/v1/traces/{id}", get(detail_handler))
}

/// Lightweight summary for the list view.
#[derive(Serialize)]
struct TraceListItem {
    id: String,
    started_at: String,
    channel: String,
    /// First 80 chars of the request.
    request_summary: String,
    /// `intent_type` from the cognition phase, if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    intent_type: Option<String>,
    /// LLM model used for cognition.
    #[serde(skip_serializing_if = "Option::is_none")]
    cognition_model: Option<String>,
    /// LLM model used for execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_model: Option<String>,
    /// True when cognition failed and fallback was used.
    #[serde(skip_serializing_if = "Option::is_none")]
    is_fallback: Option<bool>,
    total_iterations: u32,
    total_tokens: u32,
    duration_ms: u64,
    status: String,
    steps: usize,
}

fn status_str(status: &TraceStatus) -> &'static str {
    match status {
        TraceStatus::Completed => "completed",
        TraceStatus::Cancelled => "cancelled",
    }
}

/// GET /api/v1/traces
async fn list_handler() -> Json<Vec<TraceListItem>> {
    let files = list_traces();
    let items = files
        .into_iter()
        .filter_map(|(_, path)| {
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "Failed to read trace file");
                    return None;
                }
            };
            let trace: RequestTrace = match serde_json::from_str(&content) {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "Failed to parse trace JSON");
                    return None;
                }
            };
            let is_fallback = trace.cognition.as_ref().map(|c| c.is_fallback);
            Some(TraceListItem {
                id: trace.id.clone(),
                started_at: trace.started_at.clone(),
                channel: trace.channel.clone(),
                request_summary: truncate_str(&trace.request, 80, "…"),
                intent_type: trace
                    .cognition
                    .as_ref()
                    .and_then(|c| c.intent_type.clone()),
                cognition_model: trace.cognition_model.clone(),
                execution_model: trace.execution_model.clone(),
                is_fallback: is_fallback.filter(|&f| f),
                total_iterations: trace.total_iterations,
                total_tokens: trace.total_tokens,
                duration_ms: trace.duration_ms,
                status: status_str(&trace.status).to_string(),
                steps: trace.steps.len(),
            })
        })
        .collect();
    Json(items)
}

/// GET /api/v1/traces/:id
async fn detail_handler(Path(id): Path<String>) -> Response {
    match read_trace(&id) {
        Some(trace) => Json(trace).into_response(),
        None => (StatusCode::NOT_FOUND, r#"{"error":"trace not found"}"#).into_response(),
    }
}
