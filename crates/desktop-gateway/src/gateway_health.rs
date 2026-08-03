use axum::{Json, extract::State};
use serde::Serialize;

pub(crate) trait GatewayHealthState: Clone + Send + Sync + 'static {
    fn gateway_auth_required(&self) -> bool;
    fn recovered_stores(&self) -> Vec<String>;
}

#[derive(Debug, Serialize)]
pub(crate) struct HealthResponse {
    ok: bool,
    service: &'static str,
    local_first: bool,
    auth_required: bool,
    /// Names of stores reset at startup after failing quick_check (backups kept
    /// as *.corrupt-<epoch>.bak beside the store). Empty on a healthy boot.
    recovered_stores: Vec<String>,
    projection_worker_error: Option<String>,
}

pub(crate) async fn health<S>(State(state): State<S>) -> Json<HealthResponse>
where
    S: GatewayHealthState,
{
    Json(build_health_response(
        &state,
        crate::projection_worker::health_error(),
    ))
}

fn build_health_response<S>(state: &S, projection_worker_error: Option<String>) -> HealthResponse
where
    S: GatewayHealthState,
{
    HealthResponse {
        ok: projection_worker_error.is_none(),
        service: "local-first-desktop-gateway",
        local_first: true,
        auth_required: state.gateway_auth_required(),
        recovered_stores: state.recovered_stores(),
        projection_worker_error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct TestHealthState {
        auth_required: bool,
        recovered_stores: Vec<String>,
    }

    impl GatewayHealthState for TestHealthState {
        fn gateway_auth_required(&self) -> bool {
            self.auth_required
        }

        fn recovered_stores(&self) -> Vec<String> {
            self.recovered_stores.clone()
        }
    }

    #[test]
    fn health_response_reflects_auth_and_recovery_state() {
        let response = build_health_response(
            &TestHealthState {
                auth_required: true,
                recovered_stores: vec!["desktop-gateway".to_string()],
            },
            None,
        );

        assert!(response.ok);
        assert_eq!(response.service, "local-first-desktop-gateway");
        assert!(response.local_first);
        assert!(response.auth_required);
        assert_eq!(response.recovered_stores, vec!["desktop-gateway"]);
        assert_eq!(response.projection_worker_error, None);
    }

    #[test]
    fn health_response_marks_projection_worker_error_unhealthy() {
        let response = build_health_response(
            &TestHealthState {
                auth_required: false,
                recovered_stores: Vec::new(),
            },
            Some("projection stopped".to_string()),
        );

        assert!(!response.ok);
        assert!(!response.auth_required);
        assert_eq!(
            response.projection_worker_error,
            Some("projection stopped".to_string())
        );
    }
}
