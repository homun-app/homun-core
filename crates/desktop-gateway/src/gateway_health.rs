use axum::{Json, extract::State};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use time::OffsetDateTime;

// ── Overall health status ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HealthStatus {
    Ok,
    Degraded,
    Unhealthy,
}

// ── Sub-system health structs ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProjectionWorkerHealth {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_drain_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct ModelProviderHealth {
    pub(crate) reachable: bool,
    pub(crate) last_successful_inference: Option<String>,
    pub(crate) provider_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub(crate) struct MemoryStoreHealth {
    pub(crate) pool_healthy: bool,
    pub(crate) schema_version: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct SidecarHealth {
    pub(crate) browser_automation: SidecarStatus,
    pub(crate) contained_computer: SidecarStatus,
}

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct SidecarStatus {
    pub(crate) running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pid: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct LeaseHealth {
    pub(crate) active_count: usize,
    pub(crate) stale_count: usize,
}

// ── Process-wide health trackers ────────────────────────────────────────────
//
// These globals are updated by background paths (model client, task executor,
// projection worker) and read by the lock-free health handler. The health
// handler NEVER takes a store Mutex — it reads these cached values instead,
// preserving the liveness invariant pinned by `health_stays_live_while_a_store_lock_is_held`.

#[derive(Debug, Clone, Default)]
struct CachedLeaseStats {
    active_count: usize,
    stale_count: usize,
}

static LAST_SUCCESSFUL_INFERENCE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static LEASE_STATS: OnceLock<Mutex<CachedLeaseStats>> = OnceLock::new();
static LAST_PROJECTION_DRAIN: OnceLock<Mutex<Option<String>>> = OnceLock::new();

/// Called by the model client after a successful inference response. Updates
/// the process-wide timestamp so the health handler can report it without
/// touching the usage store.
pub(crate) fn record_successful_inference() {
    let cell = LAST_SUCCESSFUL_INFERENCE.get_or_init(|| Mutex::new(None));
    *cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(iso_now());
}

/// Called by the task executor after lease acquisition / stale-lease recovery
/// to publish the current active/stale counts. The health handler reads this
/// cached snapshot instead of locking the task_store, keeping the liveness
/// probe decoupled from store contention.
pub(crate) fn set_lease_stats(active: usize, stale: usize) {
    let cell = LEASE_STATS.get_or_init(|| Mutex::new(CachedLeaseStats::default()));
    let mut guard = cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.active_count = active;
    guard.stale_count = stale;
}

/// Called by the projection worker after each drain cycle (startup or
/// background loop) so the health handler can report `last_drain_at`.
pub(crate) fn record_projection_drain() {
    let cell = LAST_PROJECTION_DRAIN.get_or_init(|| Mutex::new(None));
    *cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(iso_now());
}

/// Read the last successful inference timestamp (process-wide cache).
pub(crate) fn last_successful_inference() -> Option<String> {
    LAST_SUCCESSFUL_INFERENCE
        .get()
        .and_then(|cell| cell.lock().unwrap_or_else(|p| p.into_inner()).clone())
}

/// Read the cached lease stats as a `LeaseHealth` snapshot.
pub(crate) fn lease_health_snapshot() -> LeaseHealth {
    LEASE_STATS
        .get()
        .map(|cell| {
            let guard = cell.lock().unwrap_or_else(|p| p.into_inner());
            LeaseHealth {
                active_count: guard.active_count,
                stale_count: guard.stale_count,
            }
        })
        .unwrap_or_default()
}

fn last_projection_drain() -> Option<String> {
    LAST_PROJECTION_DRAIN
        .get()
        .and_then(|cell| cell.lock().unwrap_or_else(|p| p.into_inner()).clone())
}

fn iso_now() -> String {
    let now = OffsetDateTime::now_utc();
    let month: u8 = match now.month() {
        time::Month::January => 1,
        time::Month::February => 2,
        time::Month::March => 3,
        time::Month::April => 4,
        time::Month::May => 5,
        time::Month::June => 6,
        time::Month::July => 7,
        time::Month::August => 8,
        time::Month::September => 9,
        time::Month::October => 10,
        time::Month::November => 11,
        time::Month::December => 12,
    };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        now.year(),
        month,
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

// ── Trait ───────────────────────────────────────────────────────────────────

pub(crate) trait GatewayHealthState: Clone + Send + Sync + 'static {
    fn gateway_auth_required(&self) -> bool;
    fn recovered_stores(&self) -> Vec<String>;

    /// Model provider reachability and last successful inference.
    /// Default: unreachable / unknown (subclasses override with real data).
    fn model_provider_health(&self) -> ModelProviderHealth {
        ModelProviderHealth::default()
    }

    /// Memory store pool health and schema version.
    /// Default: pool unhealthy / schema 0 (subclasses override).
    fn memory_store_health(&self) -> MemoryStoreHealth {
        MemoryStoreHealth::default()
    }

    /// Sidecar process status (browser automation, contained computer).
    /// Default: nothing running (subclasses override).
    fn sidecar_health(&self) -> SidecarHealth {
        SidecarHealth::default()
    }

    /// Active and stale lease counts.
    /// Default: zeros (subclasses override or the global cache is used).
    fn lease_health(&self) -> LeaseHealth {
        LeaseHealth::default()
    }
}

// ── Response ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub(crate) struct HealthResponse {
    // ── Existing fields (backward compatible) ──
    ok: bool,
    service: &'static str,
    local_first: bool,
    auth_required: bool,
    /// Names of stores reset at startup after failing quick_check (backups kept
    /// as *.corrupt-<epoch>.bak beside the store). Empty on a healthy boot.
    recovered_stores: Vec<String>,
    projection_worker_error: Option<String>,
    // ── New comprehensive fields ──
    status: HealthStatus,
    projection_worker: ProjectionWorkerHealth,
    model_provider: ModelProviderHealth,
    memory_store: MemoryStoreHealth,
    sidecars: SidecarHealth,
    leases: LeaseHealth,
}

// ── Handler ─────────────────────────────────────────────────────────────────

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
    let model_provider = state.model_provider_health();
    let memory_store = state.memory_store_health();
    let sidecars = state.sidecar_health();
    let leases = state.lease_health();

    let projection_worker = ProjectionWorkerHealth {
        status: if projection_worker_error.is_some() {
            "error"
        } else {
            "ok"
        },
        last_drain_at: last_projection_drain(),
    };

    let status = compute_health_status(
        projection_worker_error.is_some(),
        &model_provider,
        &memory_store,
    );

    HealthResponse {
        ok: projection_worker_error.is_none(),
        service: "local-first-desktop-gateway",
        local_first: true,
        auth_required: state.gateway_auth_required(),
        recovered_stores: state.recovered_stores(),
        projection_worker_error,
        status,
        projection_worker,
        model_provider,
        memory_store,
        sidecars,
        leases,
    }
}

