use std::{
    collections::HashMap,
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
    policy::{ActionCategory, HostActionPolicy, PolicyDecision, PolicyRequest},
    protocol::{ActionRequest, AppSnapshot, HostPermission, PermissionState, SemanticAction},
    redaction::{DisclosurePolicy, ProviderDisclosure, project_snapshot},
    service::HostComputerService,
    supervisor::{HostComputerSupervisorConfig, SystemHelperLauncher, prepare_launch},
    transport::UdsTransport,
};
use serde::Deserialize;
use serde_json::{Value, json};

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
static MANAGER_READY: AtomicBool = AtomicBool::new(false);

pub fn manager_ready() -> bool {
    MANAGER_READY.load(Ordering::Acquire)
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

async fn runtime() -> Result<Arc<HostRuntime>, ApiError> {
    if std::env::var("HOMUN_HOST_COMPUTER").ok().as_deref() != Some("1") {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "feature_disabled",
        ));
    }
    #[cfg(not(target_os = "macos"))]
    return Err(api_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "unsupported_platform",
    ));
    #[cfg(target_os = "macos")]
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
    match runtime().await {
        Ok(runtime) => {
            let status = runtime
                .client
                .permission_status(context())
                .await
                .map_err(internal)?;
            let ready = status.accessibility == PermissionState::Granted
                && status.screen_recording == PermissionState::Granted;
            let has_grant = grants().ok().and_then(|store| store.lock().ok())
                .and_then(|store| store.list(&scope(), now_ms()).ok()).is_some_and(|items| !items.is_empty());
            MANAGER_READY.store(ready && has_grant, Ordering::Release);
            Ok(Json(json!({"available":true,"helper_version":"0.1.0",
                "accessibility":status.accessibility,"screen_recording":status.screen_recording,"ready":ready})))
        }
        Err((_, Json(value))) => Ok(Json(json!({"available":false,"helper_version":null,
            "accessibility":"not_determined","screen_recording":"not_determined","ready":false,
            "reason":value["error"]}))),
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
    Ok(if removed {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    })
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

pub async fn worker_list_apps() -> Result<Value, String> {
    let runtime = runtime().await.map_err(api_error_text)?;
    let apps = runtime.client.list_apps(false, context()).await.map_err(|error| error.to_string())?.apps;
    let scope = scope();
    let store = grants().map_err(api_error_text)?.lock().map_err(|_| "grant store unavailable".to_string())?;
    Ok(Value::Array(apps.into_iter().filter_map(|app| {
        let (bundle_id, signing) = app.bundle_id.zip(app.signing_identity)?;
        let identity = SignedAppIdentity { bundle_id: bundle_id.clone(), team_id: signing.team_id,
            designated_requirement_sha256: signing.designated_requirement_sha256 };
        let level = store.resolve(&scope, &identity, now_ms()).ok().flatten()?;
        Some(json!({"pid":app.identity.pid,"display_name":app.display_name,"bundle_id":bundle_id,"grant":level}))
    }).collect()))
}

pub async fn worker_get_state(pid: u32) -> Result<Value, String> {
    let runtime = runtime().await.map_err(api_error_text)?;
    let app = runtime.client.list_apps(false, context()).await.map_err(|error| error.to_string())?.apps
        .into_iter().find(|app| app.identity.pid == pid).ok_or("app_not_found")?;
    let identity = signed_identity(&app)?;
    let level = grants().map_err(api_error_text)?.lock().map_err(|_| "grant store unavailable".to_string())?
        .resolve(&scope(), &identity, now_ms()).map_err(|error| error.to_string())?;
    if level.is_none() { return Err("app_not_granted".into()); }
    let snapshot = runtime.client.get_app_state(pid, None, context()).await.map_err(|error| error.to_string())?;
    runtime.snapshots.lock().map_err(|_| "snapshot registry unavailable".to_string())?
        .insert(snapshot.snapshot_id.clone(), SnapshotGuard { app: identity, snapshot: snapshot.clone() });
    serde_json::to_value(project_snapshot(&snapshot, ProviderDisclosure::Remote,
        DisclosurePolicy { disclose_screenshots_to_remote: false })).map_err(|error| error.to_string())
}

pub async fn worker_execute_action(mut request: ActionRequest) -> Result<Value, String> {
    let runtime = runtime().await.map_err(api_error_text)?;
    let (app, snapshot) = runtime.snapshots.lock().map_err(|_| "snapshot registry unavailable".to_string())?
        .get(&request.target.snapshot_id).map(|guard| (guard.app.clone(), guard.snapshot.clone()))
        .ok_or("stale_snapshot")?;
    let level = grants().map_err(api_error_text)?.lock().map_err(|_| "grant store unavailable".to_string())?
        .resolve(&scope(), &app, now_ms()).map_err(|error| error.to_string())?;
    let element = snapshot.elements.iter().find(|element| element.index == request.target.index)
        .ok_or("target_not_found")?;
    let category = if request.action == SemanticAction::SetValue { ActionCategory::TextEntry } else { ActionCategory::Reversible };
    match HostActionPolicy.decide(level, &PolicyRequest { category, protected_target: element.sensitive,
        low_risk_typing_enabled: false, approval_matches: false }) {
        PolicyDecision::Allowed => {}
        PolicyDecision::ApprovalRequired(category) => return Err(format!("approval_required:{category:?}")),
        PolicyDecision::GrantRequired(_) => return Err("control_grant_required".into()),
        PolicyDecision::Denied(reason) => return Err(format!("hard_denied:{reason:?}")),
    }
    let token = uuid::Uuid::new_v4().to_string();
    runtime.client.resume_control(token.clone(), context()).await.map_err(|error| error.to_string())?;
    request.resume_token = Some(token);
    let result = runtime.client.execute_action(request, context()).await.map_err(|error| error.to_string())?;
    runtime.snapshots.lock().map_err(|_| "snapshot registry unavailable".to_string())?.remove(&snapshot.snapshot_id);
    serde_json::to_value(result).map_err(|error| error.to_string())
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
