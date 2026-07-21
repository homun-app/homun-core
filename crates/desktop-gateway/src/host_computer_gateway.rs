use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{Json, extract::Path, http::StatusCode};
use local_first_host_computer::{
    artifact::ArtifactManager,
    client::{HostComputerClient, RequestContext},
    grants::{AppGrant, GrantLevel, GrantScope, GrantStore, SignedAppIdentity},
    policy::{
        ActionCategory, HostActionPolicy, PolicyDecision, PolicyRequest, is_protected_bundle_id,
    },
    protocol::{ActionRequest, AppSnapshot, HostPermission, PermissionState, SemanticAction},
    redaction::{DisclosurePolicy, ProviderDisclosure, project_snapshot},
    session::{HostSessionCoordinator, HostSessionPhase, HostSessionSnapshot, SessionError},
    service::HostComputerService,
    supervisor::{HostComputerSupervisorConfig, SystemHelperLauncher, prepare_launch},
    transport::UdsTransport,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

type ApiError = (StatusCode, Json<Value>);

struct HostRuntime {
    client: Arc<HostComputerClient<UdsTransport>>,
    #[allow(dead_code)]
    service: HostComputerService<UdsTransport>,
    #[allow(dead_code)]
    session_root: PathBuf,
    snapshots: Mutex<HashMap<String, SnapshotGuard>>,
}

struct SnapshotGuard {
    app: SignedAppIdentity,
    snapshot: AppSnapshot,
}

static RUNTIME: OnceLock<tokio::sync::Mutex<Option<Arc<HostRuntime>>>> = OnceLock::new();
static GRANTS: OnceLock<Mutex<GrantStore>> = OnceLock::new();
static SESSIONS: OnceLock<Mutex<HostSessionCoordinator>> = OnceLock::new();
static MANAGER_READY: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum HostBetaState {
    Unsupported,
    Disabled,
    Setup,
    Ready,
    Active,
    Paused,
    Error,
}

fn manager_should_register(enabled: bool, permissions_ready: bool, has_grant: bool) -> bool {
    enabled && permissions_ready && has_grant
}

fn resolve_beta_state(
    enabled: bool,
    supported: bool,
    accessibility: bool,
    screen_recording: bool,
    active: bool,
    paused: bool,
) -> HostBetaState {
    if !supported {
        return HostBetaState::Unsupported;
    }
    if !enabled {
        return HostBetaState::Disabled;
    }
    if !(accessibility && screen_recording) {
        return HostBetaState::Setup;
    }
    if paused {
        return HostBetaState::Paused;
    }
    if active {
        HostBetaState::Active
    } else {
        HostBetaState::Ready
    }
}

pub fn manager_ready() -> bool {
    super::mac_apps_beta_enabled() && MANAGER_READY.load(Ordering::Acquire)
}

fn context() -> RequestContext {
    RequestContext {
        turn_id: None,
        deadline_unix_ms: now_ms() + 10_000,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn scope() -> GrantScope {
    GrantScope {
        user_id: super::gateway_user_id().as_str().to_string(),
        workspace_id: super::active_workspace_id(),
    }
}

fn grants() -> Result<&'static Mutex<GrantStore>, ApiError> {
    if let Some(store) = GRANTS.get() {
        return Ok(store);
    }
    let path = super::gateway_data_dir()
        .map_err(internal)?
        .join("host-computer-grants.sqlite3");
    let store = GrantStore::open(&path).map_err(internal)?;
    let _ = GRANTS.set(Mutex::new(store));
    Ok(GRANTS.get().expect("grant store initialized"))
}

fn sessions() -> &'static Mutex<HostSessionCoordinator> {
    SESSIONS.get_or_init(|| Mutex::new(HostSessionCoordinator::default()))
}

async fn runtime() -> Result<Arc<HostRuntime>, ApiError> {
    if !super::mac_apps_beta_enabled() {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "feature_disabled",
        ));
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    return Err(api_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "unsupported_platform",
    ));
    if std::env::var("HOMUN_HOST_COMPUTER").ok().as_deref() != Some("1") {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "feature_disabled",
        ));
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let guard = RUNTIME.get_or_init(|| tokio::sync::Mutex::new(None));
        let mut guard = guard.lock().await;
        if let Some(runtime) = guard.as_ref() {
            return Ok(runtime.clone());
        }
        let helper = std::env::var("HOMUN_HOST_COMPUTER_HELPER_PATH")
            .map(PathBuf::from)
            .map_err(internal)?;
        let runtime_root = super::gateway_data_dir()
            .map_err(internal)?
            .join("host-computer");
        let prepared = prepare_launch(&HostComputerSupervisorConfig {
            helper_bundle: helper,
            runtime_root,
            parent_pid: std::process::id(),
        })
        .map_err(internal)?;
        let socket_path = prepared.socket_path.clone();
        let artifact_root = prepared.artifact_root.clone();
        let session_root = prepared.session_root.clone();
        let _launcher = SystemHelperLauncher::launch(&prepared).map_err(internal)?;
        let token = prepared.into_token();
        for _ in 0..100 {
            if socket_path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !socket_path.exists() {
            return Err(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "helper_start_timeout",
            ));
        }
        let client = Arc::new(HostComputerClient::new(
            UdsTransport::new(socket_path),
            token,
        ));
        client
            .permission_status(context())
            .await
            .map_err(internal)?;
        let service = HostComputerService::new_with_artifacts(
            client.clone(),
            ArtifactManager::new(artifact_root, Duration::from_secs(1_800)),
        );
        let value = Arc::new(HostRuntime {
            client,
            service,
            session_root,
            snapshots: Mutex::new(HashMap::new()),
        });
        *guard = Some(value.clone());
        Ok(value)
    }
}

