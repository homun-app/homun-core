//! Prometheus `/metrics` endpoint.
//!
//! Two mount points exist at runtime — this module defines the protected
//! `/api/v1/metrics` route used by the Homun dashboard to render live metrics
//! tiles behind web authentication. The unauthenticated root-path `/metrics`
//! (registered conditionally in `web::server` when `[metrics] public = true`)
//! calls the same renderer but is mounted in the public router tree so the
//! auth middleware is bypassed.
//!
//! When `[metrics] enabled = false`, both endpoints return `404 Not Found`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;

use crate::web::server::AppState;

/// Prometheus exposition format media type.
///
/// Version 0.0.4 is the text format spec used by every current Prometheus
/// server, Grafana Agent, VictoriaMetrics, OpenMetrics-compatible collectors.
const PROMETHEUS_TEXT_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/v1/metrics", get(metrics_handler))
}

/// Shared handler used by both the protected and (optional) public route.
///
/// Updates dynamic gauges (uptime, and anything else that is cheap to compute
/// on scrape) before rendering, so the scraped snapshot is fresh.
pub(crate) async fn metrics_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let enabled = state.config.read().await.metrics.enabled;
    if !enabled {
        return (StatusCode::NOT_FOUND, "metrics disabled").into_response();
    }

    // Refresh gauges that are cheap to compute at scrape time.
    update_dynamic_gauges(&state).await;

    let body = crate::metrics::render();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, PROMETHEUS_TEXT_CONTENT_TYPE)],
        body,
    )
        .into_response()
}

/// Update gauges whose value is cheap to compute at scrape time.
///
/// Heavier queries (memory chunks total, vault entries total, rag docs total)
/// are pushed via `gauge_set` at mutation time from their owning modules —
/// the scrape path stays fast.
async fn update_dynamic_gauges(state: &Arc<AppState>) {
    // Uptime: elapsed seconds since the gateway AppState was created.
    let uptime = state.started_at.elapsed().as_secs_f64();
    crate::metrics::gauge_set("homun_uptime_seconds", &[], uptime);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_type_matches_prometheus_spec() {
        // Sanity check: the content type must be exactly what Prometheus expects.
        // Version 0.0.4 is the stable text format — do NOT upgrade to 0.0.5 (OpenMetrics)
        // without verifying scraper compat.
        assert!(PROMETHEUS_TEXT_CONTENT_TYPE.contains("version=0.0.4"));
        assert!(PROMETHEUS_TEXT_CONTENT_TYPE.contains("text/plain"));
    }

    #[test]
    fn renders_registered_counter_when_enabled() {
        // This test exercises the renderer directly (no HTTP layer) — the handler
        // itself is tested via integration tests that spin up a full AppState.
        let r = crate::metrics::MetricsRegistry::new();
        r.register_counter("homun_test_scrape_total", "Scrape test.");
        r.counter_inc("homun_test_scrape_total", &[("path", "/metrics")], 1);
        let out = r.render();
        assert!(out.contains("homun_test_scrape_total{path=\"/metrics\"} 1"));
        assert!(out.contains("# TYPE homun_test_scrape_total counter"));
    }
}