/// Overall status logic (per task spec):
/// - `Ok` if all subsystems healthy
/// - `Degraded` if model unreachable OR memory pool degraded (but not both)
/// - `Unhealthy` if projection worker down OR multiple critical failures
fn compute_health_status(
    projection_worker_down: bool,
    model: &ModelProviderHealth,
    memory: &MemoryStoreHealth,
) -> HealthStatus {
    if projection_worker_down {
        return HealthStatus::Unhealthy;
    }
    let model_down = !model.reachable;
    let memory_down = !memory.pool_healthy;
    if model_down && memory_down {
        return HealthStatus::Unhealthy;
    }
    if model_down || memory_down {
        return HealthStatus::Degraded;
    }
    HealthStatus::Ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct TestHealthState {
        auth_required: bool,
        recovered_stores: Vec<String>,
        model_provider: ModelProviderHealth,
        memory_store: MemoryStoreHealth,
        sidecars: SidecarHealth,
        leases: LeaseHealth,
    }

    impl TestHealthState {
        /// All subsystems healthy — status should be `Ok`.
        fn healthy() -> Self {
            Self {
                auth_required: true,
                recovered_stores: vec!["desktop-gateway".to_string()],
                model_provider: ModelProviderHealth {
                    reachable: true,
                    last_successful_inference: None,
                    provider_name: Some("test-provider".to_string()),
                },
                memory_store: MemoryStoreHealth {
                    pool_healthy: true,
                    schema_version: 8,
                },
                sidecars: SidecarHealth::default(),
                leases: LeaseHealth {
                    active_count: 2,
                    stale_count: 0,
                },
            }
        }
    }

    impl GatewayHealthState for TestHealthState {
        fn gateway_auth_required(&self) -> bool {
            self.auth_required
        }

        fn recovered_stores(&self) -> Vec<String> {
            self.recovered_stores.clone()
        }

        fn model_provider_health(&self) -> ModelProviderHealth {
            self.model_provider.clone()
        }

        fn memory_store_health(&self) -> MemoryStoreHealth {
            self.memory_store.clone()
        }

        fn sidecar_health(&self) -> SidecarHealth {
            self.sidecars.clone()
        }

        fn lease_health(&self) -> LeaseHealth {
            self.leases.clone()
        }
    }

    // ── Existing tests (updated for new fields) ──

    #[test]
    fn health_response_reflects_auth_and_recovery_state() {
        let response = build_health_response(&TestHealthState::healthy(), None);

        assert!(response.ok);
        assert_eq!(response.service, "local-first-desktop-gateway");
        assert!(response.local_first);
        assert!(response.auth_required);
        assert_eq!(response.recovered_stores, vec!["desktop-gateway"]);
        assert_eq!(response.projection_worker_error, None);
        // New fields
        assert_eq!(response.status, HealthStatus::Ok);
        assert_eq!(response.projection_worker.status, "ok");
        assert!(response.model_provider.reachable);
        assert!(response.memory_store.pool_healthy);
        assert_eq!(response.memory_store.schema_version, 8);
        assert_eq!(response.leases.active_count, 2);
        assert_eq!(response.leases.stale_count, 0);
    }

    #[test]
    fn health_response_marks_projection_worker_error_unhealthy() {
        let response = build_health_response(
            &TestHealthState::healthy(),
            Some("projection stopped".to_string()),
        );

        assert!(!response.ok);
        assert_eq!(response.status, HealthStatus::Unhealthy);
        assert_eq!(
            response.projection_worker_error,
            Some("projection stopped".to_string())
        );
        assert_eq!(response.projection_worker.status, "error");
    }

    // ── Status logic tests ──

    #[test]
    fn status_ok_when_all_subsystems_healthy() {
        let response = build_health_response(&TestHealthState::healthy(), None);
        assert_eq!(response.status, HealthStatus::Ok);
    }

    #[test]
    fn status_degraded_when_model_unreachable() {
        let mut state = TestHealthState::healthy();
        state.model_provider.reachable = false;
        let response = build_health_response(&state, None);
        assert_eq!(response.status, HealthStatus::Degraded);
    }

    #[test]
    fn status_degraded_when_memory_pool_degraded() {
        let mut state = TestHealthState::healthy();
        state.memory_store.pool_healthy = false;
        let response = build_health_response(&state, None);
        assert_eq!(response.status, HealthStatus::Degraded);
    }

    #[test]
    fn status_unhealthy_when_projection_worker_down() {
        let response = build_health_response(
            &TestHealthState::healthy(),
            Some("worker crashed".to_string()),
        );
        assert_eq!(response.status, HealthStatus::Unhealthy);
    }

    #[test]
    fn status_unhealthy_when_model_and_memory_both_down() {
        let mut state = TestHealthState::healthy();
        state.model_provider.reachable = false;
        state.memory_store.pool_healthy = false;
        let response = build_health_response(&state, None);
        assert_eq!(response.status, HealthStatus::Unhealthy);
    }

    #[test]
    fn status_degraded_when_model_down_but_memory_healthy() {
        let mut state = TestHealthState::healthy();
        state.model_provider.reachable = false;
        let response = build_health_response(&state, None);
        assert_eq!(response.status, HealthStatus::Degraded);
        // ok is still true (service alive, just degraded)
        assert!(response.ok);
    }

    // ── Response field presence tests ──

    #[test]
    fn response_includes_all_expected_fields() {
        let response = build_health_response(&TestHealthState::healthy(), None);
        let json = serde_json::to_value(&response).expect("serialize");

        // Existing fields
        assert!(json["ok"].is_boolean());
        assert_eq!(json["service"], "local-first-desktop-gateway");
        assert!(json["local_first"].is_boolean());
        assert!(json["auth_required"].is_boolean());
        assert!(json["recovered_stores"].is_array());
        assert!(json["projection_worker_error"].is_null());

        // New fields
        assert_eq!(json["status"], "ok");
        assert_eq!(json["projection_worker"]["status"], "ok");
        assert!(json["model_provider"]["reachable"].is_boolean());
        assert!(json["model_provider"]["provider_name"].is_string());
        assert!(json["memory_store"]["pool_healthy"].is_boolean());
        assert_eq!(json["memory_store"]["schema_version"], 8);
        assert!(json["sidecars"]["browser_automation"]["running"].is_boolean());
        assert!(json["sidecars"]["contained_computer"]["running"].is_boolean());
        assert_eq!(json["leases"]["active_count"], 2);
        assert_eq!(json["leases"]["stale_count"], 0);
    }

    #[test]
    fn response_includes_projection_worker_error_in_nested_object() {
        let response = build_health_response(
            &TestHealthState::healthy(),
            Some("drain failed".to_string()),
        );
        let json = serde_json::to_value(&response).expect("serialize");

        assert_eq!(json["projection_worker_error"], "drain failed");
        assert_eq!(json["projection_worker"]["status"], "error");
    }

    #[test]
    fn response_serializes_status_as_snake_case() {
        let mut state = TestHealthState::healthy();
        state.model_provider.reachable = false;
        let response = build_health_response(&state, None);
        let json = serde_json::to_value(&response).expect("serialize");
        assert_eq!(json["status"], "degraded");
    }

    // ── Global tracker tests ──

    #[test]
    fn record_successful_inference_updates_global() {
        // Reset and record
        let cell = LAST_SUCCESSFUL_INFERENCE.get_or_init(|| Mutex::new(None));
        *cell.lock().unwrap() = None;

        record_successful_inference();

        let ts = last_successful_inference();
        assert!(ts.is_some(), "timestamp should be set after recording");
        // Verify it looks like an ISO timestamp
        let ts = ts.unwrap();
        assert!(ts.ends_with('Z'), "timestamp should end with Z");
        assert!(ts.contains('T'), "timestamp should contain T separator");
    }

    #[test]
    fn set_lease_stats_updates_global() {
        set_lease_stats(5, 2);

        let snapshot = lease_health_snapshot();
        assert_eq!(snapshot.active_count, 5);
        assert_eq!(snapshot.stale_count, 2);
    }

    #[test]
    fn record_projection_drain_updates_global() {
        // Reset
        let cell = LAST_PROJECTION_DRAIN.get_or_init(|| Mutex::new(None));
        *cell.lock().unwrap() = None;

        assert!(last_projection_drain().is_none());

        record_projection_drain();

        let ts = last_projection_drain();
        assert!(
            ts.is_some(),
            "drain timestamp should be set after recording"
        );
    }

    // ── Default trait method tests ──

    #[derive(Clone)]
    struct MinimalTestState {
        auth_required: bool,
    }

    impl GatewayHealthState for MinimalTestState {
        fn gateway_auth_required(&self) -> bool {
            self.auth_required
        }
        fn recovered_stores(&self) -> Vec<String> {
            Vec::new()
        }
        // Uses default impls for all new methods
    }

    #[test]
    fn default_trait_methods_report_unknown_state() {
        let response = build_health_response(
            &MinimalTestState {
                auth_required: false,
            },
            None,
        );

        // Defaults: model unreachable, memory unhealthy → both down → unhealthy
        assert_eq!(response.status, HealthStatus::Unhealthy);
        assert!(!response.model_provider.reachable);
        assert!(!response.memory_store.pool_healthy);
        assert_eq!(response.memory_store.schema_version, 0);
        assert!(!response.sidecars.browser_automation.running);
        assert!(!response.sidecars.contained_computer.running);
        assert_eq!(response.leases.active_count, 0);
        assert_eq!(response.leases.stale_count, 0);
    }

    #[test]
    fn iso_now_produces_rfc3339_like_string() {
        let ts = iso_now();
        // Expected format: YYYY-MM-DDTHH:MM:SSZ
        assert_eq!(ts.len(), 20);
        assert_eq!(ts.chars().nth(4), Some('-'));
        assert_eq!(ts.chars().nth(7), Some('-'));
        assert_eq!(ts.chars().nth(10), Some('T'));
        assert_eq!(ts.chars().nth(13), Some(':'));
        assert_eq!(ts.chars().nth(16), Some(':'));
        assert_eq!(ts.chars().nth(19), Some('Z'));
    }
}