pub async fn status() -> Result<Json<Value>, ApiError> {
    let supported = cfg!(all(target_os = "macos", target_arch = "aarch64"));
    let enabled = super::mac_apps_beta_enabled();
    if !supported || !enabled {
        MANAGER_READY.store(false, Ordering::Release);
        let state = resolve_beta_state(enabled, supported, false, false, false, false);
        return Ok(Json(json!({
            "available": false,
            "supported": supported,
            "enabled": enabled,
            "state": state,
            "helper_version": null,
            "accessibility": "not_determined",
            "screen_recording": "not_determined",
            "ready": false,
            "reason": if supported { "feature_disabled" } else { "unsupported_platform" },
        })));
    }
    match runtime().await {
        Ok(runtime) => {
            let status = runtime
                .client
                .permission_status(context())
                .await
                .map_err(internal)?;
            let accessibility = status.accessibility == PermissionState::Granted;
            let screen_recording = status.screen_recording == PermissionState::Granted;
            let ready = accessibility && screen_recording;
            let has_grant = grants().ok().and_then(|store| store.lock().ok())
                .and_then(|store| store.list(&scope(), now_ms()).ok()).is_some_and(|items| !items.is_empty());
            MANAGER_READY.store(
                manager_should_register(enabled, ready, has_grant),
                Ordering::Release,
            );
            let active_snapshot = sessions()
                .lock()
                .ok()
                .and_then(|coordinator| coordinator.active_snapshot());
            let active = active_snapshot.as_ref().is_some_and(|snapshot| {
                matches!(
                    snapshot.phase,
                    HostSessionPhase::Observing
                        | HostSessionPhase::AwaitingApproval
                        | HostSessionPhase::Acting
                )
            });
            let paused = active_snapshot.as_ref().is_some_and(|snapshot| {
                matches!(
                    snapshot.phase,
                    HostSessionPhase::PausedByUser | HostSessionPhase::Suspended
                )
            });
            let state = resolve_beta_state(
                enabled,
                supported,
                accessibility,
                screen_recording,
                active,
                paused,
            );
            let host_session =
                active_snapshot.map(|snapshot| session_event("hydrated", &snapshot));
            Ok(Json(json!({"available":true,"supported":supported,"enabled":enabled,"state":state,"helper_version":"0.1.0",
                "accessibility":status.accessibility,"screen_recording":status.screen_recording,
                "ready":ready,"host_session":host_session})))
        }
        Err((_, Json(value))) => {
            MANAGER_READY.store(false, Ordering::Release);
            Ok(Json(json!({"available":false,"supported":supported,"enabled":enabled,"state":HostBetaState::Error,"helper_version":null,
            "accessibility":"not_determined","screen_recording":"not_determined","ready":false,
            "reason":value["error"]})))
        }
    }
}

pub async fn apps() -> Result<Json<Value>, ApiError> {
    let runtime = runtime().await?;
    let result = runtime
        .client
        .list_apps(false, context())
        .await
        .map_err(internal)?;
    let scope = scope();
    let store = grants()?.lock().map_err(internal)?;
    let values = result
        .apps
        .into_iter()
        .filter(|app| {
            !app
                .bundle_id
                .as_deref()
                .is_some_and(is_protected_bundle_id)
        })
        .map(|app| {
            let granted_level = app
                .bundle_id
                .as_ref()
                .zip(app.signing_identity.as_ref())
                .and_then(|(bundle_id, signing)| {
                    store
                        .resolve(
                            &scope,
                            &SignedAppIdentity {
                                bundle_id: bundle_id.clone(),
                                team_id: signing.team_id.clone(),
                                designated_requirement_sha256: signing
                                    .designated_requirement_sha256
                                    .clone(),
                            },
                            now_ms(),
                        )
                        .ok()
                        .flatten()
                });
            json!({"pid":app.identity.pid,"display_name":app.display_name,"bundle_id":app.bundle_id,
            "signing_identity":app.signing_identity,"granted_level":granted_level})
        })
        .collect::<Vec<_>>();
    Ok(Json(Value::Array(values)))
}

#[derive(Deserialize)]
pub struct PresentPermission {
    permission: HostPermission,
}

pub async fn present_permission(
    Json(input): Json<PresentPermission>,
) -> Result<Json<Value>, ApiError> {
    let status = runtime()
        .await?
        .client
        .permission_present(input.permission, context())
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::to_value(status).map_err(internal)?))
}

pub async fn list_grants() -> Result<Json<Value>, ApiError> {
    let values = grants()?
        .lock()
        .map_err(internal)?
        .list(&scope(), now_ms())
        .map_err(internal)?;
    Ok(Json(JsonGrant::many(values)))
}

#[derive(Deserialize)]
pub struct CreateGrant {
    bundle_id: String,
    level: GrantLevel,
}

pub async fn create_grant(Json(input): Json<CreateGrant>) -> Result<Json<Value>, ApiError> {
    if is_protected_bundle_id(&input.bundle_id) {
        return Err(api_error(StatusCode::FORBIDDEN, "protected_app"));
    }
    let app = runtime()
        .await?
        .client
        .list_apps(false, context())
        .await
        .map_err(internal)?
        .apps
        .into_iter()
        .find(|app| app.bundle_id.as_deref() == Some(input.bundle_id.as_str()))
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "app_not_found"))?;
    let signing = app
        .signing_identity
        .ok_or_else(|| api_error(StatusCode::UNPROCESSABLE_ENTITY, "unsigned_app"))?;
    let grant = AppGrant {
        grant_id: uuid::Uuid::new_v4().to_string(),
        scope: scope(),
        app: SignedAppIdentity {
            bundle_id: input.bundle_id,
            team_id: signing.team_id,
            designated_requirement_sha256: signing.designated_requirement_sha256,
        },
        level: input.level,
        expires_at_unix_ms: None,
    };
    grants()?
        .lock()
        .map_err(internal)?
        .upsert(&grant, now_ms())
        .map_err(internal)?;
    MANAGER_READY.store(false, Ordering::Release);
    Ok(Json(JsonGrant::one(grant)))
}

pub async fn revoke_grant(Path(grant_id): Path<String>) -> Result<StatusCode, ApiError> {
    let removed = grants()?
        .lock()
        .map_err(internal)?
        .revoke(&grant_id, &scope())
        .map_err(internal)?;
    MANAGER_READY.store(false, Ordering::Release);
    if removed {
        let cancelled = sessions().lock().ok().and_then(|mut coordinator| {
            coordinator.cancel_active(now_ms()).ok().flatten()
        });
        if let Some(snapshot) = cancelled {
            publish_session("cancelled", &snapshot);
        }
        if let Some(runtime) = RUNTIME.get().and_then(|runtime| runtime.try_lock().ok())
            .and_then(|runtime| runtime.clone())
        {
            if let Ok(mut snapshots) = runtime.snapshots.lock() {
                snapshots.clear();
            }
        }
    }
    Ok(if removed {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    })
}

#[derive(Deserialize)]
pub struct ResolveApproval {
    action_digest: String,
}

#[derive(Deserialize)]
pub struct ResumeSession {
    generation: u64,
}

pub async fn approve_session(
    Path(session_id): Path<String>,
    Json(input): Json<ResolveApproval>,
) -> Result<Json<Value>, ApiError> {
    transition_session("approval_resolved", |coordinator| {
        coordinator.approve(&session_id, &input.action_digest, now_ms())
    })
}

pub async fn deny_session(
    Path(session_id): Path<String>,
    Json(input): Json<ResolveApproval>,
) -> Result<Json<Value>, ApiError> {
    transition_session("approval_resolved", |coordinator| {
        coordinator.deny(&session_id, &input.action_digest, now_ms())
    })
}

pub async fn pause_session(Path(session_id): Path<String>) -> Result<Json<Value>, ApiError> {
    transition_session("paused_by_user", |coordinator| {
        coordinator.pause(&session_id, now_ms())
    })
}

pub async fn resume_session(
    Path(session_id): Path<String>,
    Json(input): Json<ResumeSession>,
) -> Result<Json<Value>, ApiError> {
    transition_session("resumed", |coordinator| {
        coordinator.resume(&session_id, input.generation, now_ms())
    })
}

pub async fn cancel_session(Path(session_id): Path<String>) -> Result<Json<Value>, ApiError> {
    transition_session("cancelled", |coordinator| {
        coordinator.cancel(&session_id, now_ms())
    })
}

fn transition_session(
    kind: &str,
    transition: impl FnOnce(&mut HostSessionCoordinator) -> Result<HostSessionSnapshot, SessionError>,
) -> Result<Json<Value>, ApiError> {
    let mut coordinator = sessions().lock().map_err(internal)?;
    let snapshot = transition(&mut coordinator).map_err(session_api_error)?;
    drop(coordinator);
    publish_session(kind, &snapshot);
    Ok(Json(session_event(kind, &snapshot)))
}

struct JsonGrant;
impl JsonGrant {
    fn one(value: AppGrant) -> Value {
        json!({"grant_id":value.grant_id,"bundle_id":value.app.bundle_id,"level":value.level,
        "display_name":value.app.bundle_id,
        "team_id":value.app.team_id,"designated_requirement_sha256":value.app.designated_requirement_sha256})
    }
    fn many(values: Vec<AppGrant>) -> Value {
        Value::Array(values.into_iter().map(Self::one).collect())
    }
}

fn api_error(status: StatusCode, message: &str) -> ApiError {
    (status, Json(json!({"error":message})))
}
fn internal(error: impl std::fmt::Display) -> ApiError {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":error.to_string()})),
    )
}

pub fn start_worker_session(session_id: &str, app: &str) -> Result<(), String> {
    if !super::mac_apps_beta_enabled() {
        return Err("feature_disabled".to_string());
    }
    if !manager_ready() {
        return Err("mac_apps_not_ready".to_string());
    }
    let snapshot = sessions().lock().map_err(|_| "session coordinator unavailable".to_string())?
        .start(session_id, app, now_ms()).map_err(|error| error.to_string())?;
    publish_session("started", &snapshot);
    Ok(())
}

pub async fn disable() {
    MANAGER_READY.store(false, Ordering::Release);
    let cancelled = sessions()
        .lock()
        .ok()
        .and_then(|mut coordinator| coordinator.cancel_active(now_ms()).ok().flatten());
    if let Some(snapshot) = cancelled {
        publish_session("cancelled", &snapshot);
    }
    if let Some(runtime) = RUNTIME.get() {
        let mut guard = runtime.lock().await;
        if let Some(current) = guard.as_ref() {
            if let Ok(mut snapshots) = current.snapshots.lock() {
                snapshots.clear();
            }
        }
        *guard = None;
    }
}

pub fn finish_worker_session(session_id: &str, succeeded: bool) {
    let snapshot = sessions().lock().ok().and_then(|mut coordinator| {
        let current = coordinator.snapshot(session_id).ok()?;
        if matches!(current.phase, HostSessionPhase::AwaitingApproval | HostSessionPhase::PausedByUser) {
            return None;
        }
        if succeeded { coordinator.done(session_id, now_ms()).ok() }
        else { coordinator.fail(session_id, "worker_failed", now_ms()).ok() }
    });
    if let Some(snapshot) = snapshot {
        publish_session(if succeeded { "done" } else { "failed" }, &snapshot);
    }
}

pub async fn worker_list_apps(session_id: &str) -> Result<Value, String> {
    ensure_session_operational(session_id)?;
    let runtime = runtime().await.map_err(api_error_text)?;
    let apps = runtime.client.list_apps(false, context()).await.map_err(|error| error.to_string())?.apps;
    let scope = scope();
    let store = grants().map_err(api_error_text)?.lock().map_err(|_| "grant store unavailable".to_string())?;
    Ok(Value::Array(apps.into_iter().filter_map(|app| {
        let (bundle_id, signing) = app.bundle_id.zip(app.signing_identity)?;
        if is_protected_bundle_id(&bundle_id) {
            return None;
        }
        let identity = SignedAppIdentity { bundle_id: bundle_id.clone(), team_id: signing.team_id,
            designated_requirement_sha256: signing.designated_requirement_sha256 };
        let level = store.resolve(&scope, &identity, now_ms()).ok().flatten()?;
        Some(json!({"pid":app.identity.pid,"display_name":app.display_name,"bundle_id":bundle_id,"grant":level}))
    }).collect()))
}

pub async fn worker_get_state(session_id: &str, pid: u32) -> Result<Value, String> {
    ensure_session_operational(session_id)?;
    let runtime = runtime().await.map_err(api_error_text)?;
    let app = runtime.client.list_apps(false, context()).await.map_err(|error| error.to_string())?.apps
        .into_iter().find(|app| app.identity.pid == pid).ok_or("app_not_found")?;
    if app.bundle_id.as_deref().is_some_and(is_protected_bundle_id) {
        return Err("protected_app".into());
    }
    let app_display_name = app.display_name.clone();
    let identity = signed_identity(&app)?;
    let level = grants().map_err(api_error_text)?.lock().map_err(|_| "grant store unavailable".to_string())?
        .resolve(&scope(), &identity, now_ms()).map_err(|error| error.to_string())?;
    if level.is_none() { return Err("app_not_granted".into()); }
    let snapshot = runtime.client.get_app_state(pid, None, context()).await.map_err(|error| error.to_string())?;
    runtime.snapshots.lock().map_err(|_| "snapshot registry unavailable".to_string())?
        .insert(snapshot.snapshot_id.clone(), SnapshotGuard { app: identity, snapshot: snapshot.clone() });
    let value = serde_json::to_value(project_snapshot(
        &snapshot,
        ProviderDisclosure::Remote,
        DisclosurePolicy::MAC_APPS_BETA,
    ))
    .map_err(|error| error.to_string())?;
    if let Ok(snapshot) = sessions().lock().map_err(|_| ()).and_then(|mut coordinator| {
        coordinator.mark_observing_app(session_id, app_display_name, now_ms()).map_err(|_| ())
    }) {
        publish_session("state", &snapshot);
    }
    Ok(value)
}

pub async fn worker_execute_action(session_id: &str, mut request: ActionRequest) -> Result<Value, String> {
    ensure_session_operational(session_id)?;
    let runtime = runtime().await.map_err(api_error_text)?;
    let (app, snapshot) = runtime.snapshots.lock().map_err(|_| "snapshot registry unavailable".to_string())?
        .get(&request.target.snapshot_id).map(|guard| (guard.app.clone(), guard.snapshot.clone()))
        .ok_or("stale_snapshot")?;
    let level = grants().map_err(api_error_text)?.lock().map_err(|_| "grant store unavailable".to_string())?
        .resolve(&scope(), &app, now_ms()).map_err(|error| error.to_string())?;
    let element = snapshot.elements.iter().find(|element| element.index == request.target.index)
        .ok_or("target_not_found")?;
    let category = if request.action == SemanticAction::SetValue { ActionCategory::TextEntry } else { ActionCategory::Reversible };
    request.resume_token = None;
    let digest = action_digest(session_id, &app, &request)?;
    let approval_matches = sessions().lock().map_err(|_| "session coordinator unavailable".to_string())?
        .consume_approval(session_id, &digest, now_ms()).map_err(|error| error.to_string())?;
    match HostActionPolicy.decide(level, &PolicyRequest { category, protected_target: element.sensitive,
        low_risk_typing_enabled: false, approval_matches }) {
        PolicyDecision::Allowed => {}
        PolicyDecision::ApprovalRequired(category) => {
            let summary = action_summary(category, element.role.as_str());
            let pending = sessions().lock().map_err(|_| "session coordinator unavailable".to_string())?
                .request_approval(session_id, &digest, category, summary, now_ms())
                .map_err(|error| error.to_string())?;
            publish_session("approval_required", &pending);
            await_approval(session_id, &digest).await?;
        }
        PolicyDecision::GrantRequired(_) => return Err("control_grant_required".into()),
        PolicyDecision::Denied(reason) => return Err(format!("hard_denied:{reason:?}")),
    }
    let token = uuid::Uuid::new_v4().to_string();
    runtime.client.resume_control(token.clone(), context()).await.map_err(|error| error.to_string())?;
    request.resume_token = Some(token);
    let result = runtime.client.execute_action(request, context()).await.map_err(|error| error.to_string())?;
    runtime.snapshots.lock().map_err(|_| "snapshot registry unavailable".to_string())?.remove(&snapshot.snapshot_id);
    if let Ok(session_snapshot) = sessions().lock().map_err(|_| ()).and_then(|mut coordinator| {
        coordinator.mark_observing(session_id, now_ms()).map_err(|_| ())
    }) {
        publish_action(&session_snapshot, category, &digest, "succeeded");
    }
    serde_json::to_value(result).map_err(|error| error.to_string())
}

async fn await_approval(session_id: &str, action_digest: &str) -> Result<(), String> {
    loop {
        {
            let mut coordinator = sessions().lock().map_err(|_| "session coordinator unavailable".to_string())?;
            let snapshot = coordinator.snapshot(session_id).map_err(|error| error.to_string())?;
            match snapshot.phase {
                HostSessionPhase::Failed => return Err(snapshot.error_code.unwrap_or_else(|| "approval_denied".into())),
                HostSessionPhase::Cancelled => return Err("session_cancelled".into()),
                HostSessionPhase::PausedByUser => return Err("paused_by_user".into()),
                _ => {}
            }
            if coordinator.consume_approval(session_id, action_digest, now_ms()).map_err(|error| error.to_string())? {
                let snapshot = coordinator.snapshot(session_id).map_err(|error| error.to_string())?;
                drop(coordinator);
                publish_session("approval_resolved", &snapshot);
                return Ok(());
            }
            let snapshot = coordinator.snapshot(session_id).map_err(|error| error.to_string())?;
            match snapshot.phase {
                _ if now_ms() > snapshot.pending_approval.as_ref().map(|approval| approval.expires_at_unix_ms).unwrap_or(i64::MAX) => {
                    let expired = coordinator.fail(session_id, "approval_expired", now_ms()).map_err(|error| error.to_string())?;
                    drop(coordinator);
                    publish_session("failed", &expired);
                    return Err("approval_expired".into());
                }
                _ => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn ensure_session_operational(session_id: &str) -> Result<(), String> {
    let snapshot = sessions().lock().map_err(|_| "session coordinator unavailable".to_string())?
        .snapshot(session_id).map_err(|error| error.to_string())?;
    match snapshot.phase {
        HostSessionPhase::PausedByUser => Err("paused_by_user".into()),
        HostSessionPhase::Done | HostSessionPhase::Failed | HostSessionPhase::Cancelled => Err("session_terminated".into()),
        _ => Ok(()),
    }
}

fn action_digest(session_id: &str, app: &SignedAppIdentity, request: &ActionRequest) -> Result<String, String> {
    let payload = serde_json::to_vec(&(session_id, &app.bundle_id, &app.team_id,
        &app.designated_requirement_sha256, request)).map_err(|error| error.to_string())?;
    Ok(Sha256::digest(payload).iter().map(|byte| format!("{byte:02x}")).collect())
}

fn action_summary(category: ActionCategory, role: &str) -> String {
    match category {
        ActionCategory::TextEntry => format!("Enter text in {role}"),
        _ => format!("Perform a {category:?} action on {role}"),
    }
}

fn publish_session(kind: &str, snapshot: &HostSessionSnapshot) {
    let event = session_event(kind, snapshot);
    super::publish_app_event(event.clone());
    if let Some(registry) = super::ws_registry().get() {
        registry.publish_computer_live(json!({"source":"host_apps","host":event}));
    }
    append_journal(&event);
}

fn publish_action(
    snapshot: &HostSessionSnapshot,
    category: ActionCategory,
    action_digest: &str,
    outcome: &str,
) {
    let mut event = session_event("action", snapshot);
    if let Some(object) = event.as_object_mut() {
        object.insert("category".into(), json!(category));
        object.insert("action_digest".into(), json!(action_digest));
        object.insert("outcome".into(), json!(outcome));
    }
    super::publish_app_event(event.clone());
    if let Some(registry) = super::ws_registry().get() {
        registry.publish_computer_live(json!({"source":"host_apps","host":event}));
    }
    append_journal(&event);
}

fn session_event(kind: &str, snapshot: &HostSessionSnapshot) -> Value {
    let approval = snapshot.pending_approval.as_ref().map(|approval| json!({
        "category": approval.category,
        "summary": approval.summary,
        "action_digest": approval.action_digest,
        "expires_at_unix_ms": approval.expires_at_unix_ms,
    }));
    json!({
        "type": format!("host_computer.{kind}"),
        "sequence": snapshot.sequence,
        "session_id": snapshot.session_id,
        "generation": snapshot.generation,
        "phase": snapshot.phase,
        "app": snapshot.app,
        "approval": approval,
        "error_code": snapshot.error_code,
        "updated_at_unix_ms": snapshot.updated_at_unix_ms,
    })
}

fn append_journal(event: &Value) {
    let Ok(data_dir) = super::gateway_data_dir() else { return; };
    let path = data_dir.join("host-computer-journal.jsonl");
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else { return; };
    let _ = writeln!(file, "{}", event);
}

fn signed_identity(app: &local_first_host_computer::protocol::HostApplication) -> Result<SignedAppIdentity, String> {
    let bundle_id = app.bundle_id.clone().ok_or("app_has_no_bundle_id")?;
    let signing = app.signing_identity.clone().ok_or("app_is_unsigned")?;
    Ok(SignedAppIdentity { bundle_id, team_id: signing.team_id,
        designated_requirement_sha256: signing.designated_requirement_sha256 })
}

fn api_error_text(error: ApiError) -> String {
    error.1.0.get("error").and_then(Value::as_str).unwrap_or("host_computer_unavailable").to_string()
}

fn session_api_error(error: SessionError) -> ApiError {
    let status = match error {
        SessionError::NotFound => StatusCode::NOT_FOUND,
        SessionError::ActionDigestMismatch | SessionError::GenerationMismatch => StatusCode::CONFLICT,
        SessionError::ApprovalExpired => StatusCode::GONE,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    api_error(status, &error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beta_state_is_disabled_before_permissions_and_never_ready_on_unsupported_hosts() {
        assert_eq!(
            resolve_beta_state(false, true, false, false, false, false),
            HostBetaState::Disabled
        );
        assert_eq!(
            resolve_beta_state(true, true, false, false, false, false),
            HostBetaState::Setup
        );
        assert_eq!(
            resolve_beta_state(true, true, true, true, false, false),
            HostBetaState::Ready
        );
        assert_eq!(
            resolve_beta_state(true, true, true, true, true, false),
            HostBetaState::Active
        );
        assert_eq!(
            resolve_beta_state(true, true, true, true, false, true),
            HostBetaState::Paused
        );
        assert_eq!(
            resolve_beta_state(true, false, true, true, false, false),
            HostBetaState::Unsupported
        );
    }

    #[test]
    fn manager_tool_requires_opt_in_permissions_and_a_valid_grant() {
        assert!(!manager_should_register(false, true, true));
        assert!(!manager_should_register(true, false, true));
        assert!(!manager_should_register(true, true, false));
        assert!(manager_should_register(true, true, true));
    }

    #[test]
    fn approval_event_contains_summary_but_never_action_value() {
        let snapshot = HostSessionSnapshot {
            session_id: "session-1".into(), sequence: 2, generation: 1,
            phase: HostSessionPhase::AwaitingApproval, app: "Editor".into(),
            pending_approval: Some(local_first_host_computer::session::PendingHostApproval {
                category: ActionCategory::TextEntry,
                summary: "Enter text in text field".into(),
                action_digest: "digest".into(), expires_at_unix_ms: 10,
            }),
            error_code: None, updated_at_unix_ms: 1,
        };
        let json = session_event("approval_required", &snapshot).to_string();
        assert!(json.contains("Enter text in text field"));
        assert!(!json.contains("private body"));
        assert!(!json.contains("resume_token"));
    }
}
