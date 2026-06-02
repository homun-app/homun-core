mod browser_loop_controller;
// Brain -> OperationalPlan adapter (A1), wired via `try_brain_operational_plan`.
mod brain_adapter;
mod chat_store;
// Multi-provider inference registry (Phase 1 of per-role model routing).
mod model_registry;
// Local scanner for Anthropic "Agent Skills" (SKILL.md folders).
mod skills;
// Skill catalog (ClawHub/OpenClaw) — cached + searchable, ported from Homun.
mod skills_catalog;
// Static security scan for installed skills, ported from Homun.
mod skill_security;
// Skill execution sandbox (reuses the browser's contained-computer container).
mod sandbox;
mod task_registry;

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, Request, State},
    http::{
        HeaderMap, HeaderValue, Method, StatusCode,
        header::{AUTHORIZATION, CONTENT_TYPE},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::delete,
    routing::get,
    routing::post,
};
use base64::Engine as _;
use browser_loop_controller::{BrowserContextProfile, RuntimeBrowserLoopPlanner};
use chat_store::ChatStore;
use local_first_browser_automation::{
    BrowserAutomationClient, BrowserAutomationError, BrowserLoopRequest, BrowserLoopRunner,
    BrowserMethod, BrowserResponse, BrowserSidecarSession, BrowserSidecarSpawnOptions,
    BrowserUrlApprovalGrant, BrowserUrlApprovalScope, BrowserUrlPolicyStore, BrowserVisibilityMode,
    browser_loop_event_payload,
};
use local_first_inference::{
    AnthropicProvider, CapabilityDescriptor, Locality, ModelRouter, OpenAiCompatProvider,
    PrivacyPolicy, Requirements,
};
use local_first_capabilities::{
    ActionClass, CachedCapabilityTool, CachedToolProvider, CapabilityConnectionConfig,
    CapabilityError, CapabilityFacade, CapabilityPolicy, CapabilityProvider, CapabilityProviderConfig,
    CapabilityProviderGrant, CapabilityProviderKind, CapabilityRegistryStore, CapabilityResult,
    CapabilityTaskPayload, ComposioCapabilityProvider, ComposioProviderConfig, ComposioTransport,
    InMemoryCapabilityAudit, McpCapabilityProvider, McpStdioConfig, McpStdioTransport, McpToolPolicy,
    PolicyContext, ProviderId as CapabilityProviderId, UserId as CapabilityUserId,
    WorkspaceId as CapabilityWorkspaceId,
};
use local_first_orchestrator::{
    ExecutionPlan, MemoryContextProvider, MemoryContextSnippet, OrchestratorBrain,
    OrchestratorBudgets, OrchestratorRequest, OrchestratorResult, ToolSearchIndexStore,
};
use local_first_secrets::{
    DevelopmentSecretKeyProvider, EncryptedFileSecretStore, SecretMaterial, SecretRef, SecretStore,
};
use local_first_desktop_gateway::{
    BuildPromptRequest, BuildPromptResponse, ChatGenerateStreamRequest,
    ChatMessagesSnapshot, ChatThread, ChatThreadSnapshot,
    CommitContinuationResultRequest, CommitPromptResultRequest, SetThreadPinnedRequest,
    build_chat_runtime_prompt, compact_thread_title,
};
use local_first_local_computer_session::{
    ApprovalState, ArtifactRecord, ComputerEventRecord, ComputerSessionRecord,
    ComputerSurfaceRecord, SessionStatus, SurfaceKind, SurfaceStatus, TakeoverState,
};
use local_first_local_computer_session::{LocalComputerReadModel, LocalComputerSessionStore};
use local_first_memory::{
    DataSensitivity as MemoryDataSensitivity, MemoryAccessRequest, MemoryCreateRequest,
    MemoryDashboard, MemoryFacade, MemoryLifecycleRequest, MemoryRef, MemoryRefKind,
    MemoryUiReadModel, MemoryWikiProjection, PrivacyDomain, SQLiteMemoryStore,
    UserId as MemoryUserId, WikiFileStore, WikiPage, WorkspaceId as MemoryWorkspaceId,
};
use bytes::Bytes;
use local_first_subagents::{
    GenerateJsonRequest, GenerateStreamEvent, SubagentTaskExecutor, TokenMetrics,
};
use local_first_task_runtime::{
    ApprovalGate, ApprovalRequest, ApprovalStatus, ExecutorResult, LeaseManager, ResourceClass,
    ResourceGovernor, ResourceLimits, ResourceRequirement, TaskExecutor, TaskId, TaskPriority,
    TaskQueueSnapshot, TaskRecord, TaskRuntimeError, TaskScheduler, TaskStatus, TaskStore,
    TaskUiDetail, TaskUiItem, TaskUiReadModel, UserId, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    process::Command,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration as StdDuration,
};
use task_registry::{GatewayTaskExecutorKind, TaskExecutorRegistry};
use time::{Duration, OffsetDateTime};
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, CorsLayer};

const TASK_EXECUTOR_WORKER_ID: &str = "desktop-gateway-background-worker";
const TASK_EXECUTOR_MANUAL_WORKER_ID: &str = "desktop-gateway-manual-run";
const TASK_EXECUTOR_POLL_INTERVAL_MS: u64 = 1_000;

#[derive(Clone)]
struct AppState {
    http: reqwest::Client,
    chat_store: Arc<Mutex<ChatStore>>,
    task_store: Arc<Mutex<TaskStore>>,
    computer_store: Arc<Mutex<LocalComputerSessionStore>>,
    browser_url_policies: Arc<Mutex<BrowserUrlPolicyStore>>,
    memory_facade: Arc<Mutex<MemoryFacade>>,
    capability_registry: Arc<Mutex<CapabilityRegistryStore>>,
    task_executor_status: Arc<Mutex<TaskExecutorStatus>>,
    task_executor_registry: TaskExecutorRegistry,
    browser_capability_client: Arc<Mutex<Option<BrowserAutomationClient<BrowserSidecarSession>>>>,
    /// Persistent browser sessions keyed by chat thread_id, so a thread's
    /// browse_web calls reuse one warm session (search → then book on the same
    /// tab) instead of spawning a fresh sidecar each time. Reaped on idle and on
    /// thread archive/close/delete.
    browser_thread_sessions: Arc<Mutex<std::collections::HashMap<String, ThreadBrowserSession>>>,
    secret_store: Arc<EncryptedFileSecretStore<DevelopmentSecretKeyProvider>>,
    auth_token: Arc<str>,
}

/// A live, reusable browser session bound to a chat thread.
struct ThreadBrowserSession {
    client: BrowserAutomationClient<BrowserSidecarSession>,
    last_used: std::time::Instant,
}

#[derive(Debug, Clone)]
struct TaskExecutorStatus {
    enabled: bool,
    worker_id: String,
    poll_interval_ms: u64,
    status: String,
    last_tick_at: Option<String>,
    last_task_id: Option<String>,
    last_message: String,
    completed_count: u64,
    failure_count: u64,
}

impl TaskExecutorStatus {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            worker_id: TASK_EXECUTOR_WORKER_ID.to_string(),
            poll_interval_ms: TASK_EXECUTOR_POLL_INTERVAL_MS,
            status: if enabled { "starting" } else { "disabled" }.to_string(),
            last_tick_at: None,
            last_task_id: None,
            last_message: if enabled {
                "Worker executor locale in avvio.".to_string()
            } else {
                "Worker executor locale disabilitato da ambiente.".to_string()
            },
            completed_count: 0,
            failure_count: 0,
        }
    }
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    ok: bool,
    service: &'static str,
    local_first: bool,
    auth_required: bool,
}

#[derive(Debug, Serialize)]
struct TaskItemResponse {
    task_id: String,
    kind: String,
    goal: String,
    status: String,
    priority: String,
    blocked_reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct ApprovalItemResponse {
    approval_id: String,
    task_id: String,
    action: String,
    risk_level: String,
    data_boundary: String,
    explanation: String,
    status: String,
    scope_options: Vec<String>,
    browser_visibility_options: Vec<String>,
    default_browser_visibility: String,
}

#[derive(Debug, Serialize)]
struct ResourceUsageResponse {
    resource_class: String,
    units: u32,
}

#[derive(Debug, Serialize)]
struct TaskQueueResponse {
    queued: Vec<TaskItemResponse>,
    active: Vec<TaskItemResponse>,
    blocked: Vec<TaskItemResponse>,
    waiting_approvals: Vec<ApprovalItemResponse>,
    recent_failures: Vec<TaskItemResponse>,
    resource_usage: Vec<ResourceUsageResponse>,
}

#[derive(Debug, Serialize)]
struct TaskDetailResponse {
    #[serde(flatten)]
    item: TaskItemResponse,
    latest_checkpoint: Option<Value>,
    runtime_metadata: Option<Value>,
    exposes_raw_input: bool,
}

#[derive(Debug, Serialize)]
struct TaskRunStepResponse {
    status: String,
    task_id: Option<String>,
    message: String,
}

#[derive(Debug, Serialize)]
struct TaskRunBatchResponse {
    status: String,
    completed: u32,
    stopped_reason: Option<String>,
    results: Vec<TaskRunStepResponse>,
}

#[derive(Debug, Serialize)]
struct TaskExecutorStatusResponse {
    enabled: bool,
    worker_id: String,
    poll_interval_ms: u64,
    status: String,
    last_tick_at: Option<String>,
    last_task_id: Option<String>,
    last_message: String,
    completed_count: u64,
    failure_count: u64,
}

struct TaskExecutionOutcome {
    completed: bool,
    blocked_reason: Option<String>,
    pending_approval: Option<PendingExecutorApproval>,
    summary: String,
    checkpoint_payload: Value,
    checkpoint_redacted: Value,
    chat_message: String,
    surface: SurfaceKind,
    event_kind: String,
    event_title: String,
    event_subtitle: String,
    event_payload: Value,
    artifacts: Vec<TaskArtifactOutput>,
}

struct PendingExecutorApproval {
    action: String,
    risk_level: String,
    data_boundary: String,
    explanation: String,
}

struct TaskArtifactOutput {
    artifact_id: String,
    title: String,
    kind: String,
    path_ref: String,
    size_bytes: u64,
    preview_ref: Option<String>,
}

#[derive(Debug, Clone)]
struct BrowserSourceSummary {
    label: String,
    url: String,
    status: String,
}

#[derive(Debug, Clone)]
struct BrowserFormDraftSummary {
    label: String,
    url: String,
    status: String,
    filled_fields: Vec<String>,
    reason: Option<String>,
    search_status: Option<String>,
    search_excerpt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OperationalIntentType {
    Informational,
    Transactional,
    Navigational,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OperationalAutonomy {
    AutomaticUntilGate,
    AskBeforeEachExternalAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OperationalStepStatus {
    Pending,
    InProgress,
    Completed,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OperationalPlanStep {
    id: String,
    title: String,
    detail: String,
    tool: Option<String>,
    status: OperationalStepStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OperationalPlan {
    objective: String,
    intent_type: OperationalIntentType,
    autonomy: OperationalAutonomy,
    tools: Vec<String>,
    steps: Vec<OperationalPlanStep>,
    constraints: Vec<String>,
    success_criteria: Vec<String>,
    stop_conditions: Vec<String>,
    approval_gates: Vec<String>,
    data_schema: Vec<String>,
}

impl OperationalPlan {
    fn start_step(&mut self, id: &str) {
        for step in &mut self.steps {
            if step.id == id {
                step.status = OperationalStepStatus::InProgress;
            }
        }
    }

    fn complete_step(&mut self, id: &str) {
        for step in &mut self.steps {
            if step.id == id {
                step.status = OperationalStepStatus::Completed;
            }
        }
    }

    fn block_step(&mut self, id: &str) {
        for step in &mut self.steps {
            if step.id == id {
                step.status = OperationalStepStatus::Blocked;
            }
        }
    }
}

fn operational_step(
    id: impl Into<String>,
    title: impl Into<String>,
    detail: impl Into<String>,
    tool: Option<&str>,
) -> OperationalPlanStep {
    OperationalPlanStep {
        id: id.into(),
        title: title.into(),
        detail: detail.into(),
        tool: tool.map(str::to_string),
        status: OperationalStepStatus::Pending,
    }
}

#[derive(Debug, Clone)]
struct TaskFinalAnswer {
    title: String,
    summary: String,
    findings: Vec<String>,
    sources: Vec<String>,
    limitations: Vec<String>,
    next_steps: Vec<String>,
}

impl TaskFinalAnswer {
    fn to_markdown(&self) -> String {
        let mut sections = Vec::new();
        sections.push(format!("**{}**\n\n{}", self.title, self.summary));
        if !self.findings.is_empty() {
            sections.push(format!(
                "**Risultato**\n{}",
                self.findings
                    .iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        if !self.sources.is_empty() {
            sections.push(format!(
                "**Fonti controllate**\n{}",
                self.sources
                    .iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        if !self.limitations.is_empty() {
            sections.push(format!(
                "**Limiti**\n{}",
                self.limitations
                    .iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        if !self.next_steps.is_empty() {
            sections.push(format!(
                "**Prossimo passo**\n{}",
                self.next_steps
                    .iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        sections.join("\n\n")
    }
}

#[derive(Debug, Serialize)]
struct ComputerArtifactPreviewResponse {
    artifact_id: String,
    title_redacted: String,
    kind: String,
    size_bytes: u64,
    data_url: String,
}

#[derive(Debug, Serialize)]
struct CapabilityConnectionResponse {
    id: String,
    provider_id: String,
    display_name: String,
    status: String,
    privacy_domains: Vec<String>,
    metadata: Value,
}

#[derive(Debug, Serialize)]
struct CapabilityToolResponse {
    provider_id: String,
    name: String,
    provider_kind: String,
    action: String,
    description: String,
    privacy_domains: Vec<String>,
    sensitivity: String,
}

#[derive(Debug, Serialize)]
struct CapabilityPolicyResponse {
    enabled_providers: Vec<String>,
    allow_managed_cloud: bool,
    privacy_domains: Vec<String>,
    max_autonomy_level: u8,
}

#[derive(Debug, Serialize)]
struct CapabilitySnapshotResponse {
    connections: Vec<CapabilityConnectionResponse>,
    tools: Vec<CapabilityToolResponse>,
    policy: CapabilityPolicyResponse,
}

#[derive(Debug, serde::Deserialize)]
struct RejectApprovalRequest {
    reason: String,
}

#[derive(Debug, serde::Deserialize)]
struct ApproveApprovalRequest {
    scope: Option<String>,
    browser_visibility: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskCreationMode {
    AutoFromPrompt,
    ExplicitMessageAction,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = env::var("LOCAL_FIRST_DESKTOP_GATEWAY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(18_765);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let state = AppState {
        http: reqwest::Client::new(),
        chat_store: Arc::new(Mutex::new(ChatStore::open(gateway_database_path()?)?)),
        task_store: Arc::new(Mutex::new(TaskStore::open(gateway_task_database_path()?)?)),
        computer_store: Arc::new(Mutex::new(LocalComputerSessionStore::open(
            gateway_local_computer_database_path()?,
        )?)),
        browser_url_policies: Arc::new(Mutex::new(BrowserUrlPolicyStore::open(
            gateway_browser_policy_database_path()?,
        )?)),
        memory_facade: Arc::new(Mutex::new(MemoryFacade::new(
            SQLiteMemoryStore::open(gateway_memory_database_path()?)
                .map_err(std::io::Error::other)?,
        ))),
        capability_registry: Arc::new(Mutex::new(open_seeded_capability_registry()?)),
        task_executor_status: Arc::new(Mutex::new(TaskExecutorStatus::new(
            task_executor_worker_enabled(),
        ))),
        task_executor_registry: TaskExecutorRegistry::with_defaults(),
        browser_capability_client: Arc::new(Mutex::new(None)),
        browser_thread_sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
        secret_store: Arc::new(open_gateway_secret_store()?),
        auth_token: resolve_gateway_auth_token()?.into(),
    };
    init_active_workspace_from_disk();
    start_task_executor_worker(state.clone());
    spawn_thread_browser_session_reaper(state.clone());
    let chat_routes = Router::new()
        .route(
            "/api/chat/threads",
            get(chat_threads).post(create_chat_thread),
        )
        .route(
            "/api/chat/threads/{thread_id}/select",
            post(select_chat_thread),
        )
        .route(
            "/api/chat/threads/{thread_id}/pin",
            post(set_chat_thread_pinned),
        )
        .route(
            "/api/chat/threads/{thread_id}/archive",
            post(archive_chat_thread),
        )
        .route(
            "/api/chat/threads/{thread_id}/unarchive",
            post(unarchive_chat_thread),
        )
        .route("/api/chat/threads/{thread_id}", delete(delete_chat_thread))
        .route("/api/chat/threads/{thread_id}/messages", get(chat_messages))
        .route(
            "/api/chat/threads/{thread_id}/messages/commit_prompt_result",
            post(commit_prompt_result),
        )
        .route(
            "/api/chat/threads/{thread_id}/messages/{message_id}/commit_continuation_result",
            post(commit_continuation_result),
        )
        .route(
            "/api/chat/threads/{thread_id}/messages/{message_id}/create_task",
            post(create_task_from_chat_message),
        )
        .route(
            "/api/chat/threads/{thread_id}/messages/{message_id}/save_to_memory",
            post(save_chat_message_to_memory),
        )
        .route("/api/chat/build_prompt", post(build_prompt))
        .route("/api/chat/generate_stream", post(generate_stream))
        .route("/api/chat/stream_resume/{request_id}", get(resume_stream))
        .route("/api/chat/improve_prompt", post(improve_prompt))
        .route("/api/chat/transcribe", post(transcribe_audio))
        .route("/api/artifacts/file", get(download_artifact).delete(delete_artifact_file))
        .route("/api/artifacts/path", get(artifact_folder_path))
        .route("/api/artifacts/usage", get(artifacts_usage))
        .route("/api/artifacts/thread", delete(delete_artifact_thread))
        .route("/api/artifacts/clear", post(clear_artifacts))
        .route(
            "/api/artifacts/destinations",
            get(list_artifact_destinations)
                .post(add_artifact_destination)
                .delete(remove_artifact_destination),
        )
        .route("/api/chat/suggestions", post(chat_suggestions))
        .route("/api/chat/threads/{thread_id}/autotitle", post(autotitle_chat_thread))
        .route(
            "/api/chat/threads/{thread_id}/folder",
            get(get_thread_folder).post(set_thread_folder),
        )
        .route("/api/chat/threads/{thread_id}/files", get(search_thread_files))
        .route("/api/chat/threads/{thread_id}/file", get(read_thread_file))
        .route("/api/runtime/model", get(runtime_model).post(set_runtime_model))
        .route("/api/runtime/models", get(runtime_models))
        .route(
            "/api/runtime/provider",
            get(runtime_provider).post(set_runtime_provider),
        )
        .route("/api/providers", get(list_providers).post(upsert_provider))
        .route("/api/providers/{id}", delete(remove_provider))
        .route("/api/providers/{id}/models", post(refresh_provider_models))
        .route(
            "/api/providers/{id}/generate-profiles",
            post(generate_provider_profiles),
        )
        .route("/api/providers/{id}/activate", post(activate_provider))
        .route("/api/model-profile", post(set_model_profile))
        .route("/api/roles", get(list_roles).post(set_role))
        .route("/api/routing-decisions", get(list_routing_decisions))
        .route("/api/skills", get(list_skills))
        .route("/api/skills/registry", get(registry_skills))
        .route("/api/skills/registry/install", post(install_registry_skill))
        .route("/api/skills/catalog", get(skill_catalog))
        .route("/api/skills/catalog/refresh", post(skill_catalog_refresh))
        .route("/api/skills/catalog/install", post(install_catalog_skill))
        .route("/api/skills/catalog/preview", get(preview_catalog_skill))
        .route("/api/skills/{id}", get(skill_detail))
        .route("/api/skills/{id}/enabled", post(set_skill_enabled))
        .route("/api/tasks/queue", get(task_queue))
        .route("/api/tasks/executor", get(task_executor_status))
        .route("/api/tasks/run_next", post(run_next_task))
        .route("/api/tasks/{task_id}", get(task_detail))
        .route(
            "/api/approvals/{approval_id}/approve",
            post(approve_approval),
        )
        .route("/api/approvals/{approval_id}/reject", post(reject_approval))
        .route(
            "/api/local-computer/sessions/{session_id}",
            get(local_computer_session),
        )
        .route(
            "/api/local-computer/sessions/{session_id}/artifacts/{artifact_id}/preview",
            get(local_computer_artifact_preview),
        )
        .route("/api/local-computer/live", get(contained_computer_live))
        .route("/api/system/status", get(system_status))
        .route("/api/system/browser/close-all", post(close_all_browsers))
        .route("/api/memory/dashboard", get(memory_dashboard))
        .route("/api/capabilities/snapshot", get(capability_snapshot))
        .route(
            "/api/workspaces",
            get(workspaces_list).post(create_workspace),
        )
        .route("/api/workspaces/{workspace_id}/select", post(select_workspace))
        .route("/api/workspaces/{workspace_id}/folder", post(set_workspace_folder))
        .route("/api/capabilities/mcp/connect", post(connect_mcp))
        .route("/api/capabilities/composio/connect", post(connect_composio))
        .route("/api/capabilities/composio/toolkits", get(composio_toolkits))
        .route("/api/capabilities/composio/link", post(composio_link))
        .route("/api/capabilities/composio/connections", get(composio_connections))
        .route("/api/capabilities/composio/execute", post(composio_execute))
        .route("/api/capabilities/composio/allowed-tools", get(composio_allowed_tools))
        .route(
            "/api/capabilities/composio/allowed-tools/{slug}",
            delete(composio_revoke_allowed_tool),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_gateway_token,
        ));
    let app = Router::new()
        .route("/api/health", get(health))
        .merge(chat_routes)
        .with_state(state)
        .layer(cors_layer());
    let listener = TcpListener::bind(addr).await?;
    println!("local-first-desktop-gateway listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "local-first-desktop-gateway",
        local_first: true,
        auth_required: !state.auth_token.is_empty(),
    })
}

async fn require_gateway_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Result<Response, GatewayError> {
    // The token is resolved deny-by-default at startup and is never empty; if it
    // somehow were, fail closed (reject) rather than open.
    let expected = format!("Bearer {}", state.auth_token);
    let authorized = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected);
    if authorized {
        Ok(next.run(request).await)
    } else {
        Err(GatewayError {
            status: StatusCode::UNAUTHORIZED,
            code: "gateway_unauthorized",
            message: "Missing or invalid Desktop Gateway token".to_string(),
        })
    }
}

async fn build_prompt(Json(request): Json<BuildPromptRequest>) -> Json<BuildPromptResponse> {
    Json(build_chat_runtime_prompt(&request))
}

async fn chat_threads(
    State(state): State<AppState>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .threads(&active_workspace_id())
            .map_err(GatewayError::store)?,
    ))
}

async fn create_chat_thread(
    State(state): State<AppState>,
) -> Result<Json<ChatThread>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .create_thread(&active_workspace_id())
            .map_err(GatewayError::store)?,
    ))
}

async fn select_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .select_thread(&thread_id)
            .map_err(GatewayError::store)?,
    ))
}

async fn set_chat_thread_pinned(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<SetThreadPinnedRequest>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .set_pinned(&thread_id, request.pinned)
            .map_err(GatewayError::store)?,
    ))
}

async fn archive_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    let snapshot = lock_store(&state)?
        .set_status(&thread_id, "archived")
        .map_err(GatewayError::store)?;
    // Archiving ends the thread → close its warm browser session.
    let st = state.clone();
    let tid = thread_id.clone();
    let _ = tokio::task::spawn_blocking(move || close_thread_browser_session(&st, &tid)).await;
    Ok(Json(snapshot))
}

async fn unarchive_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .set_status(&thread_id, "active")
            .map_err(GatewayError::store)?,
    ))
}

async fn delete_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    let snapshot = lock_store(&state)?
        .delete_thread(&thread_id)
        .map_err(GatewayError::store)?;
    // Deleting ends the thread → close its warm browser session.
    let st = state.clone();
    let tid = thread_id.clone();
    let _ = tokio::task::spawn_blocking(move || close_thread_browser_session(&st, &tid)).await;
    // Also drop the thread's generated artifacts so they don't fill the disk.
    let artifacts = sandbox::artifacts_dir().join(artifact_thread_slug(Some(&thread_id)));
    let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&artifacts)).await;
    Ok(Json(snapshot))
}

async fn chat_messages(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
) -> Result<Json<ChatMessagesSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .messages(&thread_id)
            .map_err(GatewayError::store)?,
    ))
}

async fn commit_prompt_result(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<CommitPromptResultRequest>,
) -> Result<Json<ChatMessagesSnapshot>, GatewayError> {
    // Just persist the streamed result. We no longer keyword-sniff the prompt to
    // auto-spawn a durable operational task here: the streaming tool-calling chat
    // has already done the model-driven work, so a keyword-matched task was
    // redundant (and was pure keyword-activation, against de-gemma).
    let snapshot = lock_store(&state)?
        .commit_prompt_result(
            &thread_id,
            &request.user_message,
            &request.assistant_message,
        )
        .map_err(GatewayError::store)?;
    Ok(Json(snapshot))
}

async fn commit_continuation_result(
    State(state): State<AppState>,
    Path((thread_id, message_id)): Path<(String, String)>,
    Json(request): Json<CommitContinuationResultRequest>,
) -> Result<Json<ChatMessagesSnapshot>, GatewayError> {
    Ok(Json(
        lock_store(&state)?
            .commit_continuation_result(&thread_id, &message_id, &request.assistant_message)
            .map_err(GatewayError::store)?,
    ))
}

async fn create_task_from_chat_message(
    State(state): State<AppState>,
    Path((thread_id, message_id)): Path<(String, String)>,
) -> Result<Json<ChatMessagesSnapshot>, GatewayError> {
    let message = lock_store(&state)?
        .message(&thread_id, &message_id)
        .map_err(GatewayError::store)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "chat_message_not_found",
            message: format!("chat message not found: {message_id}"),
        })?;
    // Model-driven (Brain) planning when a capable backend is configured: the
    // OrchestratorBrain comprehends the message and materializes the right
    // durable tasks. Falls back to a single browser_task (de-keyworded) only if
    // the Brain is off or yields nothing. No keyword classification anywhere.
    let brain_task_ids = if brain_materialize_enabled() {
        let state_for_brain = state.clone();
        let thread_for_brain = thread_id.clone();
        let goal = message.text.clone();
        match tokio::task::spawn_blocking(move || {
            brain_materialize_tasks(&state_for_brain, &thread_for_brain, &goal)
        })
        .await
        {
            Ok(Ok(ids)) if !ids.is_empty() => Some(ids),
            Ok(Ok(_)) => None,
            Ok(Err(error)) => {
                eprintln!("brain_materialize (create_task): {}; using fallback", error.message);
                None
            }
            Err(join_error) => {
                eprintln!(
                    "brain_materialize (create_task) join error: {join_error}; using fallback"
                );
                None
            }
        }
    } else {
        None
    };
    if brain_task_ids.is_none() {
        ensure_operational_task_for_thread(
            &state,
            &thread_id,
            &message_id,
            &message.text,
            TaskCreationMode::ExplicitMessageAction,
        )?;
    }
    Ok(Json(
        lock_store(&state)?
            .messages(&thread_id)
            .map_err(GatewayError::store)?,
    ))
}

async fn save_chat_message_to_memory(
    State(state): State<AppState>,
    Path((thread_id, message_id)): Path<(String, String)>,
) -> Result<Json<ChatMessagesSnapshot>, GatewayError> {
    let message = lock_store(&state)?
        .message(&thread_id, &message_id)
        .map_err(GatewayError::store)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "chat_message_not_found",
            message: format!("chat message not found: {message_id}"),
        })?;
    let reference = persist_explicit_memory(&state, &thread_id, &message_id, &message.text)?;
    lock_store(&state)?
        .set_message_saved_memory_ref(&thread_id, &message_id, &reference.to_string())
        .map_err(GatewayError::store)?;
    Ok(Json(
        lock_store(&state)?
            .messages(&thread_id)
            .map_err(GatewayError::store)?,
    ))
}

/// P3 (write): an explicit "save to memory" persists the text as a CONFIRMED
/// memory record (the user's intent IS the confirmation, and `context_pack`
/// only returns Confirmed) and projects it to a human-readable, editable wiki
/// markdown page — the substance of memory per the design (markdown + graph,
/// indexed by SQLite). Both the dashboard and the Brain's context provider read
/// the same DB, so the fact becomes retrievable immediately.
fn persist_explicit_memory(
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    text: &str,
) -> Result<MemoryRef, GatewayError> {
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "desktop-chat".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "explicit_save_to_memory".to_string(),
    };
    let redacted = redact_sensitive_text(text);

    let facade = lock_memory_facade(state)?;
    let record = facade
        .create_memory_candidate(MemoryCreateRequest {
            request: lifecycle.clone(),
            memory_type: "note".to_string(),
            text: redacted.clone(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: MemoryDataSensitivity::Private,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({
                "source": "desktop_chat",
                "thread_id": thread_id,
                "message_id": message_id,
            }),
        })
        .map_err(|error| GatewayError::memory(error.to_string()))?;
    facade
        .confirm_memory(&lifecycle, &record.reference, "explicit user save")
        .map_err(|error| GatewayError::memory(error.to_string()))?;

    let wiki = WikiFileStore::new(gateway_memory_wiki_dir().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "memory_wiki_dir",
        message: error.to_string(),
    })?);
    let page = WikiPage {
        reference: MemoryRef::generated(MemoryRefKind::Wiki, user.clone(), workspace.clone()),
        user_id: user,
        workspace_id: workspace,
        path: format!("notes/{}.md", sanitize_wiki_filename(&record.reference.to_string())),
        title: wiki_title_from_text(&redacted),
        body: redacted,
        linked_refs: vec![record.reference.clone()],
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity: MemoryDataSensitivity::Private,
    };
    facade
        .project_to_wiki(&wiki, &MemoryWikiProjection { page })
        .map_err(|error| GatewayError::memory(error.to_string()))?;

    Ok(record.reference)
}

/// Short human title for a wiki note: first non-empty line, bounded length.
fn wiki_title_from_text(text: &str) -> String {
    let first = text.lines().find(|line| !line.trim().is_empty()).unwrap_or("Nota");
    let trimmed = first.trim();
    if trimmed.chars().count() <= 60 {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(57).collect::<String>())
    }
}

/// Filesystem-safe wiki filename (refs can carry `:`/`/`).
fn sanitize_wiki_filename(reference: &str) -> String {
    reference
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

async fn generate_stream(
    State(state): State<AppState>,
    Json(request): Json<ChatGenerateStreamRequest>,
) -> Result<Response, GatewayError> {
    // Chat runs through the configured OpenAI-compatible provider. The local
    // MLX/Gemma fallback was removed: a provider is required.
    if let Some((base_url, mut model, api_key)) = chat_openai_stream_config() {
        // Per-message model override (inline composer selector): use the chosen
        // model for THIS request only, keeping the same provider/base_url/api_key.
        if let Some(override_model) = request.model.as_ref().map(|m| m.trim()).filter(|m| !m.is_empty()) {
            model = override_model.to_string();
        }
        return stream_chat_via_openai(&state, request, base_url, model, api_key).await;
    }
    Err(GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "no_inference_provider",
        message: "Nessun provider configurato. Imposta un endpoint OpenAI-compatibile in \
Impostazioni → Modello & Runtime."
            .to_string(),
    })
}

#[derive(Debug, Deserialize)]
struct ImprovePromptRequest {
    prompt: String,
}

#[derive(Debug, Serialize)]
struct ImprovePromptResponse {
    improved: String,
}

/// Rewrites a draft prompt into a clearer, more complete instruction (the ✨
/// "improve prompt" composer action). A single non-streaming LLM call: returns
/// ONLY the rewritten prompt, same language, no preamble. The provider config is
/// the same one chat uses.
async fn improve_prompt(
    State(state): State<AppState>,
    Json(request): Json<ImprovePromptRequest>,
) -> Result<Json<ImprovePromptResponse>, GatewayError> {
    let draft = request.prompt.trim();
    if draft.is_empty() {
        return Ok(Json(ImprovePromptResponse { improved: String::new() }));
    }
    let (base_url, model, api_key) = chat_openai_stream_config().ok_or_else(|| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "no_inference_provider",
        message: "Nessun provider configurato.".to_string(),
    })?;
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let system = "Sei un assistente che RISCRIVE i prompt per renderli più chiari, specifici e \
completi, SENZA eseguirli e senza rispondere alla richiesta. Mantieni la STESSA lingua e \
l'intento dell'utente; esplicita criteri, vincoli e formato atteso solo se impliciti. \
Restituisci SOLO il prompt riscritto, in testo semplice, senza preamboli, virgolette o spiegazioni.";
    let payload = serde_json::json!({
        "model": model,
        "temperature": 0.3,
        "max_tokens": 600,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": format!("Riscrivi questo prompt:\n\n{draft}") },
        ],
    });
    let mut builder = state.http.post(&endpoint).timeout(std::time::Duration::from_secs(30));
    if let Some(key) = api_key.as_ref() {
        builder = builder.bearer_auth(key);
    }
    let resp = builder.json(&payload).send().await.map_err(|error| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "improve_prompt_failed",
        message: format!("Provider non raggiungibile: {error}"),
    })?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "improve_prompt_failed",
            message: format!("Provider ha risposto {status}"),
        });
    }
    let body: serde_json::Value = resp.json().await.map_err(|error| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "improve_prompt_failed",
        message: format!("Risposta non valida: {error}"),
    })?;
    let improved = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .to_string();
    let improved = if improved.is_empty() { draft.to_string() } else { improved };
    Ok(Json(ImprovePromptResponse { improved }))
}

#[derive(Debug, Deserialize)]
struct SuggestionsRequest {
    prompt: String,
    answer: String,
}

#[derive(Debug, Serialize)]
struct SuggestionsResponse {
    suggestions: Vec<String>,
}

/// Proposes a few short follow-up prompts the user might ask next, given the last
/// exchange (the ✦ dynamic suggestions under the latest answer). One cheap
/// non-streaming LLM call; best-effort (empty list on any failure).
async fn chat_suggestions(
    State(state): State<AppState>,
    Json(request): Json<SuggestionsRequest>,
) -> Json<SuggestionsResponse> {
    let empty = Json(SuggestionsResponse { suggestions: Vec::new() });
    let Some((base_url, model, api_key)) = chat_openai_stream_config() else {
        return empty;
    };
    if request.answer.trim().is_empty() {
        return empty;
    }
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let system = "Proponi 3 BREVI domande di follow-up che l'utente potrebbe porre DOPO questa \
risposta. Regole: una per riga, massimo ~7 parole, nella STESSA lingua dell'utente, formulate \
come se le scrivesse l'utente, senza numerazione, trattini o virgolette. Restituisci SOLO le 3 righe.";
    let user = format!(
        "Richiesta utente:\n{}\n\nRisposta assistente:\n{}",
        request.prompt.chars().take(2000).collect::<String>(),
        request.answer.chars().take(4000).collect::<String>()
    );
    let payload = serde_json::json!({
        "model": model,
        "temperature": 0.5,
        "max_tokens": 160,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let mut builder = state.http.post(&endpoint).timeout(std::time::Duration::from_secs(25));
    if let Some(key) = api_key.as_ref() {
        builder = builder.bearer_auth(key);
    }
    let Ok(resp) = builder.json(&payload).send().await else {
        return empty;
    };
    if !resp.status().is_success() {
        return empty;
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return empty;
    };
    let content = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let suggestions = content
        .lines()
        .map(|line| {
            line.trim()
                .trim_start_matches(|c: char| {
                    c == '-' || c == '*' || c == '•' || c.is_ascii_digit() || c == '.' || c == ')'
                })
                .trim()
                .trim_matches('"')
                .trim()
                .to_string()
        })
        .filter(|line| !line.is_empty())
        .take(3)
        .collect();
    Json(SuggestionsResponse { suggestions })
}

#[derive(Debug, Deserialize)]
struct AutoTitleRequest {
    prompt: String,
    #[serde(default)]
    answer: String,
}

/// Generates a concise thread title from the first exchange (LLM), with a plain
/// fallback. Returns a short single line.
async fn generate_thread_title(state: &AppState, prompt: &str, answer: &str) -> String {
    let fallback = || {
        let base = prompt.trim();
        if base.is_empty() {
            "Nuova chat".to_string()
        } else {
            base.chars().take(48).collect::<String>()
        }
    };
    let Some((base_url, model, api_key)) = chat_openai_stream_config() else {
        return fallback();
    };
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let system = "Genera un TITOLO brevissimo (max 5 parole) per questa conversazione, nella \
stessa lingua dell'utente. Solo il titolo, senza virgolette, punteggiatura finale o prefissi.";
    let user = format!(
        "Primo messaggio:\n{}\n\nRisposta:\n{}",
        prompt.chars().take(1500).collect::<String>(),
        answer.chars().take(1500).collect::<String>()
    );
    let payload = serde_json::json!({
        "model": model,
        "temperature": 0.3,
        "max_tokens": 24,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let mut builder = state.http.post(&endpoint).timeout(std::time::Duration::from_secs(20));
    if let Some(key) = api_key.as_ref() {
        builder = builder.bearer_auth(key);
    }
    let title = match builder.json(&payload).send().await {
        Ok(resp) if resp.status().is_success() => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|b| {
                b.get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("message"))
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                    .map(|s| s.trim().trim_matches('"').lines().next().unwrap_or("").trim().to_string())
            })
            .unwrap_or_default(),
        _ => String::new(),
    };
    if title.is_empty() {
        fallback()
    } else {
        title.chars().take(60).collect()
    }
}

/// Auto-titles a thread from its first exchange (LLM), persisting the result.
async fn autotitle_chat_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Json(request): Json<AutoTitleRequest>,
) -> Result<Json<ChatThreadSnapshot>, GatewayError> {
    let title = generate_thread_title(&state, &request.prompt, &request.answer).await;
    Ok(Json(
        lock_store(&state)?
            .rename_thread(&thread_id, &title)
            .map_err(GatewayError::store)?,
    ))
}

#[derive(Debug, Deserialize)]
struct TranscribeRequest {
    /// Base64-encoded audio (any ffmpeg-decodable container, e.g. webm/opus).
    audio_base64: String,
    /// Optional language hint; omitted → Whisper auto-detects (multilingual).
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, Serialize)]
struct TranscribeResponse {
    text: String,
    language: Option<String>,
}

/// On-device speech-to-text (dictation 🎤). Decodes the audio and forwards it to
/// the warm faster-whisper server inside the contained computer (CPU, private,
/// multilingual). Brings the container up first if needed.
async fn transcribe_audio(
    State(state): State<AppState>,
    Json(request): Json<TranscribeRequest>,
) -> Result<Json<TranscribeResponse>, GatewayError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(request.audio_base64.as_bytes())
        .map_err(|e| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "bad_audio",
            message: format!("Audio non valido: {e}"),
        })?;
    if bytes.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "bad_audio",
            message: "Audio vuoto.".to_string(),
        });
    }
    // Ensure the contained computer (and its Whisper server) is running.
    tokio::task::spawn_blocking(sandbox::ensure_contained_computer)
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "sandbox",
            message: e.to_string(),
        })?
        .map_err(|e| GatewayError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "sandbox",
            message: e,
        })?;
    let url = format!("{}/transcribe", sandbox::whisper_base_url());
    let mut builder = state
        .http
        .post(&url)
        // Generous: the FIRST call downloads the model (~1.5GB) + loads it.
        .timeout(std::time::Duration::from_secs(300))
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(bytes);
    if let Some(lang) = request.language.as_ref().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        builder = builder.header("X-Language", lang);
    }
    let resp = builder.send().await.map_err(|e| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "transcribe_failed",
        message: format!("Server STT non raggiungibile: {e}"),
    })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "transcribe_failed",
            message: format!("STT ha risposto {status}: {}", body.chars().take(200).collect::<String>()),
        });
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "transcribe_failed",
        message: format!("Risposta STT non valida: {e}"),
    })?;
    Ok(Json(TranscribeResponse {
        text: body.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string(),
        language: body.get("language").and_then(|l| l.as_str()).map(String::from),
    }))
}

/// Chat streaming config when an OpenAI-compatible backend is selected
/// (`LOCAL_FIRST_INFERENCE_BACKEND=openai` + base URL). Returns
/// `(base_url, model, api_key)`, else `None` when no inference provider is configured.
/// File holding the user-selected active inference model (overrides the env
/// default). Plain text, not a secret. Lets Settings switch model at runtime.
fn inference_model_override_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("active-inference-model"))
}

fn persisted_inference_model() -> Option<String> {
    let path = inference_model_override_path()?;
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn set_persisted_inference_model(model: &str) -> std::io::Result<()> {
    let path = inference_model_override_path()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no data dir"))?;
    fs::write(path, model.trim())
}

/// The active inference model: the registry's active provider model wins, then
/// the legacy persisted/env default. Read fresh each call, so a Settings change
/// applies to the next chat with no restart.
fn active_inference_model() -> String {
    if let Some(model) = load_provider_registry()
        .active()
        .and_then(|provider| provider.effective_model())
    {
        return model;
    }
    active_inference_model_legacy().unwrap_or_else(|| "gpt-4o-mini".to_string())
}

/// User-configured provider base URL (any OpenAI-compatible API: OpenAI,
/// OpenRouter, Together, Ollama, …), persisted in the data dir.
fn inference_base_url_override_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("active-inference-base-url"))
}

fn persisted_inference_base_url() -> Option<String> {
    let path = inference_base_url_override_path()?;
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn set_persisted_inference_base_url(url: &str) -> std::io::Result<()> {
    let path = inference_base_url_override_path()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no data dir"))?;
    fs::write(path, url.trim())
}

/// Secret reference for the user-configured inference provider API key.
fn inference_secret_ref() -> Option<SecretRef> {
    SecretRef::new(
        gateway_user_id().as_str(),
        gateway_workspace_id().as_str(),
        "inference",
        "default",
    )
    .ok()
}

/// API key for the configured provider, read from the encrypted secret store.
fn persisted_inference_api_key() -> Option<String> {
    let store = open_gateway_secret_store().ok()?;
    let reference = inference_secret_ref()?;
    let material = store.get(&reference).ok()??;
    material.expose_utf8().ok().filter(|value| !value.is_empty())
}

fn set_persisted_inference_api_key(key: &str) -> Result<(), String> {
    let store = open_gateway_secret_store().map_err(|error| error.to_string())?;
    let reference = inference_secret_ref().ok_or_else(|| "invalid secret ref".to_string())?;
    store
        .put(reference, SecretMaterial::from_string(key))
        .map(|_| ())
        .map_err(|error| error.to_string())
}

// ── Provider registry (Phase 1: multi-provider inference) ──────────────────

use model_registry::{
    ProviderEntry, ProviderKind, ProviderRegistry, ResolvedRole, RoleBinding,
};

fn provider_registry_path() -> Option<PathBuf> {
    gateway_data_dir().ok().map(|dir| dir.join("providers.json"))
}

/// Per-provider API-key reference in the encrypted secret store (keyed by id).
fn provider_secret_ref(provider_id: &str) -> Option<SecretRef> {
    SecretRef::new(
        gateway_user_id().as_str(),
        gateway_workspace_id().as_str(),
        "inference",
        provider_id,
    )
    .ok()
}

fn provider_api_key(provider_id: &str) -> Option<String> {
    let store = open_gateway_secret_store().ok()?;
    let reference = provider_secret_ref(provider_id)?;
    let material = store.get(&reference).ok()??;
    material.expose_utf8().ok().filter(|value| !value.is_empty())
}

fn set_provider_api_key(provider_id: &str, key: &str) -> Result<(), String> {
    let store = open_gateway_secret_store().map_err(|error| error.to_string())?;
    let reference = provider_secret_ref(provider_id).ok_or_else(|| "invalid secret ref".to_string())?;
    store
        .put(reference, SecretMaterial::from_string(key))
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn delete_provider_api_key(provider_id: &str) {
    if let (Ok(store), Some(reference)) =
        (open_gateway_secret_store(), provider_secret_ref(provider_id))
    {
        let _ = store.delete(&reference);
    }
}

/// Loads the persisted registry, or seeds an in-memory one from the legacy
/// single-provider config / env so a fresh install already shows e.g. Ollama.
/// Seeding is NOT persisted until the user makes a change (a POST).
fn load_provider_registry() -> ProviderRegistry {
    if let Some(path) = provider_registry_path()
        && let Ok(contents) = fs::read_to_string(&path)
        && let Ok(registry) = serde_json::from_str::<ProviderRegistry>(&contents)
        && !registry.providers.is_empty()
    {
        return registry;
    }
    seed_registry_from_legacy()
}

/// Builds a one-provider registry from the legacy persisted base URL / env, so
/// the current setup appears as a managed provider with no migration step.
fn seed_registry_from_legacy() -> ProviderRegistry {
    let mut registry = ProviderRegistry::default();
    let base_url = persisted_inference_base_url()
        .or_else(|| env::var("LOCAL_FIRST_INFERENCE_BASE_URL").ok())
        .filter(|value| !value.is_empty());
    let Some(base_url) = base_url else {
        return registry;
    };
    let backend = env::var("LOCAL_FIRST_INFERENCE_BACKEND")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let (id, label, kind) = if backend == "anthropic" {
        ("anthropic", "Anthropic", ProviderKind::Anthropic)
    } else if base_url.contains("11434") || backend == "ollama" {
        ("ollama", "Ollama (locale)", ProviderKind::Ollama)
    } else {
        ("default", "Provider", ProviderKind::OpenaiCompat)
    };
    let mut entry = ProviderEntry::new(id.to_string(), label.to_string(), kind, base_url);
    entry.active_model = active_inference_model_legacy();
    registry.upsert(entry);
    registry
}

fn save_provider_registry(registry: &ProviderRegistry) -> Result<(), String> {
    let path = provider_registry_path().ok_or_else(|| "no data dir".to_string())?;
    let json = serde_json::to_string_pretty(registry).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

/// Legacy single-model resolver (persisted file / env), kept as the fallback for
/// the registry-aware [`active_inference_model`].
fn active_inference_model_legacy() -> Option<String> {
    persisted_inference_model()
        .or_else(|| env::var("LOCAL_FIRST_INFERENCE_MODEL").ok())
        .filter(|value| !value.is_empty())
}

/// The effective OpenAI-compatible base URL: the registry's active provider wins,
/// then the legacy persisted/env config. With MLX removed this (or env) is required.
fn effective_inference_base_url() -> Option<String> {
    if let Some(provider) = load_provider_registry().active() {
        return Some(provider.base_url.clone());
    }
    persisted_inference_base_url().or_else(|| {
        env::var("LOCAL_FIRST_INFERENCE_BASE_URL")
            .ok()
            .filter(|value| !value.is_empty())
    })
}

/// Chat streaming config: the "orchestrator" role (general app management) wins,
/// then the legacy active-provider/env config. Resolved fresh each call so a
/// Settings change applies to the next chat with no restart.
fn chat_openai_stream_config() -> Option<(String, String, Option<String>)> {
    if let Some(resolved) = load_provider_registry().resolve_role("orchestrator") {
        let api_key = provider_api_key(&resolved.provider_id).or_else(env_inference_api_key);
        return Some((resolved.base_url, resolved.model, api_key));
    }
    let base_url = effective_inference_base_url()?;
    Some((base_url, active_inference_model(), resolve_inference_api_key()))
}

/// Chat context-char budget for the capable backend, derived from the model's
/// context window (`LOCAL_FIRST_INFERENCE_CONTEXT_WINDOW`, default 32k tokens).
/// ~3 chars/token leaves headroom for the system prompt and the model's reply;
/// it is vastly larger than the earlier 3.6K small-model default so chat history is not
/// clamped on a model that can read it.
fn chat_context_budget_chars() -> usize {
    let window = env::var("LOCAL_FIRST_INFERENCE_CONTEXT_WINDOW")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|tokens| *tokens > 0)
        .unwrap_or(32_768);
    window.saturating_mul(3)
}

/// Streams a chat completion from an OpenAI-compatible endpoint, translating its
/// SSE deltas into the gateway's NDJSON `GenerateStreamEvent` format the UI
/// already consumes, so every backend looks the same to the UI.
/// Max model↔tool round-trips. The LAST round forbids tools (tool_choice:none) so
/// the model always synthesizes a final answer from what it gathered. With 3:
/// up to 2 tool calls (search + optional follow-up), then a forced answer.
/// Max model↔tool rounds. Allows discovery (find_connected_tools) → execute →
/// synthesize without starving the final answer.
const MAX_TOOL_ROUNDS: usize = 5;
/// How many connected-service tools to pull into the searchable catalog (NOT
/// sent to the model — only searched by `find_connected_tools`).
const COMPOSIO_CATALOG_CAP: usize = 200;
/// How many tools `find_connected_tools` returns (and injects) per search.
const COMPOSIO_DISCOVERY_RESULTS: usize = 8;
/// Cap on a Composio tool result fed back to the model (email bodies can be huge).
const COMPOSIO_RESULT_CHARS: usize = 6000;

/// The browser tool the chat model can invoke. No keyword gate: the MODEL reads
/// this description and decides to call it when the request needs the live web.
fn browse_web_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "browse_web",
            "description": "Naviga il web con un browser reale e contenuto (non headless) per raggiungere un obiettivo concreto e riportare ciò che trovi (orari, prezzi, risultati, contenuti di pagina). USA questo strumento per QUALSIASI richiesta che richieda dati dal web in tempo reale o azioni nel browser (voli, treni, prezzi, ricerche, prenotazioni, consultare un sito) invece di rispondere che non hai accesso a internet.",
            "parameters": {
                "type": "object",
                "properties": {
                    "goal": {
                        "type": "string",
                        "description": "Obiettivo concreto e autonomo da raggiungere nel browser, es: 'cerca voli da Milano a Napoli per il 10 giugno e riporta orari e prezzi'."
                    }
                },
                "required": ["goal"]
            }
        }
    })
}

/// Enabled installed skills as (id, name, description) for prompt discovery (L1).
fn enabled_skills_summary() -> Vec<(String, String, String)> {
    let Ok(dir) = skills_dir() else {
        return Vec::new();
    };
    let disabled = load_skills_disabled();
    let origins = load_skills_origins();
    skills::scan_skills(&dir, &disabled, &origins)
        .into_iter()
        .filter(|s| s.enabled)
        .map(|s| (s.id, s.name, s.description))
        .collect()
}

/// Loads an installed skill's SKILL.md body (instructions) by id.
fn load_skill_body(id: &str) -> Option<String> {
    let dir = skills_dir().ok()?;
    let disabled = load_skills_disabled();
    let origins = load_skills_origins();
    skills::load_detail(&dir, id, &disabled, &origins)
        .ok()
        .flatten()
        .map(|detail| adapt_skill_body(&detail.body, id))
}

/// Extracts a skill id from a sandbox command that references the container skill
/// path `/home/agent/skills/<id>/…`, so we can sync that skill's files even when
/// the model omitted the `skill_id` argument.
fn skill_id_from_command(command: &str) -> Option<String> {
    let marker = "/home/agent/skills/";
    let start = command.find(marker)? + marker.len();
    let rest = &command[start..];
    let id: String = rest
        .chars()
        .take_while(|c| *c != '/' && *c != ' ' && *c != '"' && *c != '\'')
        .collect();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Adapts a skill's SKILL.md for execution in the contained computer: substitutes
/// the `{baseDir}` template variable (and common aliases) with the skill's real
/// path inside the container, so commands like `python3 {baseDir}/scripts/x.py`
/// resolve. This is the runtime "skill adaptation" step.
fn adapt_skill_body(body: &str, id: &str) -> String {
    let base = sandbox::container_skill_dir(id);
    body.replace("{baseDir}", &base)
        .replace("${baseDir}", &base)
        .replace("{base_dir}", &base)
        .replace("{BASE_DIR}", &base)
        .replace("$BASEDIR", &base)
}

/// The skill-activation tool: loads a skill's full SKILL.md instructions on demand
/// (progressive disclosure L2).
fn use_skill_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "use_skill",
            "description": "Carica le istruzioni complete (SKILL.md) di una skill installata, dato il suo id. Chiamalo quando la richiesta corrisponde a una skill elencata in SKILL INSTALLATE, poi segui le istruzioni ricevute.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "id della skill, es. 'weather'" }
                },
                "required": ["id"]
            }
        }
    })
}

/// The skill-execution tool: runs a shell command from a skill's instructions
/// inside the contained-computer sandbox.
fn run_in_sandbox_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "run_in_sandbox",
            "description": "Esegue un comando di shell nel computer contenuto (sandbox isolata con bash/curl/python). Usalo per eseguire i comandi indicati da una skill (es. 'curl -s wttr.in/Roma?format=3'). Restituisce l'output del comando.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Comando shell da eseguire, es. \"curl -s wttr.in/Roma?format=3\"" },
                    "skill_id": { "type": "string", "description": "id della skill di contesto (opzionale; imposta la working dir)" }
                },
                "required": ["command"]
            }
        }
    })
}

/// Tool for the model to author a document/code artifact directly (no skill):
/// writes the content to the conversation's output area and surfaces it as an
/// artifact (card + workspace panel).
fn create_artifact_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "create_artifact",
            "description": "Crea un file 'artifact' (documento, codice, markdown, csv, html, json, testo) scrivendone il contenuto completo. Il file appare come artifact scaricabile e anteprimabile nella chat (pannello File). Usalo quando l'utente chiede di PRODURRE un documento o del codice da consegnare, invece di incollarlo solo nel messaggio.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Nome file con estensione, es. \"report.md\", \"script.py\", \"dati.csv\"" },
                    "content": { "type": "string", "description": "Contenuto testuale COMPLETO del file" }
                },
                "required": ["name", "content"]
            }
        }
    })
}

/// Tool to deliver a generated artifact to a user-authorized destination folder.
/// The gateway performs the copy host-side, scoped to granted destinations only.
fn save_artifact_tool_schema(destinations: &[ArtifactDestination]) -> serde_json::Value {
    let labels = destinations
        .iter()
        .map(|d| d.label.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "save_artifact",
            "description": format!(
                "Copia un file generato (artifact, salvato in $OUTPUT_DIR) in una cartella di \
destinazione AUTORIZZATA dall'utente. Destinazioni disponibili: {labels}. Usalo quando l'utente \
chiede di salvare/esportare un file in una cartella."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file": { "type": "string", "description": "Nome del file artifact da copiare, es. \"report.xlsx\"" },
                    "destination": { "type": "string", "description": format!("Etichetta della destinazione tra: {labels}") }
                },
                "required": ["file", "destination"]
            }
        }
    })
}

/// The discovery meta-tool: the model searches connected-service tools by intent
/// instead of receiving all of them up front (progressive tool disclosure).
fn find_connected_tools_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "find_connected_tools",
            "description": "Cerca tra gli strumenti dei servizi collegati dall'utente (Gmail, Google Calendar, …) quelli adatti all'intento. Restituisce gli strumenti rilevanti, che diventano poi richiamabili. Chiamalo PRIMA di dire che non hai accesso a un servizio.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Intento o parole chiave, es. 'unread emails', 'calendar events today', 'send email'."
                    }
                },
                "required": ["query"]
            }
        }
    })
}

/// Keyword search over the connected-tool catalog. Scores each tool by how many
/// query tokens appear in its "slug + description" haystack; returns the top `k`
/// as (slug, schema). An empty query returns the first `k` (a sensible browse).
fn search_composio_catalog(
    index: &[(String, String, serde_json::Value)],
    query: &str,
    k: usize,
) -> Vec<(String, serde_json::Value)> {
    let tokens: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3)
        .map(str::to_string)
        .collect();
    let mut scored: Vec<(usize, &(String, String, serde_json::Value))> = index
        .iter()
        .map(|entry| {
            let score = if tokens.is_empty() {
                1
            } else {
                tokens.iter().filter(|t| entry.1.contains(t.as_str())).count()
            };
            (score, entry)
        })
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.into_iter().take(k).map(|(_, e)| (e.0.clone(), e.2.clone())).collect()
}

/// Capable (OpenAI-compatible) chat path with NATIVE TOOL-CALLING. The model is
/// given real tools and decides when to use them (no keyword routing). Tool
/// rounds run non-streamed; the final assistant answer is emitted as Delta+Done
/// to match the existing UI stream protocol.
async fn stream_chat_via_openai(
    state: &AppState,
    request: ChatGenerateStreamRequest,
    base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<Response, GatewayError> {
    let prompt = build_chat_runtime_prompt(&BuildPromptRequest {
        prompt: request.prompt.clone(),
        context: request.context.clone(),
        max_context_chars: Some(chat_context_budget_chars()),
    })
    .runtime_prompt;

    let system = format!(
        "Sei l'assistente locale e agisci come ORCHESTRATORE. Oggi è {today}: usa \
SEMPRE questa data per risolvere richieste temporali (es. \"10 giugno\" = il 10 \
giugno dell'anno corretto rispetto a oggi, sempre nel futuro). Hai accesso a un \
browser reale e contenuto tramite lo strumento browse_web.\n\
\n\
METODO (vale per qualsiasi richiesta, non solo viaggi):\n\
1. COMPRENDI: cosa vuole l'utente e qual è il RISULTATO concreto atteso.\n\
2. CRITERI DI SUCCESSO: definisci esplicitamente cosa significa \"fatto\" (quali \
dati/campi e quante opzioni servono). Includili SEMPRE nell'obiettivo di browse_web.\n\
3. CHIARIMENTI: se manca un parametro davvero bloccante e ambiguo, fai UNA sola \
domanda concisa PRIMA di cercare; altrimenti procedi con default sensati e \
DICHIARALI (non bloccare l'utente per dettagli minori).\n\
4. ESEGUI: quando servono dati dal web in tempo reale o azioni nel browser, DEVI \
usare browse_web (non dire che non hai accesso a internet). Chiama browse_web UNA \
SOLA VOLTA: nell'unico obiettivo includi il compito concreto con date esplicite \
(anno incluso), i CRITERI DI SUCCESSO, e 2-3 FONTI candidate in ordine di \
preferenza. È il browser stesso a provarle a turno (se una è bloccata/senza dati \
passa alla successiva). NON chiamare browse_web più volte per provare fonti diverse \
e NON ripetere la stessa ricerca.\n\
5. SINTETIZZA: appena ricevi il risultato del browser, scrivi la risposta finale \
all'utente. Se una fonte è risultata bloccata/vuota, dillo con onestà.\n\
\n\
OBIETTIVO AUTO-CONTENUTO (fondamentale): il browser NON conosce i messaggi \
precedenti. Ogni obiettivo di browse_web deve contenere TUTTI i parametri già \
risolti nella conversazione. Anche nei follow-up brevi (es. l'utente dice \"cerca \
anche su easyJet\" o \"e in treno?\"): NON passare \"cerca su easyJet\" da solo — \
passa l'obiettivo completo, es. \"Cerca su easyJet i voli da Milano a Napoli del 10 \
giugno 2026, solo andata; riporta orari, durata, scali, prezzo\". Ripeti sempre \
tratta/luogo, data con anno e vincoli.\n\
\n\
Viaggi: se l'utente NON chiede esplicitamente il ritorno, cerca SOLO ANDATA \
(one-way). Un passeggero salvo diversa indicazione.\n\
Quando riporti risultati (voli, treni, hotel, ...), sii ESAUSTIVO e SPECIFICO PER \
RIGA: ogni opzione è una riga a sé, MAI fondere opzioni diverse in una riga \
generica. Per i voli ogni riga DEVE indicare: compagnia aerea, aeroporto di \
partenza specifico (es. Malpensa/Linate/Bergamo, non solo \"Milano\") e di arrivo, \
orario di partenza e arrivo, durata, scali/cambi e prezzo. Se le opzioni sono di \
compagnie o aeroporti diversi, le colonne Compagnia e Aeroporto sono OBBLIGATORIE \
(non lasciare ambiguo a chi/da dove appartiene un prezzo). Usa una tabella e elenca \
più opzioni, non solo una.\n\
\n\
FORMATTAZIONE DELLA RISPOSTA (markdown, sempre): scrivi risposte leggibili e ariose, \
mai un muro di testo. Usa SEMPRE markdown: ogni elemento di un elenco va su una RIGA \
A SÉ con `- ` (trattino) — non incollare più voci sulla stessa riga. Per elenchi \
giorno/voce con etichetta usa `**Etichetta**: valore` con una riga vuota tra le voci, \
o una tabella se i campi sono ≥3. Metti una riga vuota tra i paragrafi. Usa `### ` per \
i titoli di sezione quando la risposta è lunga. Rispondi in italiano, chiaro e ordinato.",
        today = today_iso()
    );
    // Connected-service (Composio) tools are reached via a DISCOVERY meta-tool
    // (`find_connected_tools`), not dumped into the prompt: the model searches by
    // intent, we return the few relevant tools and inject their schemas for the
    // next round. Keeps the prompt small and scales to hundreds of tools — the
    // pattern Composio/Claude use.
    let catalog = {
        let st = state.clone();
        tokio::task::spawn_blocking(move || composio_chat_tools(&st, COMPOSIO_CATALOG_CAP))
            .await
            .unwrap_or_default()
    };
    let composio_writes = catalog.writes.clone();
    // (slug, lowercased "slug + description" haystack, schema) for keyword search.
    let catalog_index: Vec<(String, String, serde_json::Value)> = catalog
        .schemas
        .iter()
        .filter_map(|s| {
            let f = s.get("function")?;
            let name = f.get("name")?.as_str()?.to_string();
            let desc = f.get("description").and_then(|d| d.as_str()).unwrap_or("");
            let haystack = format!("{name} {desc}").to_lowercase();
            Some((name, haystack, s.clone()))
        })
        .collect();
    let has_composio = !catalog_index.is_empty();
    let system = if !has_composio {
        system
    } else {
        format!(
            "{system}\n\nSTRUMENTI SERVIZI COLLEGATI: l'utente ha collegato dei servizi (es. Gmail, \
Google Calendar). Per accedervi NON dire che non puoi: chiama `find_connected_tools` con una query \
sull'intento (es. \"unread emails\", \"send email\", \"calendar events today\") per scoprire lo \
strumento adatto, poi CHIAMA lo strumento trovato con gli argomenti completi.\n\
AZIONI DI SCRITTURA (inviare/eliminare/modificare): CHIAMA comunque lo strumento con gli argomenti \
completi — il sistema mostrerà AUTOMATICAMENTE all'utente una card di conferma prima di eseguire. \
NON rifiutare, NON dire che non puoi inviare e NON chiedere all'utente di farlo manualmente: il tuo \
compito è chiamare lo strumento giusto, alla conferma pensa l'interfaccia.\n\
CONTEGGI (es. \"quante email non lette\"): usa il filtro corretto (per Gmail query \"is:unread\") e \
riporta il TOTALE indicato dal risultato (campo tipo resultSizeEstimate / total / nextPageToken \
assente), NON il numero di messaggi della singola pagina restituita; se il risultato è paginato e \
non dà un totale affidabile, dichiara che è una stima."
        )
    };
    // Installed skills (Anthropic Agent Skills, progressive disclosure L1): pre-load
    // name+description; the model calls `use_skill(<id>)` to pull the full SKILL.md
    // when a request matches, then follows it.
    let enabled_skills = tokio::task::spawn_blocking(enabled_skills_summary)
        .await
        .unwrap_or_default();
    let has_skills = !enabled_skills.is_empty();
    let system = if !has_skills {
        system
    } else {
        let lines = enabled_skills
            .iter()
            .map(|(id, name, desc)| format!("- {id}: {name} — {desc}"))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "{system}\n\nSKILL INSTALLATE — quando la richiesta corrisponde alla descrizione di una \
di queste, PREFERISCILA al browser: chiama `use_skill` con il suo id per ricevere le istruzioni \
complete (SKILL.md). Poi ESEGUI i comandi che la skill indica (es. `curl …`, `python …`) con lo \
strumento `run_in_sandbox`, che li lancia nel computer contenuto, e usa l'output per rispondere.\n\
FILE GENERATI: se una skill o un comando produce file (xlsx, pdf, csv, immagini, …), SALVALI nella \
cartella d'ambiente `$OUTPUT_DIR` (es. `... --output \"$OUTPUT_DIR/report.xlsx\"`): i file lì \
diventano automaticamente artifact scaricabili dall'utente.\n{lines}"
        )
    };
    // Authorized write destinations: when present, the model can deliver
    // generated files to user-granted folders via `save_artifact`.
    let artifact_destinations = load_artifact_destinations();
    let system = if artifact_destinations.is_empty() {
        system
    } else {
        let labels = artifact_destinations
            .iter()
            .map(|d| d.label.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "{system}\n\nCARTELLE DESTINAZIONE: puoi consegnare i file generati in queste cartelle \
AUTORIZZATE dall'utente con lo strumento `save_artifact`: {labels}. Quando l'utente chiede di \
salvare/esportare un file in una cartella, chiama save_artifact(file, destination)."
        )
    };
    let system = system.as_str();
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut base_tools = vec![browse_web_tool_schema(), create_artifact_tool_schema()];
    if has_composio {
        base_tools.push(find_connected_tools_schema());
    }
    if has_skills {
        base_tools.push(use_skill_tool_schema());
        base_tools.push(run_in_sandbox_tool_schema());
    }
    if !artifact_destinations.is_empty() {
        base_tools.push(save_artifact_tool_schema(&artifact_destinations));
    }
    // Vision: when the request carries images, the user message becomes
    // multimodal content (text + image_url parts) per the OpenAI-compatible
    // schema; otherwise it stays a plain string.
    let user_content = if request.images.is_empty() {
        serde_json::Value::String(prompt.clone())
    } else {
        let mut parts = vec![serde_json::json!({ "type": "text", "text": prompt })];
        for url in &request.images {
            parts.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": url }
            }));
        }
        serde_json::Value::Array(parts)
    };
    let mut messages = vec![
        serde_json::json!({ "role": "system", "content": system }),
        serde_json::json!({ "role": "user", "content": user_content }),
    ];

    let (mpsc_tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    // Resume registry entry: the generation records here so a reloaded client can
    // reattach to the in-flight answer (GET /api/chat/stream_resume/{id}).
    let (broadcast_tx, _) = tokio::sync::broadcast::channel::<String>(512);
    let stream_entry = std::sync::Arc::new(StreamEntry {
        lines: std::sync::Mutex::new(Vec::new()),
        tx: broadcast_tx,
        finished: std::sync::atomic::AtomicBool::new(false),
    });
    let resume_id = request.request_id.clone();
    if let Ok(mut map) = stream_registry().lock() {
        map.insert(resume_id.clone(), stream_entry.clone());
    }
    let tx = StreamSink { mpsc: mpsc_tx, entry: stream_entry };
    let http = state.http.clone();
    let state_owned = state.clone();
    let temperature = request.temperature;
    // Thread this chat belongs to: lets browser work reuse a persistent
    // per-thread browser session (search → then book on the same tab).
    let thread_id = request.thread_id.clone();
    tokio::spawn(async move {
        let mut accumulated = String::new();
        let mut final_done = false;
        // Source URLs visited via browse_web this request, for the "Fonti" footer.
        let mut browse_sources: Vec<String> = Vec::new();
        // Tools offered to the model this run: the base set, plus any tools the
        // model discovers via `find_connected_tools` (injected on demand).
        let mut tool_schemas = base_tools;
        let mut loaded_tools: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        // Fresh terminal buffer for this request; the computer panel shows the
        // CLI commands + output run during THIS response.
        sandbox_clear();

        for round in 0..MAX_TOOL_ROUNDS {
            // On the LAST allowed round, forbid tools so the model MUST synthesize
            // a final answer from what it already gathered — otherwise it can burn
            // every round on tool calls and end with no answer ("limite di passi").
            // On the LAST allowed round, OMIT tools entirely (do not rely on
            // tool_choice:"none" — minimax-via-Ollama ignores it and keeps calling
            // tools, so the loop never synthesizes and ends with "limite di passi").
            // Omitting the tools field forces a text answer.
            let is_final_round = round + 1 >= MAX_TOOL_ROUNDS;
            let mut payload = serde_json::json!({
                "model": model,
                "messages": messages,
                "temperature": temperature,
                // Reasoning models need room for CoT + the final answer; without
                // a budget the synthesis came back empty (same starvation as the
                // planner). Generous so the final table isn't cut off.
                "max_tokens": 6000,
                "stream": false,
            });
            if !is_final_round {
                payload["tools"] = serde_json::Value::Array(tool_schemas.clone());
                payload["tool_choice"] = serde_json::Value::String("auto".to_string());
            }
            let mut builder = http.post(&endpoint);
            if let Some(key) = api_key.as_ref() {
                builder = builder.bearer_auth(key);
            }
            let resp = builder.json(&payload).send().await;
            let resp = match resp {
                Ok(value) => value,
                Err(error) => {
                    let _ = emit_stream_event(
                        &tx,
                        GenerateStreamEvent::Delta {
                            text: format!("Errore di rete verso il modello: {error}"),
                        },
                    )
                    .await;
                    break;
                }
            };
            if !resp.status().is_success() {
                let code = resp.status();
                let detail = resp.text().await.unwrap_or_default();
                let _ = emit_stream_event(
                    &tx,
                    GenerateStreamEvent::Delta {
                        text: format!(
                            "Errore modello {code}: {}",
                            detail.chars().take(200).collect::<String>()
                        ),
                    },
                )
                .await;
                break;
            }
            let body: serde_json::Value = match resp.json().await {
                Ok(value) => value,
                Err(error) => {
                    let _ = emit_stream_event(
                        &tx,
                        GenerateStreamEvent::Delta {
                            text: format!("Risposta del modello non valida: {error}"),
                        },
                    )
                    .await;
                    break;
                }
            };
            let message = body
                .get("choices")
                .and_then(|choices| choices.get(0))
                .and_then(|choice| choice.get("message"))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let tool_calls = message
                .get("tool_calls")
                .and_then(|value| value.as_array())
                .filter(|calls| !calls.is_empty())
                .cloned();

            if let Some(calls) = tool_calls {
                // Echo the assistant's tool-call turn, then append each tool result.
                messages.push(serde_json::json!({
                    "role": "assistant",
                    "content": message.get("content").cloned().unwrap_or(serde_json::Value::Null),
                    "tool_calls": calls,
                }));
                // Set when a write tool needs confirmation: we stop the loop and let
                // the user run it from the card instead of looping/hallucinating.
                let mut pending_confirm = false;
                for call in &calls {
                    let name = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("");
                    let args_raw = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(|a| a.as_str())
                        .unwrap_or("{}");
                    let call_id = call.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                    let goal = serde_json::from_str::<serde_json::Value>(args_raw)
                        .ok()
                        .and_then(|a| a.get("goal").and_then(|g| g.as_str()).map(String::from))
                        .unwrap_or_default();

                    let result = if name == "browse_web" {
                        let _ = emit_stream_event(
                            &tx,
                            GenerateStreamEvent::Delta {
                                text: format!(
                                    "‹‹ACT››🌐 Navigo sul web: {}‹‹/ACT››",
                                    if goal.is_empty() { "(obiettivo dal contesto)" } else { goal.as_str() }
                                ),
                            },
                        )
                        .await;
                        let st = state_owned.clone();
                        let effective = if goal.is_empty() { prompt.clone() } else { goal.clone() };
                        let thread_id_for_tool = thread_id.clone();
                        // Serialize browser work: the contained browser is a single
                        // shared instance, so only ONE browse_web may drive it at a
                        // time. Without this, concurrent chat requests spawn multiple
                        // sidecars onto the same browser and pile up tabs/state.
                        let _browse_guard = browse_web_lock().lock().await;
                        // Publish the live activity so the UI shows a truthful
                        // "● LIVE · <goal>" + step checklist only while working.
                        begin_browser_activity(effective.clone());
                        let outcome = tokio::task::spawn_blocking(move || {
                            execute_browse_web_tool(&st, &effective, thread_id_for_tool.as_deref())
                        })
                        .await;
                        end_browser_activity();
                        match outcome {
                            Ok(Ok(text)) => text,
                            Ok(Err(error)) => {
                                format!("Lo strumento browser ha riportato un errore: {error}")
                            }
                            Err(error) => format!("Errore di esecuzione dello strumento: {error}"),
                        }
                    } else if name == "use_skill" {
                        // Progressive disclosure L2: load the full SKILL.md so the
                        // model can follow the skill's instructions.
                        let id = serde_json::from_str::<serde_json::Value>(args_raw)
                            .ok()
                            .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(String::from))
                            .unwrap_or_default();
                        let _ = emit_stream_event(
                            &tx,
                            GenerateStreamEvent::Delta { text: format!("‹‹ACT››📖 Apro la skill {id}‹‹/ACT››") },
                        )
                        .await;
                        let id_for_load = id.clone();
                        match tokio::task::spawn_blocking(move || load_skill_body(&id_for_load)).await {
                            Ok(Some(body)) => format!(
                                "Istruzioni della skill «{id}» (SKILL.md) — SEGUILE con gli strumenti \
disponibili (per dati dal web usa browse_web sull'URL indicato):\n\n{}",
                                body.chars().take(8000).collect::<String>()
                            ),
                            _ => format!("Skill «{id}» non trovata o non leggibile."),
                        }
                    } else if name == "run_in_sandbox" {
                        // Execute a skill command in the contained computer (auto-start
                        // Docker + container). Blocked if the command trips the security scan.
                        let parsed = serde_json::from_str::<serde_json::Value>(args_raw)
                            .unwrap_or_else(|_| serde_json::json!({}));
                        let command = parsed
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let skill_id = parsed
                            .get("skill_id")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        if command.trim().is_empty() {
                            "Comando vuoto.".to_string()
                        } else {
                            let scan = skill_security::scan_blobs(&[(
                                "command".to_string(),
                                command.clone(),
                            )]);
                            if scan.blocked {
                                format!(
                                    "Comando NON eseguito: bloccato dallo scan di sicurezza \
(rischio {}/100). Riformula senza operazioni pericolose.",
                                    scan.risk_score
                                )
                            } else {
                                let _ = emit_stream_event(
                                    &tx,
                                    GenerateStreamEvent::Delta {
                                        text: format!(
                                            "‹‹ACT››🖥️ Eseguo: {}‹‹/ACT››",
                                            command.chars().take(160).collect::<String>()
                                        ),
                                    },
                                )
                                .await;
                                // Publish the command to the computer terminal panel.
                                sandbox_begin(command.clone());
                                // Per-conversation output dir: skills save generated
                                // files to $OUTPUT_DIR, bind-mounted to the host so
                                // they become downloadable artifacts.
                                let thread_slug = artifact_thread_slug(thread_id.as_deref());
                                let container_out = sandbox::container_output_dir(&thread_slug);
                                let host_out = sandbox::artifacts_dir().join(&thread_slug);
                                let run_started = std::time::SystemTime::now();
                                let cmd = format!(
                                    "export OUTPUT_DIR='{container_out}'; mkdir -p \"$OUTPUT_DIR\"; {command}"
                                );
                                // The model may omit skill_id; derive it from the
                                // command's `/home/agent/skills/<id>/…` path so the
                                // skill's files are always synced before running.
                                let sid = skill_id.clone().or_else(|| skill_id_from_command(&command));
                                let outcome = tokio::task::spawn_blocking(move || {
                                    if let Some(id) = sid.as_deref() {
                                        if let Ok(dir) = skills_dir() {
                                            sandbox::sync_skill(&dir.join(id), id);
                                        }
                                    }
                                    sandbox::run_command(&cmd, sid.as_deref())
                                })
                                .await;
                                let (panel_output, mut model_output) = match outcome {
                                    Ok(Ok(out)) => {
                                        if out.trim().is_empty() {
                                            ("(nessun output)".to_string(), "(nessun output)".to_string())
                                        } else {
                                            (out.clone(), format!("Output del comando:\n{out}"))
                                        }
                                    }
                                    Ok(Err(error)) => {
                                        let msg = format!("Sandbox non disponibile: {error}");
                                        (msg.clone(), msg)
                                    }
                                    Err(error) => {
                                        let msg = format!("Errore di esecuzione: {error}");
                                        (msg.clone(), msg)
                                    }
                                };
                                sandbox_end(panel_output);
                                // Surface files the command produced as downloadable
                                // artifacts (marker → card). If a PROJECT folder is
                                // active, also copy them there — it's the project's
                                // default folder for generated files.
                                let project_folder = active_workspace_folder();
                                for (file_name, size) in detect_new_artifacts(&host_out, run_started) {
                                    let mut delivered_to: Option<String> = None;
                                    if let Some(folder) = project_folder.as_ref() {
                                        let dest = std::path::Path::new(folder).join(&file_name);
                                        if std::fs::copy(host_out.join(&file_name), &dest).is_ok() {
                                            delivered_to = Some(dest.to_string_lossy().to_string());
                                        }
                                    }
                                    let marker = serde_json::json!({
                                        "name": file_name,
                                        "thread": thread_slug,
                                        "size": size,
                                    });
                                    let _ = emit_stream_event(
                                        &tx,
                                        GenerateStreamEvent::Delta {
                                            text: format!("‹‹ARTIFACT››{marker}‹‹/ARTIFACT››"),
                                        },
                                    )
                                    .await;
                                    match delivered_to {
                                        Some(path) => model_output
                                            .push_str(&format!("\n[file generato e salvato in {path}]")),
                                        None => model_output.push_str(&format!(
                                            "\n[file generato: {file_name} in $OUTPUT_DIR]"
                                        )),
                                    }
                                }
                                model_output
                            }
                        }
                    } else if name == "create_artifact" {
                        // Model-authored document/code → file artifact (host-side).
                        let parsed = serde_json::from_str::<serde_json::Value>(args_raw)
                            .unwrap_or_else(|_| serde_json::json!({}));
                        let fname = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let content =
                            parsed.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let thread_slug = artifact_thread_slug(thread_id.as_deref());
                        let _ = emit_stream_event(
                            &tx,
                            GenerateStreamEvent::Delta {
                                text: format!("‹‹ACT››📝 Creo il file {fname}‹‹/ACT››"),
                            },
                        )
                        .await;
                        let fname_w = fname.clone();
                        let slug_w = thread_slug.clone();
                        let result = tokio::task::spawn_blocking(move || {
                            write_text_artifact(&slug_w, &fname_w, &content)
                        })
                        .await
                        .unwrap_or_else(|e| Err(format!("Errore: {e}")));
                        match result {
                            Ok(size) => {
                                let marker = serde_json::json!({
                                    "name": fname,
                                    "thread": thread_slug,
                                    "size": size,
                                });
                                let _ = emit_stream_event(
                                    &tx,
                                    GenerateStreamEvent::Delta {
                                        text: format!("‹‹ARTIFACT››{marker}‹‹/ARTIFACT››"),
                                    },
                                )
                                .await;
                                format!("Artifact «{fname}» creato.")
                            }
                            Err(error) => error,
                        }
                    } else if name == "save_artifact" {
                        // Deliver a generated artifact to an authorized destination
                        // (gateway performs the copy host-side, scoped to grants).
                        let parsed = serde_json::from_str::<serde_json::Value>(args_raw)
                            .unwrap_or_else(|_| serde_json::json!({}));
                        let file = parsed.get("file").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let dest_name = parsed
                            .get("destination")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let thread_slug = artifact_thread_slug(thread_id.as_deref());
                        let _ = emit_stream_event(
                            &tx,
                            GenerateStreamEvent::Delta {
                                text: format!("‹‹ACT››💾 Salvo {file} in «{dest_name}»‹‹/ACT››"),
                            },
                        )
                        .await;
                        tokio::task::spawn_blocking(move || {
                            save_artifact_to_destination(&thread_slug, &file, &dest_name)
                        })
                        .await
                        .unwrap_or_else(|e| format!("Errore di salvataggio: {e}"))
                    } else if name == "find_connected_tools" {
                        // Discovery: search the catalog, inject the matching tool
                        // schemas so the model can call them next round.
                        let query = serde_json::from_str::<serde_json::Value>(args_raw)
                            .ok()
                            .and_then(|a| a.get("query").and_then(|q| q.as_str()).map(String::from))
                            .unwrap_or_default();
                        let _ = emit_stream_event(
                            &tx,
                            GenerateStreamEvent::Delta {
                                text: format!(
                                    "‹‹ACT››🔎 Cerco strumenti: {}‹‹/ACT››",
                                    if query.is_empty() { "(intento)" } else { query.as_str() }
                                ),
                            },
                        )
                        .await;
                        let matches =
                            search_composio_catalog(&catalog_index, &query, COMPOSIO_DISCOVERY_RESULTS);
                        if matches.is_empty() {
                            "Nessuno strumento corrisponde. Riformula con parole chiave del \
servizio (es. \"email\", \"calendar\", \"drive\")."
                                .to_string()
                        } else {
                            let mut lines = Vec::new();
                            for (slug, schema) in &matches {
                                if loaded_tools.insert(slug.clone()) {
                                    tool_schemas.push(schema.clone());
                                }
                                let desc = schema
                                    .get("function")
                                    .and_then(|f| f.get("description"))
                                    .and_then(|d| d.as_str())
                                    .unwrap_or("")
                                    .chars()
                                    .take(140)
                                    .collect::<String>();
                                lines.push(format!("- {slug}: {desc}"));
                            }
                            format!(
                                "Strumenti trovati (ora richiamabili — chiama quello giusto con i \
suoi argomenti):\n{}",
                                lines.join("\n")
                            )
                        }
                    } else if !name.is_empty() {
                        // A connected-service (Composio) tool. Writes need explicit
                        // confirmation unless the user marked this tool "always allow".
                        let needs_confirm =
                            composio_writes.contains(name) && !composio_tool_allowed(name);
                        if needs_confirm {
                            // Do NOT execute. Emit a confirmation card carrying the exact
                            // action; the user runs it (once/always) via the card. The model
                            // must never claim it's done — the real outcome comes from the card.
                            let args_val: serde_json::Value = serde_json::from_str(args_raw)
                                .unwrap_or_else(|_| serde_json::json!({}));
                            let marker = serde_json::json!({ "tool": name, "arguments": args_val })
                                .to_string();
                            let card = format!(
                                "\n\nServe la tua conferma per l'azione qui sotto.\n\
‹‹COMPOSIO_CONFIRM››{marker}‹‹/COMPOSIO_CONFIRM››\n"
                            );
                            accumulated.push_str(&card);
                            let _ = emit_stream_event(&tx, GenerateStreamEvent::Delta { text: card })
                                .await;
                            pending_confirm = true;
                            "IN ATTESA DI CONFERMA UTENTE: l'azione è stata proposta tramite una \
card di conferma nell'interfaccia. NON dire che è stata eseguita."
                                .to_string()
                        } else {
                            let _ = emit_stream_event(
                                &tx,
                                GenerateStreamEvent::Delta {
                                    text: format!("‹‹ACT››🔧 Uso {}‹‹/ACT››", humanize_composio_tool(name)),
                                },
                            )
                            .await;
                            let st = state_owned.clone();
                            let tool = name.to_string();
                            let args: serde_json::Value =
                                serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
                            let outcome = tokio::task::spawn_blocking(move || {
                                composio_execute_tool(&st, &tool, &args)
                            })
                            .await;
                            match outcome {
                                Ok(Ok(value)) => {
                                    value.to_string().chars().take(COMPOSIO_RESULT_CHARS).collect()
                                }
                                Ok(Err(error)) => {
                                    format!("Errore dello strumento {name}: {}", error.message)
                                }
                                Err(error) => format!("Errore di esecuzione dello strumento: {error}"),
                            }
                        }
                    } else {
                        format!("Strumento non disponibile: {name}")
                    };

                    // Collect source URLs from browser results so the final
                    // answer can carry a deterministic "Fonti" section.
                    if name == "browse_web" {
                        for url in extract_source_urls(&result) {
                            if !browse_sources.contains(&url) {
                                browse_sources.push(url);
                            }
                        }
                    }
                    messages.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": result,
                    }));
                }
                if pending_confirm {
                    // A write is awaiting the user's confirmation card — end the turn
                    // here (no synthesis, no further tool rounds).
                    let _ = emit_stream_event(
                        &tx,
                        GenerateStreamEvent::Done {
                            text: accumulated.clone(),
                            metrics: TokenMetrics::zero(),
                        },
                    )
                    .await;
                    final_done = true;
                    break;
                }
                continue;
            }

            // No tool call → this is the final answer.
            let content = message
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            accumulated.push_str(&content);
            let _ = emit_stream_event(&tx, GenerateStreamEvent::Delta { text: content }).await;
            if let Some(fonti) = fonti_section(&browse_sources, &accumulated) {
                accumulated.push_str(&fonti);
                let _ = emit_stream_event(&tx, GenerateStreamEvent::Delta { text: fonti }).await;
            }
            let _ = emit_stream_event(
                &tx,
                GenerateStreamEvent::Done {
                    text: accumulated.clone(),
                    metrics: TokenMetrics::zero(),
                },
            )
            .await;
            final_done = true;
            break;
        }

        if !final_done {
            // Guaranteed synthesis: the model exhausted the tool rounds without a
            // text answer (it kept calling tools). Force one final NO-TOOLS call so
            // it synthesizes from the results already gathered, instead of dead-ending
            // on "limite di passi".
            messages.push(serde_json::json!({
                "role": "user",
                "content": "Non sono più disponibili strumenti. Scrivi ORA la risposta finale per \
l'utente sintetizzando i risultati raccolti dai passi precedenti (sii esaustivo: orari, durata, \
scali, compagnia, prezzo per ogni opzione). Se una fonte era bloccata o senza dati, dillo con onestà."
            }));
            let mut synth_text = String::new();
            let mut builder = http.post(&endpoint);
            if let Some(key) = api_key.as_ref() {
                builder = builder.bearer_auth(key);
            }
            let synth = builder
                .json(&serde_json::json!({
                    "model": model,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": 6000,
                    "stream": false,
                }))
                .send()
                .await;
            if let Ok(resp) = synth {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    synth_text = body
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("message"))
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string();
                }
            }
            let mut final_text = if !synth_text.trim().is_empty() {
                synth_text
            } else if !accumulated.trim().is_empty() {
                accumulated
            } else {
                "Non sono riuscito a recuperare i risultati dalle fonti (alcune bloccate da \
verifica anti-bot). Riprova o indica una fonte preferita.".to_string()
            };
            if let Some(fonti) = fonti_section(&browse_sources, &final_text) {
                final_text.push_str(&fonti);
            }
            let _ = emit_stream_event(&tx, GenerateStreamEvent::Delta { text: final_text.clone() }).await;
            let _ = emit_stream_event(
                &tx,
                GenerateStreamEvent::Done {
                    text: final_text,
                    metrics: TokenMetrics::zero(),
                },
            )
            .await;
        }
        // Mark the resume entry finished and evict it after a grace window so a
        // client that reloaded right at the end can still reattach and read it.
        tx.entry
            .finished
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let cleanup_id = resume_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            if let Ok(mut map) = stream_registry().lock() {
                map.remove(&cleanup_id);
            }
        });
    });

    let body = Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    }));
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .body(body)
        .expect("valid streaming response"))
}

/// Today's date (ISO `YYYY-MM-DD`), injected into prompts so the model can
/// resolve relative dates ("10 giugno") and never acts as if it's date-blind.
fn today_iso() -> String {
    time::OffsetDateTime::now_utc().date().to_string()
}

/// Global lock serializing `browse_web` runs: the contained browser is a single
/// shared instance, so only one observe-act loop may drive it at a time.
fn browse_web_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// How long a per-thread browser session may sit idle before it is reaped.
const THREAD_BROWSER_SESSION_IDLE: std::time::Duration = std::time::Duration::from_secs(300);

/// Take (remove) a thread's warm browser session for reuse. Returns `None` if
/// absent or stale (a stale one is gracefully closed here so it doesn't leak).
fn take_thread_browser_session(
    state: &AppState,
    thread_id: &str,
) -> Option<BrowserAutomationClient<BrowserSidecarSession>> {
    let session = {
        let mut map = state.browser_thread_sessions.lock().ok()?;
        map.remove(thread_id)?
    };
    if session.last_used.elapsed() > THREAD_BROWSER_SESSION_IDLE {
        let _ = session.client.call(BrowserMethod::Stop, serde_json::json!({}));
        return None;
    }
    Some(session.client)
}

/// Park a thread's browser session back in the registry, warm for the next call.
fn store_thread_browser_session(
    state: &AppState,
    thread_id: &str,
    client: BrowserAutomationClient<BrowserSidecarSession>,
) {
    if let Ok(mut map) = state.browser_thread_sessions.lock() {
        map.insert(
            thread_id.to_string(),
            ThreadBrowserSession {
                client,
                last_used: std::time::Instant::now(),
            },
        );
    } else {
        // Poisoned lock: don't leak the sidecar — close it.
        let _ = client.call(BrowserMethod::Stop, serde_json::json!({}));
    }
}

/// Close and forget a thread's browser session (graceful browser.stop + drop).
/// Called when a thread is archived/closed/deleted.
fn close_thread_browser_session(state: &AppState, thread_id: &str) {
    let session = state
        .browser_thread_sessions
        .lock()
        .ok()
        .and_then(|mut map| map.remove(thread_id));
    if let Some(session) = session {
        let _ = session.client.call(BrowserMethod::Stop, serde_json::json!({}));
    }
}

/// Background reaper: every 60s, close per-thread browser sessions idle past the
/// timeout so abandoned threads don't keep a sidecar (and its tab) alive forever.
fn spawn_thread_browser_session_reaper(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let stale: Vec<ThreadBrowserSession> = {
                let Ok(mut map) = state.browser_thread_sessions.lock() else {
                    continue;
                };
                let expired: Vec<String> = map
                    .iter()
                    .filter(|(_, session)| session.last_used.elapsed() > THREAD_BROWSER_SESSION_IDLE)
                    .map(|(thread, _)| thread.clone())
                    .collect();
                expired
                    .into_iter()
                    .filter_map(|thread| map.remove(&thread))
                    .collect()
            };
            if stale.is_empty() {
                continue;
            }
            // Closing talks to the sidecar over a blocking pipe — do it off the
            // async runtime.
            let _ = tokio::task::spawn_blocking(move || {
                for session in stale {
                    let _ = session.client.call(BrowserMethod::Stop, serde_json::json!({}));
                }
            })
            .await;
        }
    });
}

/// One step of the live activity checklist (Manus-style "Avanzamento attività").
#[derive(Debug, Clone, Serialize)]
struct BrowserStepView {
    label: String,
    status: String,
}

/// Live browser activity: the current goal + the steps executed so far. `Some`
/// while a `browse_web` is actually running, `None` when idle. Drives a truthful
/// "● LIVE" + the step checklist in the UI.
#[derive(Debug, Clone, Default)]
struct BrowserActivityState {
    goal: String,
    steps: Vec<BrowserStepView>,
}

fn browser_activity_cell() -> &'static std::sync::RwLock<Option<BrowserActivityState>> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<Option<BrowserActivityState>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::RwLock::new(None))
}

fn begin_browser_activity(goal: String) {
    if let Ok(mut guard) = browser_activity_cell().write() {
        *guard = Some(BrowserActivityState {
            goal,
            steps: Vec::new(),
        });
    }
}

fn push_browser_step(label: String, status: &str) {
    if let Ok(mut guard) = browser_activity_cell().write() {
        if let Some(state) = guard.as_mut() {
            // Cap the visible log so a long run can't grow unbounded.
            if state.steps.len() < 60 {
                state.steps.push(BrowserStepView {
                    label,
                    status: status.to_string(),
                });
            }
        }
    }
}

fn end_browser_activity() {
    if let Ok(mut guard) = browser_activity_cell().write() {
        *guard = None;
    }
}

fn current_browser_activity() -> Option<BrowserActivityState> {
    browser_activity_cell().read().ok().and_then(|guard| guard.clone())
}

/// One executed terminal command + its output, for the "computer terminal" panel
/// (the Manus-style view of CLI skill execution in the contained computer).
#[derive(Debug, Clone, Serialize)]
struct TerminalEntryView {
    command: String,
    output: String,
    running: bool,
}

fn sandbox_activity_cell() -> &'static std::sync::RwLock<Vec<TerminalEntryView>> {
    static CELL: std::sync::OnceLock<std::sync::RwLock<Vec<TerminalEntryView>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::RwLock::new(Vec::new()))
}

/// Resets the terminal buffer — called when a new chat request starts so the
/// panel shows the CURRENT request's commands, then stays visible (with output)
/// until the next request replaces it.
fn sandbox_clear() {
    if let Ok(mut guard) = sandbox_activity_cell().write() {
        guard.clear();
    }
}

/// Records a command about to run (output filled in by `sandbox_end`).
fn sandbox_begin(command: String) {
    if let Ok(mut guard) = sandbox_activity_cell().write() {
        if guard.len() >= 20 {
            guard.remove(0);
        }
        guard.push(TerminalEntryView { command, output: String::new(), running: true });
    }
}

/// Attaches the output to the most recent running command and marks it done.
fn sandbox_end(output: String) {
    if let Ok(mut guard) = sandbox_activity_cell().write() {
        if let Some(entry) = guard.iter_mut().rev().find(|entry| entry.running) {
            entry.output = output.chars().take(4000).collect();
            entry.running = false;
        }
    }
}

fn current_sandbox_activity() -> Vec<TerminalEntryView> {
    sandbox_activity_cell().read().ok().map(|guard| guard.clone()).unwrap_or_default()
}

/// Human-readable label for a loop iteration, for the activity checklist.
/// Prefers the model's own user-facing `step` description ("Inserisco
/// l'aeroporto di partenza"); falls back to a mechanical summary only if the
/// model didn't provide one.
fn browser_step_label(iteration: &local_first_browser_automation::BrowserLoopIteration) -> String {
    let action = &iteration.action;
    if let Some(step) = action
        .get("step")
        .or_else(|| action.get("summary"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return step.chars().take(90).collect();
    }
    let kind = action
        .get("kind")
        .or_else(|| action.get("action"))
        .and_then(|value| value.as_str())
        .unwrap_or("azione");
    let verb = match kind {
        "navigate" | "open" | "goto" => "Navigo",
        "click" => "Clic",
        "type" | "fill" | "fill_form" => "Digito",
        "scroll" | "scroll_into_view" => "Scorro",
        "wait" => "Attendo",
        "snapshot" => "Osservo",
        "select" | "select_option" => "Seleziono",
        "hover" => "Passo sopra",
        "planner_validation_error" => "Riprovo",
        other => other,
    };
    let detail = action
        .get("ref")
        .or_else(|| action.get("target"))
        .or_else(|| action.get("text"))
        .or_else(|| action.get("url"))
        .and_then(|value| value.as_str())
        .map(|value| value.chars().take(60).collect::<String>())
        .unwrap_or_default();
    if detail.is_empty() {
        format!("Passo {}: {verb}", iteration.iteration)
    } else {
        format!("Passo {}: {verb} · {detail}", iteration.iteration)
    }
}

/// Executes the `browse_web` tool: materializes a browser task for the goal and
/// runs the observe-act loop synchronously (in contained-computer mode it drives
/// the real browser in the container, visible via noVNC), returning the loop's
/// human-facing result for the model to read.
#[derive(Debug, Deserialize)]
struct ArtifactRef {
    thread: String,
    name: String,
}

fn artifact_mime(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "csv" => "text/csv",
        "pdf" => "application/pdf",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "txt" | "md" => "text/plain",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Streams a generated artifact for download, scoped to the per-thread output dir
/// (anti path-traversal: simple filename within the thread folder only).
async fn download_artifact(Query(reference): Query<ArtifactRef>) -> Result<Response, GatewayError> {
    let forbidden = reference.name.contains('/')
        || reference.name.contains('\\')
        || reference.name.contains("..")
        || reference.thread.contains('/')
        || reference.thread.contains("..");
    if forbidden {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "bad_artifact_path",
            message: "Percorso non valido.".to_string(),
        });
    }
    let dir = sandbox::artifacts_dir().join(&reference.thread);
    let path = dir.join(&reference.name);
    if !path_within(&dir, &path) {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "artifact_outside_dir",
            message: "Percorso fuori dalla cartella artifact.".to_string(),
        });
    }
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "artifact_read",
            message: e.to_string(),
        })?
        .map_err(|e| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "artifact_read",
            message: e.to_string(),
        })?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", artifact_mime(&reference.name))
        .header(
            "content-disposition",
            format!("attachment; filename=\"{}\"", reference.name.replace('"', "")),
        )
        .body(Body::from(bytes))
        .expect("valid artifact response"))
}

// ---- authorized write destinations (file-ops boundary) ----------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ArtifactDestination {
    label: String,
    path: String,
}

fn artifact_destinations_path() -> Option<PathBuf> {
    gateway_data_dir().ok().map(|dir| dir.join("artifact-destinations.json"))
}

fn load_artifact_destinations() -> Vec<ArtifactDestination> {
    artifact_destinations_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_artifact_destinations(list: &[ArtifactDestination]) -> Result<(), String> {
    let path = artifact_destinations_path().ok_or_else(|| "data dir non disponibile".to_string())?;
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Resolves a destination (by label or exact path) among the AUTHORIZED ones.
/// The agent can only write where the user explicitly granted.
fn resolve_destination(name: &str) -> Option<ArtifactDestination> {
    let needle = name.trim();
    load_artifact_destinations().into_iter().find(|d| {
        d.label.eq_ignore_ascii_case(needle) || d.path == needle
    })
}

#[derive(Debug, Serialize)]
struct ArtifactDestinationsResponse {
    destinations: Vec<ArtifactDestination>,
}

async fn list_artifact_destinations() -> Json<ArtifactDestinationsResponse> {
    Json(ArtifactDestinationsResponse { destinations: load_artifact_destinations() })
}

#[derive(Debug, Deserialize)]
struct AddDestinationRequest {
    label: String,
    path: String,
}

async fn add_artifact_destination(
    Json(request): Json<AddDestinationRequest>,
) -> Result<Json<ArtifactDestinationsResponse>, GatewayError> {
    let path = request.path.trim().to_string();
    let label = request.label.trim().to_string();
    if path.is_empty() || !PathBuf::from(&path).is_dir() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "dest_not_found",
            message: "La cartella indicata non esiste.".to_string(),
        });
    }
    let mut list = load_artifact_destinations();
    if !list.iter().any(|d| d.path == path) {
        list.push(ArtifactDestination {
            label: if label.is_empty() {
                PathBuf::from(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone())
            } else {
                label
            },
            path,
        });
        write_artifact_destinations(&list).map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "dest_store",
            message: e,
        })?;
    }
    Ok(Json(ArtifactDestinationsResponse { destinations: list }))
}

#[derive(Debug, Deserialize)]
struct RemoveDestinationQuery {
    path: String,
}

async fn remove_artifact_destination(
    Query(query): Query<RemoveDestinationQuery>,
) -> Result<Json<ArtifactDestinationsResponse>, GatewayError> {
    let mut list = load_artifact_destinations();
    list.retain(|d| d.path != query.path);
    write_artifact_destinations(&list).map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "dest_store",
        message: e,
    })?;
    Ok(Json(ArtifactDestinationsResponse { destinations: list }))
}

#[derive(Debug, Deserialize)]
struct ArtifactFolderQuery {
    #[serde(default)]
    thread: Option<String>,
}

#[derive(Debug, Serialize)]
struct ArtifactFolderResponse {
    path: String,
}

/// Host filesystem path of the artifacts folder (optionally a thread subfolder),
/// so the desktop shell can reveal it in the Finder.
async fn artifact_folder_path(Query(query): Query<ArtifactFolderQuery>) -> Json<ArtifactFolderResponse> {
    let mut path = sandbox::artifacts_dir();
    if let Some(thread) = query.thread.as_ref().filter(|t| !t.trim().is_empty()) {
        path = path.join(artifact_thread_slug(Some(thread)));
    }
    Json(ArtifactFolderResponse { path: path.to_string_lossy().to_string() })
}

#[derive(Debug, Serialize)]
struct ArtifactFileView {
    name: String,
    size: u64,
}

#[derive(Debug, Serialize)]
struct ArtifactThreadView {
    thread: String,
    bytes: u64,
    files: Vec<ArtifactFileView>,
}

#[derive(Debug, Serialize)]
struct ArtifactsUsage {
    base_path: String,
    total_bytes: u64,
    threads: Vec<ArtifactThreadView>,
}

/// Disk usage of generated artifacts, grouped per conversation — drives the
/// management/cleanup view so the folder can't silently fill the disk.
async fn artifacts_usage() -> Json<ArtifactsUsage> {
    let base = sandbox::artifacts_dir();
    let mut threads: Vec<ArtifactThreadView> = Vec::new();
    let mut total: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let thread = entry.file_name().to_string_lossy().to_string();
            let mut files: Vec<ArtifactFileView> = Vec::new();
            let mut bytes: u64 = 0;
            if let Ok(inner) = std::fs::read_dir(entry.path()) {
                for file in inner.flatten() {
                    if !file.path().is_file() {
                        continue;
                    }
                    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
                    bytes += size;
                    files.push(ArtifactFileView {
                        name: file.file_name().to_string_lossy().to_string(),
                        size,
                    });
                }
            }
            if files.is_empty() {
                continue;
            }
            files.sort_by(|a, b| a.name.cmp(&b.name));
            total += bytes;
            threads.push(ArtifactThreadView { thread, bytes, files });
        }
    }
    threads.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    Json(ArtifactsUsage {
        base_path: base.to_string_lossy().to_string(),
        total_bytes: total,
        threads,
    })
}

fn ok_json() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

/// Deletes a single artifact file (anti path-traversal, scoped to its thread).
async fn delete_artifact_file(Query(reference): Query<ArtifactRef>) -> Result<Json<serde_json::Value>, GatewayError> {
    if reference.name.contains('/') || reference.name.contains("..") || reference.thread.contains('/') {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "bad_artifact_path",
            message: "Percorso non valido.".to_string(),
        });
    }
    let dir = sandbox::artifacts_dir().join(&reference.thread);
    let path = dir.join(&reference.name);
    if path_within(&dir, &path) {
        let _ = std::fs::remove_file(&path);
    }
    Ok(ok_json())
}

/// Deletes all artifacts of one conversation.
async fn delete_artifact_thread(Query(query): Query<ArtifactFolderQuery>) -> Json<serde_json::Value> {
    if let Some(thread) = query.thread.as_ref().filter(|t| !t.trim().is_empty()) {
        let dir = sandbox::artifacts_dir().join(artifact_thread_slug(Some(thread)));
        let _ = std::fs::remove_dir_all(&dir);
    }
    ok_json()
}

/// Clears all generated artifacts (every conversation subfolder).
async fn clear_artifacts() -> Json<serde_json::Value> {
    let base = sandbox::artifacts_dir();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    ok_json()
}

/// Writes a model-authored text artifact to the conversation's managed output
/// dir (so it stays downloadable/previewable) and, if a project is active, also
/// to the project folder. Returns the byte size on success.
fn write_text_artifact(thread_slug: &str, name: &str, content: &str) -> Result<u64, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Nome file non valido.".to_string());
    }
    let managed_dir = sandbox::artifacts_dir().join(thread_slug);
    if let Err(error) = fs::create_dir_all(&managed_dir) {
        return Err(format!("Impossibile creare la cartella artifact: {error}"));
    }
    let managed_path = managed_dir.join(name);
    if let Err(error) = fs::write(&managed_path, content) {
        return Err(format!("Scrittura artifact non riuscita: {error}"));
    }
    if let Some(folder) = active_workspace_folder() {
        let _ = fs::copy(&managed_path, std::path::Path::new(&folder).join(name));
    }
    Ok(content.len() as u64)
}

/// Copies an artifact to an AUTHORIZED destination folder (host-side). Enforces:
/// the file is a plain name within the thread's output dir, and the destination
/// is one the user granted. Returns a user-facing result line for the model.
fn save_artifact_to_destination(thread_slug: &str, file: &str, dest_name: &str) -> String {
    if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
        return "Nome file non valido.".to_string();
    }
    let Some(dest) = resolve_destination(dest_name) else {
        let available = load_artifact_destinations()
            .iter()
            .map(|d| d.label.clone())
            .collect::<Vec<_>>()
            .join(", ");
        return format!(
            "Destinazione «{dest_name}» non autorizzata. Disponibili: {}.",
            if available.is_empty() { "nessuna".to_string() } else { available }
        );
    };
    let src_dir = sandbox::artifacts_dir().join(thread_slug);
    let src = src_dir.join(file);
    if !path_within(&src_dir, &src) || !src.is_file() {
        return format!("File «{file}» non trovato tra gli artifact.");
    }
    let dest_dir = PathBuf::from(&dest.path);
    if !dest_dir.is_dir() {
        return format!("La cartella di destinazione «{}» non esiste più.", dest.label);
    }
    let target = dest_dir.join(file);
    match fs::copy(&src, &target) {
        Ok(_) => format!("✅ Salvato in {}", target.display()),
        Err(error) => format!("Salvataggio non riuscito: {error}"),
    }
}

/// Filesystem-safe per-conversation slug for the artifacts subfolder.
fn artifact_thread_slug(thread: Option<&str>) -> String {
    let raw = thread.unwrap_or("default").trim();
    let slug: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    if slug.is_empty() {
        "default".to_string()
    } else {
        slug
    }
}

/// Lists files created/modified in the output dir since a run started — the
/// generated artifacts to surface as downloadable cards.
fn detect_new_artifacts(dir: &std::path::Path, since: std::time::SystemTime) -> Vec<(String, u64)> {
    let mut out: Vec<(String, u64)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let cutoff = since
        .checked_sub(std::time::Duration::from_secs(2))
        .unwrap_or(since);
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let recent = meta.modified().map(|m| m >= cutoff).unwrap_or(true);
        if !recent {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        out.push((name, meta.len()));
    }
    out.sort();
    out
}

/// Extracts http(s) URLs from a browser tool result (manual scan, no regex dep),
/// trimming trailing punctuation. Used to build the deterministic "Fonti" footer.
fn extract_source_urls(text: &str) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find("http") {
        let candidate = &rest[pos..];
        if candidate.starts_with("http://") || candidate.starts_with("https://") {
            let end = candidate
                .find(|c: char| {
                    c.is_whitespace() || matches!(c, ')' | ']' | '"' | '<' | '>' | '`' | '|' | '\\')
                })
                .unwrap_or(candidate.len());
            let mut url = candidate[..end].to_string();
            while url.ends_with(['.', ',', ';', ':', '*', '!', '?']) {
                url.pop();
            }
            if url.len() > 12 && !urls.contains(&url) {
                urls.push(url);
            }
            rest = &candidate[end..];
        } else {
            rest = &candidate[4..];
        }
    }
    urls
}

/// Builds a "Fonti" markdown footer from collected source URLs, unless the answer
/// already cites sources. Capped to keep it tidy.
fn fonti_section(sources: &[String], answer: &str) -> Option<String> {
    if sources.is_empty() {
        return None;
    }
    let lower = answer.to_lowercase();
    if lower.contains("**fonti") || lower.contains("fonti controllate") {
        return None;
    }
    let list = sources
        .iter()
        .take(6)
        .map(|url| format!("- {url}"))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!("\n\n**Fonti**\n{list}"))
}

fn execute_browse_web_tool(
    state: &AppState,
    goal: &str,
    thread_id: Option<&str>,
) -> Result<String, String> {
    let task_id = format!("chat_browse_{}", uuid::Uuid::new_v4().simple());
    let mut task = TaskRecord::new(
        task_id,
        gateway_user_id(),
        gateway_workspace_id(),
        "browser_task",
        task_goal_summary(goal),
        serde_json::json!({
            "source": "chat_tool_browse_web",
            "prompt_redacted": redact_sensitive_text(goal),
            "raw_prompt_stored": false,
            // Thread scope for per-thread browser session reuse (read back by
            // execute_browser_read_only_task to attach/keep-alive the session).
            "thread_id": thread_id,
        }),
    )
    .with_resource(ResourceRequirement::new(ResourceClass::ComputerSession, 1));
    task.risk_level = "low".to_string();
    task.permission_context = serde_json::json!({
        "privacy_domains": ["local", "browser"],
        "requires_user_approval": false,
        "cloud_allowed": false
    });

    {
        let store = lock_task_store(state).map_err(|error| error.message.to_string())?;
        store
            .insert_task(&task)
            .map_err(|error| format!("inserimento task browser: {error}"))?;
    }

    let outcome = execute_browser_read_only_task(state, &task).map_err(|error| error.message)?;
    let result = if !outcome.chat_message.trim().is_empty() {
        outcome.chat_message
    } else if !outcome.summary.trim().is_empty() {
        outcome.summary
    } else {
        "Nessun risultato dal browser.".to_string()
    };
    Ok(result)
}

/// A live chat stream, kept in a server-side registry so a client that reloads
/// mid-answer can REATTACH (replay the buffered events + continue live) instead
/// of losing the in-flight response. The generation writes here regardless of
/// whether any HTTP client is currently attached.
struct StreamEntry {
    /// NDJSON lines emitted so far (replayed to a late/reattaching reader).
    lines: std::sync::Mutex<Vec<String>>,
    /// Live fan-out to currently-attached readers.
    tx: tokio::sync::broadcast::Sender<String>,
    finished: std::sync::atomic::AtomicBool,
}

/// Sink the generation emits to: tees every event to the ORIGINAL live response
/// (mpsc, unchanged behaviour) AND to the resume registry (buffer + broadcast).
struct StreamSink {
    mpsc: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
    entry: std::sync::Arc<StreamEntry>,
}

fn stream_registry()
-> &'static std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<StreamEntry>>> {
    static CELL: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<StreamEntry>>>,
    > = std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn stream_event_is_terminal(line: &str) -> bool {
    line.contains("\"type\":\"done\"") || line.contains("\"type\":\"error\"")
}

/// Builds an NDJSON response body for a reattaching reader: replays the buffered
/// events, then forwards live ones until a terminal (done/error) event.
fn ndjson_body_for_entry(entry: std::sync::Arc<StreamEntry>) -> Body {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(64);
    tokio::spawn(async move {
        // Snapshot + subscribe under the same lock so no event is missed/duplicated.
        let (snapshot, mut brx) = {
            let buf = entry.lines.lock().expect("stream lines lock");
            (buf.clone(), entry.tx.subscribe())
        };
        for line in &snapshot {
            if tx.send(Ok(Bytes::from(format!("{line}\n")))).await.is_err() {
                return;
            }
            if stream_event_is_terminal(line) {
                return;
            }
        }
        loop {
            match brx.recv().await {
                Ok(line) => {
                    let terminal = stream_event_is_terminal(&line);
                    if tx.send(Ok(Bytes::from(format!("{line}\n")))).await.is_err() {
                        return;
                    }
                    if terminal {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });
    Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    }))
}

/// Reattach to an in-flight (or just-finished) chat stream by request id.
async fn resume_stream(Path(request_id): Path<String>) -> Result<Response, GatewayError> {
    let entry = stream_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&request_id).cloned());
    match entry {
        Some(entry) => Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/x-ndjson")
            .body(ndjson_body_for_entry(entry))
            .expect("valid streaming response")),
        None => Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "stream_not_found",
            message: "Nessuno stream attivo per questa richiesta.".to_string(),
        }),
    }
}

async fn emit_stream_event(sink: &StreamSink, event: GenerateStreamEvent) -> Result<(), ()> {
    let line = serde_json::to_string(&event).map_err(|_| ())?;
    // Tee to the resume registry (buffer + broadcast) under one lock so a
    // reattaching reader never misses or duplicates an event.
    if let Ok(mut buf) = sink.entry.lines.lock() {
        buf.push(line.clone());
        let _ = sink.entry.tx.send(line.clone());
    }
    // Original live response; ignored if the client already disconnected (the
    // generation keeps running and recording into the registry).
    let _ = sink.mpsc.send(Ok(Bytes::from(format!("{line}\n")))).await;
    Ok(())
}

async fn task_queue(
    State(state): State<AppState>,
) -> Result<Json<TaskQueueResponse>, GatewayError> {
    Ok(Json(task_queue_response_for_state(&state)?))
}

async fn task_detail(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<Option<TaskDetailResponse>>, GatewayError> {
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let store = lock_task_store(&state)?;
    let detail = TaskUiReadModel::new(&store)
        .task_detail(&TaskId::new(task_id), &user, &workspace)
        .map_err(GatewayError::task)?
        .map(task_detail_response)
        .transpose()?;
    Ok(Json(detail))
}

async fn run_next_task(
    State(state): State<AppState>,
) -> Result<Json<TaskRunBatchResponse>, GatewayError> {
    let state_for_task = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_next_task_once(&state_for_task, TASK_EXECUTOR_MANUAL_WORKER_ID)
    })
    .await
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "task_executor_join_error",
        message: error.to_string(),
    })??;
    Ok(Json(result))
}

async fn task_executor_status(
    State(state): State<AppState>,
) -> Result<Json<TaskExecutorStatusResponse>, GatewayError> {
    Ok(Json(task_executor_status_response(&state)?))
}

async fn approve_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
    request: Option<Json<ApproveApprovalRequest>>,
) -> Result<Json<TaskQueueResponse>, GatewayError> {
    let store = lock_task_store(&state)?;
    let approval = store
        .approval_by_id(&approval_id)
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError::task(TaskRuntimeError::NotFound(approval_id.clone())))?;
    let task = store
        .get_task(&approval.task_id, &approval.user_id, &approval.workspace_id)
        .map_err(GatewayError::task)?;
    let approval_options = request.map(|Json(request)| request);
    if let (Some(task), Some(options)) = (task.as_ref(), approval_options.as_ref()) {
        persist_browser_approval_options(&state, &approval, task, options)?;
        append_browser_approval_checkpoint(&store, &approval, task, options)
            .map_err(GatewayError::task)?;
    }
    ApprovalGate::new()
        .approve(&store, &approval_id, gateway_user_id().as_str())
        .map_err(GatewayError::task)?;
    drop(store);
    sync_computer_session_after_approval(&state, &approval, ApprovalState::Approved)?;
    Ok(Json(task_queue_response_for_state(&state)?))
}

async fn reject_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
    Json(request): Json<RejectApprovalRequest>,
) -> Result<Json<TaskQueueResponse>, GatewayError> {
    let store = lock_task_store(&state)?;
    let approval = store
        .approval_by_id(&approval_id)
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError::task(TaskRuntimeError::NotFound(approval_id.clone())))?;
    ApprovalGate::new()
        .reject(
            &store,
            &approval_id,
            gateway_user_id().as_str(),
            &request.reason,
        )
        .map_err(GatewayError::task)?;
    drop(store);
    sync_computer_session_after_approval(&state, &approval, ApprovalState::Rejected)?;
    Ok(Json(task_queue_response_for_state(&state)?))
}

fn sync_computer_session_after_approval(
    state: &AppState,
    approval: &ApprovalRequest,
    approval_state: ApprovalState,
) -> Result<(), GatewayError> {
    let task_id = approval.task_id.as_str();
    let thread = {
        let chat_store = lock_store(state)?;
        chat_store
            .thread_by_task_id(task_id)
            .map_err(GatewayError::store)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };

    let mut computer_store = lock_computer_store(state)?;
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let Some(mut session) = computer_store
        .session(
            &thread.computer_session_id,
            user.as_str(),
            workspace.as_str(),
        )
        .map_err(GatewayError::local_computer)?
    else {
        return Ok(());
    };

    let now = OffsetDateTime::now_utc();
    session.status = match approval_state {
        ApprovalState::Approved => SessionStatus::Running,
        ApprovalState::Rejected => SessionStatus::Cancelled,
        ApprovalState::None | ApprovalState::WaitingUser => SessionStatus::WaitingUser,
    };
    session.approval_state = approval_state;
    session.progress_current = session.progress_current.max(1);
    session.updated_at = now;
    if approval_state == ApprovalState::Rejected {
        session.last_error = Some("Approval rifiutata dall'utente.".to_string());
    }
    computer_store
        .upsert_session(&session)
        .map_err(GatewayError::local_computer)?;

    match approval_state {
        ApprovalState::Approved => append_computer_event(
            &mut computer_store,
            &thread.computer_session_id,
            &user,
            &workspace,
            SurfaceKind::Logs,
            "computer_approval_approved",
            "done",
            "Approval confermata",
            "Il task locale e' stato messo in coda.",
            false,
        )?,
        ApprovalState::Rejected => append_computer_event(
            &mut computer_store,
            &thread.computer_session_id,
            &user,
            &workspace,
            SurfaceKind::Logs,
            "computer_approval_rejected",
            "done",
            "Approval rifiutata",
            "Il task locale e' stato annullato prima dell'esecuzione.",
            false,
        )?,
        ApprovalState::None | ApprovalState::WaitingUser => {}
    }
    Ok(())
}

fn persist_browser_approval_options(
    state: &AppState,
    approval: &ApprovalRequest,
    task: &TaskRecord,
    options: &ApproveApprovalRequest,
) -> Result<(), GatewayError> {
    if parse_approval_scope(options.scope.as_deref()) != BrowserUrlApprovalScope::Always {
        return Ok(());
    }
    if !task_uses_browser(task) || !approval_allows_browser_policy(approval) {
        return Ok(());
    }
    let visibility = parse_browser_visibility(options.browser_visibility.as_deref());
    let policy_store = lock_browser_url_policies(state)?;
    for target in browser_targets_for_goal(&task_effective_goal(task)) {
        policy_store
            .grant(&BrowserUrlApprovalGrant {
                user_id: approval.user_id.as_str().to_string(),
                workspace_id: approval.workspace_id.as_str().to_string(),
                url: target.url,
                action: "navigate".to_string(),
                scope: BrowserUrlApprovalScope::Always,
                visibility,
            })
            .map_err(|error| GatewayError {
                status: StatusCode::BAD_GATEWAY,
                code: "browser_url_policy_error",
                message: error.to_string(),
            })?;
    }
    Ok(())
}

fn append_browser_approval_checkpoint(
    store: &TaskStore,
    approval: &ApprovalRequest,
    task: &TaskRecord,
    options: &ApproveApprovalRequest,
) -> Result<(), TaskRuntimeError> {
    if !task_uses_browser(task) || !approval_allows_browser_policy(approval) {
        return Ok(());
    }
    let scope = parse_approval_scope(options.scope.as_deref());
    let visibility = parse_browser_visibility(options.browser_visibility.as_deref());
    store.append_checkpoint(
        &approval.task_id,
        &approval.user_id,
        &approval.workspace_id,
        serde_json::json!({
            "kind": "browser_approval_options",
            "approval": {
                "decision": "approved",
                "action": approval.action,
            },
            "scope": approval_scope_label(scope),
            "browser_visibility": browser_visibility_label(visibility),
        }),
        serde_json::json!({
            "kind": "browser_approval_options",
            "approval": {
                "decision": "approved",
                "action": approval.action,
            },
            "scope": approval_scope_label(scope),
            "browser_visibility": browser_visibility_label(visibility),
        }),
    )?;
    Ok(())
}

fn approval_allows_browser_policy(approval: &ApprovalRequest) -> bool {
    approval.action == "browser.manual_action"
        || approval.action == "prompt_plan.approve_step"
        || approval.data_boundary.contains("browser")
        || approval.explanation.to_lowercase().contains("browser")
}

fn run_next_task_once(
    state: &AppState,
    worker_id: &str,
) -> Result<TaskRunBatchResponse, GatewayError> {
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let now = OffsetDateTime::now_utc();
    let governor = ResourceGovernor::new(ResourceLimits::conservative_defaults());
    let lease_manager = LeaseManager::new(Duration::minutes(5));
    let task = {
        let store = lock_task_store(state)?;
        let scheduler = TaskScheduler::new();
        lease_manager
            .recover_stale_leases(&store, &user, &workspace, now)
            .map_err(GatewayError::task)?;
        scheduler
            .mark_blocked_by_terminal_dependencies(&store, &user, &workspace)
            .map_err(GatewayError::task)?;
        scheduler
            .ready_tasks(&store, &user, &workspace, now, 1)
            .map_err(GatewayError::task)?
            .into_iter()
            .next()
    };
    let Some(task) = task else {
        return Ok(TaskRunBatchResponse {
            status: "idle".to_string(),
            completed: 0,
            stopped_reason: Some("Nessun task approvato in coda.".to_string()),
            results: vec![],
        });
    };

    let task_id = task.task_id.as_str().to_string();
    let mut task = match acquire_task_for_execution(
        state,
        task,
        &user,
        &workspace,
        &governor,
        &lease_manager,
        worker_id,
        now,
    )? {
        TaskAcquireResult::Acquired(task) => task,
        TaskAcquireResult::WaitingResource(reason) => {
            return Ok(TaskRunBatchResponse {
                status: "waiting_resource".to_string(),
                completed: 0,
                stopped_reason: Some(reason),
                results: vec![TaskRunStepResponse {
                    status: "waiting_resource".to_string(),
                    task_id: Some(task_id),
                    message: "Risorse locali non ancora disponibili.".to_string(),
                }],
            });
        }
        TaskAcquireResult::LeaseBusy => {
            return Ok(TaskRunBatchResponse {
                status: "skipped".to_string(),
                completed: 0,
                stopped_reason: Some("Task gia' in esecuzione da un altro worker.".to_string()),
                results: vec![TaskRunStepResponse {
                    status: "skipped".to_string(),
                    task_id: Some(task_id),
                    message: "Lease gia' attivo.".to_string(),
                }],
            });
        }
    };
    sync_session_for_task_run(state, &task, SessionStatus::Running, 1, None)?;
    append_task_progress_checkpoint(
        state,
        &task,
        "execution_started",
        SurfaceKind::Logs,
        "Task avviato",
        "Esecuzione locale approvata e presa in carico dal worker.",
        serde_json::json!({
            "kind": "execution_started",
            "worker_id": worker_id,
            "task_id": task.task_id.as_str(),
        }),
    )?;

    let execution_task = match task_with_dependency_outputs(state, &task) {
        Ok(task) => task,
        Err(error) => {
            mark_task_failed(state, &mut task, &error.message)?;
            sync_session_for_task_run(
                state,
                &task,
                SessionStatus::Failed,
                1,
                Some(error.message.clone()),
            )?;
            return Ok(TaskRunBatchResponse {
                status: "failed".to_string(),
                completed: 0,
                stopped_reason: Some(error.message.clone()),
                results: vec![TaskRunStepResponse {
                    status: "failed".to_string(),
                    task_id: Some(task_id),
                    message: error.message,
                }],
            });
        }
    };

    let outcome = match execute_read_only_task(state, &execution_task) {
        Ok(outcome) => outcome,
        Err(error) => {
            mark_task_failed(state, &mut task, &error.message)?;
            sync_session_for_task_run(
                state,
                &task,
                SessionStatus::Failed,
                1,
                Some(error.message.clone()),
            )?;
            return Ok(TaskRunBatchResponse {
                status: "failed".to_string(),
                completed: 0,
                stopped_reason: Some(error.message.clone()),
                results: vec![TaskRunStepResponse {
                    status: "failed".to_string(),
                    task_id: Some(task_id),
                    message: error.message,
                }],
            });
        }
    };

    {
        let store = lock_task_store(state)?;
        store
            .append_checkpoint(
                &task.task_id,
                &user,
                &workspace,
                outcome.checkpoint_payload.clone(),
                outcome.checkpoint_redacted.clone(),
            )
            .map_err(GatewayError::task)?;
    }
    append_task_observation_to_session(state, &task, &outcome)?;
    if outcome.completed {
        mark_task_completed(state, &mut task)?;
        sync_session_for_task_run(state, &task, SessionStatus::Completed, 3, None)?;
    } else if let Some(approval) = outcome.pending_approval.as_ref() {
        request_task_executor_approval(state, &mut task, approval)?;
        sync_session_for_task_run(
            state,
            &task,
            SessionStatus::WaitingUser,
            2,
            Some(approval.explanation.clone()),
        )?;
    } else {
        let reason = outcome
            .blocked_reason
            .as_deref()
            .unwrap_or("Il piano operativo non ha soddisfatto i criteri di successo.");
        mark_task_waiting_external(state, &mut task, reason)?;
        sync_session_for_task_run(
            state,
            &task,
            SessionStatus::Paused,
            2,
            Some(reason.to_string()),
        )?;
    }
    append_task_result_to_chat(state, &task_id, &outcome.chat_message)?;

    Ok(TaskRunBatchResponse {
        status: if outcome.completed {
            "completed".to_string()
        } else if outcome.pending_approval.is_some() {
            "waiting_user_approval".to_string()
        } else {
            "blocked".to_string()
        },
        completed: u32::from(outcome.completed),
        stopped_reason: outcome.blocked_reason.clone(),
        results: vec![TaskRunStepResponse {
            status: if outcome.completed {
                "completed".to_string()
            } else if outcome.pending_approval.is_some() {
                "waiting_user_approval".to_string()
            } else {
                "blocked".to_string()
            },
            task_id: Some(task_id),
            message: outcome.summary,
        }],
    })
}

fn start_task_executor_worker(state: AppState) {
    if !task_executor_worker_enabled() {
        return;
    }
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(StdDuration::from_millis(TASK_EXECUTOR_POLL_INTERVAL_MS));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            update_task_executor_status(&state, |status| {
                status.status = "polling".to_string();
                status.last_tick_at = Some(OffsetDateTime::now_utc().to_string());
                status.last_message = "Controllo coda task locale.".to_string();
            });

            let state_for_worker = state.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_next_task_once(&state_for_worker, TASK_EXECUTOR_WORKER_ID)
            })
            .await;

            match result {
                Ok(Ok(batch)) => record_task_executor_batch(&state, batch),
                Ok(Err(error)) => {
                    let message = error.message.clone();
                    update_task_executor_status(&state, |status| {
                        status.status = "failed".to_string();
                        status.failure_count += 1;
                        status.last_message = message.clone();
                    });
                    eprintln!("task executor worker error: {message}");
                }
                Err(error) => {
                    let message = error.to_string();
                    update_task_executor_status(&state, |status| {
                        status.status = "failed".to_string();
                        status.failure_count += 1;
                        status.last_message = message.clone();
                    });
                    eprintln!("task executor worker join error: {message}");
                }
            }
        }
    });
}

fn record_task_executor_batch(state: &AppState, batch: TaskRunBatchResponse) {
    update_task_executor_status(state, |status| {
        status.last_task_id = batch
            .results
            .iter()
            .find_map(|result| result.task_id.clone())
            .or_else(|| status.last_task_id.clone());
        status.last_message = batch
            .stopped_reason
            .clone()
            .or_else(|| batch.results.first().map(|result| result.message.clone()))
            .unwrap_or_else(|| "Coda task controllata.".to_string());
        status.status = batch.status.clone();
        status.completed_count += u64::from(batch.completed);
        if batch.status == "failed" {
            status.failure_count += 1;
        }
    });
}

fn task_executor_worker_enabled() -> bool {
    env::var("LOCAL_FIRST_TASK_EXECUTOR_WORKER")
        .map(|value| {
            let normalized = value.trim().to_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "off" | "disabled")
        })
        .unwrap_or(true)
}

fn update_task_executor_status(state: &AppState, update: impl FnOnce(&mut TaskExecutorStatus)) {
    if let Ok(mut status) = state.task_executor_status.lock() {
        update(&mut status);
    }
}

fn task_executor_status_response(
    state: &AppState,
) -> Result<TaskExecutorStatusResponse, GatewayError> {
    let status = lock_task_executor_status(state)?;
    Ok(TaskExecutorStatusResponse {
        enabled: status.enabled,
        worker_id: status.worker_id.clone(),
        poll_interval_ms: status.poll_interval_ms,
        status: status.status.clone(),
        last_tick_at: status.last_tick_at.clone(),
        last_task_id: status.last_task_id.clone(),
        last_message: status.last_message.clone(),
        completed_count: status.completed_count,
        failure_count: status.failure_count,
    })
}

enum TaskAcquireResult {
    Acquired(TaskRecord),
    WaitingResource(String),
    LeaseBusy,
}

#[allow(clippy::too_many_arguments)]
fn acquire_task_for_execution(
    state: &AppState,
    task: TaskRecord,
    user: &UserId,
    workspace: &WorkspaceId,
    governor: &ResourceGovernor,
    lease_manager: &LeaseManager,
    worker_id: &str,
    now: OffsetDateTime,
) -> Result<TaskAcquireResult, GatewayError> {
    let store = lock_task_store(state)?;
    if governor
        .mark_waiting_if_unavailable(&store, &task)
        .map_err(GatewayError::task)?
    {
        let blocked_reason = store
            .get_task(&task.task_id, user, workspace)
            .map_err(GatewayError::task)?
            .and_then(|task| task.blocked_reason)
            .unwrap_or_else(|| "Risorse locali non disponibili.".to_string());
        return Ok(TaskAcquireResult::WaitingResource(blocked_reason));
    }
    if !lease_manager
        .acquire(&store, &task.task_id, user, workspace, worker_id, now)
        .map_err(GatewayError::task)?
    {
        return Ok(TaskAcquireResult::LeaseBusy);
    }
    let leased = store
        .get_task(&task.task_id, user, workspace)
        .map_err(GatewayError::task)?
        .ok_or_else(|| {
            GatewayError::task(TaskRuntimeError::NotFound(
                task.task_id.as_str().to_string(),
            ))
        })?;
    governor
        .reserve(&store, &leased, worker_id)
        .map_err(GatewayError::task)?;
    Ok(TaskAcquireResult::Acquired(leased))
}

fn mark_task_completed(state: &AppState, task: &mut TaskRecord) -> Result<(), GatewayError> {
    task.status = TaskStatus::Completed;
    task.blocked_reason = None;
    task.lease_owner = None;
    task.lease_expires_at = None;
    task.last_heartbeat_at = None;
    task.updated_at = OffsetDateTime::now_utc();
    let store = lock_task_store(state)?;
    store.release_resources(task).map_err(GatewayError::task)?;
    store.insert_task(task).map_err(GatewayError::task)
}

fn mark_task_failed(
    state: &AppState,
    task: &mut TaskRecord,
    reason: &str,
) -> Result<(), GatewayError> {
    task.status = TaskStatus::Failed;
    task.blocked_reason = Some(reason.to_string());
    task.lease_owner = None;
    task.lease_expires_at = None;
    task.last_heartbeat_at = None;
    task.updated_at = OffsetDateTime::now_utc();
    let store = lock_task_store(state)?;
    store.release_resources(task).map_err(GatewayError::task)?;
    store.insert_task(task).map_err(GatewayError::task)
}

fn mark_task_waiting_external(
    state: &AppState,
    task: &mut TaskRecord,
    reason: &str,
) -> Result<(), GatewayError> {
    task.status = TaskStatus::WaitingExternalEvent;
    task.blocked_reason = Some(reason.to_string());
    task.lease_owner = None;
    task.lease_expires_at = None;
    task.last_heartbeat_at = None;
    task.updated_at = OffsetDateTime::now_utc();
    let store = lock_task_store(state)?;
    store.release_resources(task).map_err(GatewayError::task)?;
    store.insert_task(task).map_err(GatewayError::task)
}

fn request_task_executor_approval(
    state: &AppState,
    task: &mut TaskRecord,
    approval: &PendingExecutorApproval,
) -> Result<ApprovalRequest, GatewayError> {
    let store = lock_task_store(state)?;
    let approval_request = ApprovalGate::new()
        .request_approval(
            &store,
            &task.task_id,
            &task.user_id,
            &task.workspace_id,
            &approval.action,
            &approval.risk_level,
            &approval.data_boundary,
            &approval.explanation,
        )
        .map_err(GatewayError::task)?;
    task.status = TaskStatus::WaitingUserApproval;
    task.blocked_reason = Some(format!("approval required: {}", approval.action));
    task.lease_owner = None;
    task.lease_expires_at = None;
    task.last_heartbeat_at = None;
    task.updated_at = OffsetDateTime::now_utc();
    store.release_resources(task).map_err(GatewayError::task)?;
    store.insert_task(task).map_err(GatewayError::task)?;
    Ok(approval_request)
}

/// Computes the session-level `(status, progress_current)` for a thread whose
/// work was fanned out by the Brain into N member tasks. Reads each member's
/// terminal state from the durable task store:
/// - `progress_current` = number of members that have completed,
/// - status is `WaitingUser` if any member needs approval, else `Failed` if all
///   members are terminal and at least one failed/cancelled, else `Completed`
///   when every member is terminal, else `Running`.
///
/// Returns `None` when the thread has no linked members (caller keeps the
/// legacy per-task values), so the single-task path is never affected.
fn aggregate_member_session_state(
    state: &AppState,
    thread: &local_first_desktop_gateway::ChatThread,
    user: &UserId,
    workspace: &WorkspaceId,
) -> Result<Option<(SessionStatus, u32)>, GatewayError> {
    let member_ids = {
        let chat_store = lock_store(state)?;
        chat_store
            .member_task_ids_for_thread(&thread.thread_id)
            .map_err(GatewayError::store)?
    };
    if member_ids.is_empty() {
        return Ok(None);
    }

    let counts = {
        let store = lock_task_store(state)?;
        collect_member_counts(&store, &member_ids, user, workspace).map_err(GatewayError::task)?
    };
    Ok(Some(aggregate_session_state_from_counts(
        member_ids.len(),
        counts.completed,
        counts.terminal,
        counts.any_failed,
        counts.any_waiting_user,
    )))
}

/// Terminal-state tally of a thread's member tasks, read from the durable store.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct MemberCounts {
    completed: u32,
    terminal: u32,
    any_failed: bool,
    any_waiting_user: bool,
}

/// Reads each member task's status from the durable store and tallies it.
/// Separated from [`aggregate_member_session_state`] so the store-reading loop
/// is testable against an in-memory `TaskStore` without a full `AppState`.
/// Missing tasks are skipped (treated as not-yet-terminal).
fn collect_member_counts(
    store: &TaskStore,
    member_ids: &[String],
    user: &UserId,
    workspace: &WorkspaceId,
) -> Result<MemberCounts, TaskRuntimeError> {
    let mut counts = MemberCounts::default();
    for task_id in member_ids {
        let Some(member) = store.get_task(&TaskId::new(task_id.clone()), user, workspace)? else {
            continue;
        };
        match member.status {
            TaskStatus::Completed => {
                counts.completed += 1;
                counts.terminal += 1;
            }
            TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Expired => {
                counts.any_failed = true;
                counts.terminal += 1;
            }
            TaskStatus::WaitingUserApproval => counts.any_waiting_user = true,
            _ => {}
        }
    }
    Ok(counts)
}

/// Pure decision for the aggregate session status given member-task counts.
/// Extracted from [`aggregate_member_session_state`] so the branch logic is
/// unit-testable without standing up the durable stores.
fn aggregate_session_state_from_counts(
    total: usize,
    completed: u32,
    terminal: u32,
    any_failed: bool,
    any_waiting_user: bool,
) -> (SessionStatus, u32) {
    let all_terminal = terminal as usize >= total;
    let status = if any_waiting_user {
        SessionStatus::WaitingUser
    } else if all_terminal && any_failed {
        SessionStatus::Failed
    } else if all_terminal {
        SessionStatus::Completed
    } else {
        SessionStatus::Running
    };
    (status, completed)
}

fn sync_session_for_task_run(
    state: &AppState,
    task: &TaskRecord,
    status: SessionStatus,
    progress_current: u32,
    last_error: Option<String>,
) -> Result<(), GatewayError> {
    let thread = {
        let chat_store = lock_store(state)?;
        chat_store
            .thread_by_task_id(task.task_id.as_str())
            .map_err(GatewayError::store)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();

    // A1.2 aggregation: when this task is a Brain-materialized *member* (its id
    // differs from the thread's primary task_id, so it resolved via the link
    // table), the per-task status/progress passed by the run loop describes ONE
    // step, not the whole session. Recompute session-level status/progress from
    // the terminal state of all members so the one session reflects N tasks and
    // only flips to Completed when the last member finishes.
    let (status, progress_current) = if thread.task_id.as_str() != task.task_id.as_str() {
        aggregate_member_session_state(state, &thread, &user, &workspace)?
            .unwrap_or((status, progress_current))
    } else {
        (status, progress_current)
    };

    let mut store = lock_computer_store(state)?;
    let Some(mut session) = store
        .session(
            &thread.computer_session_id,
            user.as_str(),
            workspace.as_str(),
        )
        .map_err(GatewayError::local_computer)?
    else {
        return Ok(());
    };

    session.status = status;
    session.progress_current = progress_current.min(session.progress_total);
    session.approval_state = match status {
        SessionStatus::Running | SessionStatus::Completed => ApprovalState::Approved,
        SessionStatus::WaitingUser => ApprovalState::WaitingUser,
        _ => session.approval_state,
    };
    session.last_error = last_error.clone();
    session.updated_at = OffsetDateTime::now_utc();
    store
        .upsert_session(&session)
        .map_err(GatewayError::local_computer)?;

    match status {
        SessionStatus::Running => append_computer_event(
            &mut store,
            &thread.computer_session_id,
            &user,
            &workspace,
            surface_for_task(task),
            "computer_task_running",
            "running",
            "Esecuzione locale avviata",
            "Il task approvato e' in esecuzione read-only.",
            false,
        )?,
        SessionStatus::Completed => append_computer_event(
            &mut store,
            &thread.computer_session_id,
            &user,
            &workspace,
            surface_for_task(task),
            "computer_task_completed",
            "done",
            "Task completato",
            "Risultato sintetico disponibile in chat.",
            false,
        )?,
        SessionStatus::Failed => append_computer_event_with_payload(
            &mut store,
            &thread.computer_session_id,
            &user,
            &workspace,
            surface_for_task(task),
            "computer_task_failed",
            "failed",
            "Task non completato",
            last_error.as_deref().unwrap_or("Errore locale redatto."),
            serde_json::json!({ "error": last_error.clone().unwrap_or_else(|| "Errore locale redatto.".to_string()) }),
            false,
            vec![],
        )?,
        SessionStatus::WaitingUser => append_computer_event_with_payload(
            &mut store,
            &thread.computer_session_id,
            &user,
            &workspace,
            surface_for_task(task),
            "computer_task_waiting_approval",
            "waiting_user",
            "Approval richiesta",
            last_error
                .as_deref()
                .unwrap_or("Serve una conferma per continuare."),
            serde_json::json!({
                "approval_required": true,
                "reason": last_error.clone().unwrap_or_else(|| "Serve una conferma per continuare.".to_string()),
            }),
            true,
            vec![],
        )?,
        _ => {}
    }
    Ok(())
}

fn append_task_result_to_chat(
    state: &AppState,
    task_id: &str,
    message_text: &str,
) -> Result<(), GatewayError> {
    let thread = {
        let chat_store = lock_store(state)?;
        chat_store
            .thread_by_task_id(task_id)
            .map_err(GatewayError::store)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };
    let now = OffsetDateTime::now_utc();
    let message = local_first_desktop_gateway::ChatMessage {
        id: format!("assistant_task_{}_{}", task_id, now.unix_timestamp_nanos()),
        role: "assistant".to_string(),
        text: message_text.to_string(),
        timestamp: now.unix_timestamp().to_string(),
        metadata: Some("Executor locale".to_string()),
        metrics: None,
        feedback: None,
        saved_memory_ref: None,
        linked_task_id: Some(task_id.to_string()),
        linked_automation_ref: None,
        attachments: Vec::new(),
    };
    lock_store(state)?
        .append_assistant_message(&thread.thread_id, &message)
        .map_err(GatewayError::store)?;
    Ok(())
}

fn append_task_observation_to_session(
    state: &AppState,
    task: &TaskRecord,
    outcome: &TaskExecutionOutcome,
) -> Result<(), GatewayError> {
    let thread = {
        let chat_store = lock_store(state)?;
        chat_store
            .thread_by_task_id(task.task_id.as_str())
            .map_err(GatewayError::store)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let mut store = lock_computer_store(state)?;
    for artifact in &outcome.artifacts {
        store
            .upsert_artifact(&ArtifactRecord {
                artifact_id: artifact.artifact_id.clone(),
                session_id: thread.computer_session_id.clone(),
                user_id: user.as_str().to_string(),
                workspace_id: workspace.as_str().to_string(),
                title: artifact.title.clone(),
                kind: artifact.kind.clone(),
                path_ref: artifact.path_ref.clone(),
                size_bytes: artifact.size_bytes,
                preview_ref: artifact.preview_ref.clone(),
                created_at: OffsetDateTime::now_utc(),
            })
            .map_err(GatewayError::local_computer)?;
    }
    let artifact_refs = outcome
        .artifacts
        .iter()
        .map(|artifact| artifact.artifact_id.clone())
        .collect::<Vec<_>>();
    append_computer_event_with_payload(
        &mut store,
        &thread.computer_session_id,
        &user,
        &workspace,
        outcome.surface,
        &outcome.event_kind,
        "done",
        &outcome.event_title,
        &outcome.event_subtitle,
        outcome.event_payload.clone(),
        false,
        artifact_refs,
    )
}

fn append_task_progress_checkpoint(
    state: &AppState,
    task: &TaskRecord,
    phase: &str,
    surface: SurfaceKind,
    title: &str,
    subtitle: &str,
    payload: Value,
) -> Result<(), GatewayError> {
    {
        let store = lock_task_store(state)?;
        store
            .append_checkpoint(
                &task.task_id,
                &task.user_id,
                &task.workspace_id,
                payload.clone(),
                payload.clone(),
            )
            .map_err(GatewayError::task)?;
    }
    append_task_progress_event(state, task, phase, surface, title, subtitle, payload)
}

fn append_operational_plan_progress(
    state: &AppState,
    task: &TaskRecord,
    plan: &OperationalPlan,
    phase: &str,
    title: &str,
    subtitle: &str,
) -> Result<(), GatewayError> {
    append_task_progress_checkpoint(
        state,
        task,
        phase,
        SurfaceKind::Logs,
        title,
        subtitle,
        serde_json::json!({
            "kind": phase,
            "operational_plan": operational_plan_payload(plan),
            "operational_plan_markdown": operational_plan_markdown(plan),
        }),
    )
}

fn append_task_progress_event(
    state: &AppState,
    task: &TaskRecord,
    phase: &str,
    surface: SurfaceKind,
    title: &str,
    subtitle: &str,
    payload: Value,
) -> Result<(), GatewayError> {
    let thread = {
        let chat_store = lock_store(state)?;
        chat_store
            .thread_by_task_id(task.task_id.as_str())
            .map_err(GatewayError::store)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };
    let mut store = lock_computer_store(state)?;
    append_computer_event_with_payload(
        &mut store,
        &thread.computer_session_id,
        &task.user_id,
        &task.workspace_id,
        surface,
        phase,
        "running",
        title,
        subtitle,
        payload,
        false,
        vec![],
    )
}

#[derive(Debug)]
struct LocalTaskExecutionError {
    message: String,
}

fn local_task_gateway_error(error: GatewayError) -> LocalTaskExecutionError {
    LocalTaskExecutionError {
        message: error.message,
    }
}

fn task_with_dependency_outputs(
    state: &AppState,
    task: &TaskRecord,
) -> Result<TaskRecord, LocalTaskExecutionError> {
    let store = lock_task_store(state).map_err(local_task_gateway_error)?;
    let dependency_outputs = store
        .dependency_outputs_for(&task.task_id, &task.user_id, &task.workspace_id)
        .map_err(GatewayError::task)
        .map_err(local_task_gateway_error)?;
    if dependency_outputs.is_empty() {
        return Ok(task.clone());
    }

    let outputs = dependency_outputs
        .into_iter()
        .map(|dependency| {
            serde_json::json!({
                "task_id": dependency.task_id.as_str(),
                "output": dependency.output,
                "redacted_output": dependency.redacted_output,
            })
        })
        .collect::<Vec<_>>();

    let mut enriched = task.clone();
    let mut input = enriched.input_json.as_object().cloned().unwrap_or_default();
    input.insert("previous_step_outputs".to_string(), Value::Array(outputs));
    enriched.input_json = Value::Object(input);
    Ok(enriched)
}

fn execute_read_only_task(
    state: &AppState,
    task: &TaskRecord,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    match state
        .task_executor_registry
        .resolve(task.kind.as_str())
        .unwrap_or(GatewayTaskExecutorKind::LegacyLocal)
    {
        GatewayTaskExecutorKind::CapabilityBrowser => execute_capability_browser_task(state, task),
        GatewayTaskExecutorKind::CapabilityGeneric => execute_capability_generic(state, task),
        GatewayTaskExecutorKind::Subagent => execute_subagent_task(task),
        GatewayTaskExecutorKind::LegacyShell => execute_shell_read_only_task(task),
        GatewayTaskExecutorKind::LegacyBrowser => execute_browser_read_only_task(state, task),
        GatewayTaskExecutorKind::LegacyLocal => execute_local_read_only_task(task),
    }
}

fn execute_capability_browser_task(
    state: &AppState,
    task: &TaskRecord,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    let payload: CapabilityTaskPayload =
        serde_json::from_value(task.input_json.clone()).map_err(|error| {
            LocalTaskExecutionError {
                message: format!("Payload capability browser non valido: {error}"),
            }
        })?;
    let method = browser_method_for_capability_tool(&payload.call.tool_name).ok_or_else(|| {
        LocalTaskExecutionError {
            message: format!("Tool browser non supportato: {}", payload.call.tool_name),
        }
    })?;

    append_task_progress_checkpoint(
        state,
        task,
        "capability_browser_executor_started",
        SurfaceKind::Browser,
        "Executor browser",
        &format!(
            "Eseguo capability `{}` tramite BrowserTaskExecutor.",
            payload.call.tool_name
        ),
        serde_json::json!({
            "kind": "capability_browser_executor_started",
            "tool": payload.call.tool_name,
            "provider": payload.call.provider_id.as_str(),
        }),
    )
    .map_err(local_task_gateway_error)?;

    let result =
        execute_persistent_browser_capability(state, task, method, payload.call.arguments)?;

    task_execution_outcome_from_executor_result(
        task,
        "browser-capability-executor",
        &payload.call.tool_name,
        result,
    )
}

/// True when a browser client error means the single persistent sidecar process
/// is gone (broken IPC pipe, or a garbled/empty reply because the child closed
/// its stdout) and the cached handle should be dropped so the next attempt
/// respawns. `InvalidRequest` is our own serialization bug and the policy/path
/// blocks are legitimate per-call errors — none of those imply a dead process.
fn browser_error_indicates_dead_sidecar(error: &BrowserAutomationError) -> bool {
    matches!(
        error,
        BrowserAutomationError::Sidecar(_) | BrowserAutomationError::InvalidResponse(_)
    )
}

/// Fixed label for the one tab the execution surface manages per session. Using
/// a constant label (instead of a runtime-generated id) lets the planner emit
/// high-level steps while the executor keeps a stable target.
const BROWSER_MANAGED_TARGET: &str = "primary";

/// Maps a planner-level browser call onto the executor-managed tab.
///
/// The sidecar's capability tools are tab-scoped: `navigate`/`act`/`snapshot`/…
/// all require a `target_id`. But the planner emits intent ("navigate to URL",
/// "fill these fields") and cannot know a tab id that only exists at runtime. So
/// the single execution surface owns ONE managed tab (label "primary"):
/// - `navigate {url}` with no target becomes an idempotent `open {url, label}`
///   (open creates the tab on first use and re-navigates it afterwards),
/// - other tab-scoped calls get `target_id` injected,
/// - tabless calls (health/profiles/tabs/open/start/stop) pass through.
/// A call that already carries an explicit `target_id` is left untouched.
fn normalize_browser_call(method: BrowserMethod, mut params: Value) -> (BrowserMethod, Value) {
    let has_target = params
        .get("target_id")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    if has_target {
        return (method, params);
    }
    if !params.is_object() {
        params = serde_json::json!({});
    }
    match method {
        BrowserMethod::Navigate => {
            // open is idempotent on the label: creates+navigates the managed tab.
            params["label"] = serde_json::json!(BROWSER_MANAGED_TARGET);
            (BrowserMethod::Open, params)
        }
        BrowserMethod::Snapshot
        | BrowserMethod::Act
        | BrowserMethod::Screenshot
        | BrowserMethod::Console
        | BrowserMethod::Pdf
        | BrowserMethod::Focus
        | BrowserMethod::CloseTab
        | BrowserMethod::ArmFileChooser
        | BrowserMethod::RespondDialog
        | BrowserMethod::WaitDownload => {
            params["target_id"] = serde_json::json!(BROWSER_MANAGED_TARGET);
            (method, params)
        }
        BrowserMethod::Health
        | BrowserMethod::Profiles
        | BrowserMethod::Tabs
        | BrowserMethod::Open
        | BrowserMethod::Start
        | BrowserMethod::Stop => (method, params),
    }
}

/// Outcome of a call against the single shared browser sidecar.
enum SharedSidecarCall {
    /// The sidecar replied (the response may still be a browser-level error).
    Response(BrowserResponse),
    /// The sidecar process was gone; the cached handle has been dropped and the
    /// task should retry (which respawns a fresh sidecar). Carries the reason.
    SidecarLost(String),
}

/// THE single browser execution surface (A1.3). All durable browser capability
/// execution flows through here so there is exactly one owner of the persistent
/// sidecar: this function holds `state.browser_capability_client`, lazily spawns
/// the process once, reuses it across calls/tasks, and self-heals by dropping a
/// dead handle. Any future live read-only provider must delegate here rather
/// than spawn a competing sidecar.
fn call_shared_browser_sidecar(
    state: &AppState,
    task: &TaskRecord,
    method: BrowserMethod,
    params: Value,
) -> Result<SharedSidecarCall, LocalTaskExecutionError> {
    // Map the planner-level call onto the managed tab (inject/translate target).
    let (method, params) = normalize_browser_call(method, params);
    let mut client_guard =
        state
            .browser_capability_client
            .lock()
            .map_err(|error| LocalTaskExecutionError {
                message: format!("Browser capability lock fallita: {error}"),
            })?;
    if client_guard.is_none() {
        *client_guard = Some(BrowserAutomationClient::new(
            spawn_browser_sidecar_for_task(state, task)?,
        ));
    }
    // Borrow the shared client only for the call so we can replace it afterwards
    // if the sidecar turns out to be dead.
    let call_result = {
        let client = client_guard
            .as_ref()
            .ok_or_else(|| LocalTaskExecutionError {
                message: "Browser capability non inizializzato.".to_string(),
            })?;
        client.call_response(method, params)
    };
    match call_result {
        Ok(response) => Ok(SharedSidecarCall::Response(response)),
        // Self-heal: a broken IPC pipe (Sidecar) or a garbled/empty reply
        // (InvalidResponse, e.g. the child closed stdout) means the single
        // persistent sidecar process is gone. Drop the dead handle so the next
        // attempt respawns a fresh one, and let the durable task runtime retry
        // instead of failing the task permanently against a corpse.
        Err(error) if browser_error_indicates_dead_sidecar(&error) => {
            *client_guard = None;
            Ok(SharedSidecarCall::SidecarLost(format!(
                "browser sidecar lost ({error}); respawning on retry"
            )))
        }
        Err(error) => Err(LocalTaskExecutionError {
            message: format!("Browser capability fallita: {error}"),
        }),
    }
}

fn execute_persistent_browser_capability(
    state: &AppState,
    task: &TaskRecord,
    method: BrowserMethod,
    params: Value,
) -> Result<ExecutorResult, LocalTaskExecutionError> {
    let response = match call_shared_browser_sidecar(state, task, method, params.clone())? {
        SharedSidecarCall::SidecarLost(reason) => {
            return Ok(ExecutorResult::RetryableFailure { reason });
        }
        SharedSidecarCall::Response(response) => response,
    };
    match response {
        BrowserResponse::Success {
            ok: true, result, ..
        } if method == BrowserMethod::Snapshot => Ok(ExecutorResult::Checkpoint {
            payload: result.clone(),
            redacted_payload: browser_capability_redacted_checkpoint(method, &params, result),
        }),
        BrowserResponse::Success {
            ok: true, result, ..
        } => Ok(ExecutorResult::Completed { output: result }),
        BrowserResponse::Success { .. } => Ok(ExecutorResult::RetryableFailure {
            reason: "browser returned invalid success envelope".to_string(),
        }),
        BrowserResponse::Error { error, .. } if error.manual_action_required => {
            Ok(ExecutorResult::NeedsApproval {
                action: "browser.manual_action".to_string(),
                risk_level: "medium".to_string(),
                data_boundary: "local_browser".to_string(),
                explanation: error.message,
            })
        }
        BrowserResponse::Error { error, .. } => Ok(ExecutorResult::RetryableFailure {
            reason: format!("{}:{}", error.code, error.message),
        }),
    }
}

fn browser_capability_redacted_checkpoint(
    method: BrowserMethod,
    params: &Value,
    result: Value,
) -> Value {
    let method_name = serde_json::to_value(method).unwrap_or(Value::Null);
    let target_id = params.get("target_id").cloned().unwrap_or(Value::Null);
    let mut browser = serde_json::json!({
        "method": method_name,
        "target_id": target_id,
    });
    if let Some(url) = result.get("url") {
        browser["url"] = url.clone();
    }
    if let Some(snapshot) = result.get("snapshot").and_then(Value::as_str) {
        browser["snapshot_excerpt"] =
            Value::String(redact_sensitive_text(&truncate_chars(snapshot, 2_000)));
    }
    browser
}

/// Runs a `subagent.*` task through the real `SubagentTaskExecutor` (trait-based)
/// and bridges its `ExecutorResult` into the gateway's `TaskExecutionOutcome`
/// (ADR 0008 pillar #3 / GAP 4: de-stub the registered executors). The runner
/// only needs the local LLM runtime.
fn execute_subagent_task(
    task: &TaskRecord,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    // Pick the model that best fits THIS task's goal: the semantic stage-2 router
    // (with heuristic fallback) over the "orchestrator" role.
    let goal = task
        .input_json
        .get("goal")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let router = match resolve_role_for_task(goal, "orchestrator") {
        Some(resolved) => build_router_for_resolved(&resolved),
        None => router_for_role("orchestrator"),
    };

    let mut executor = SubagentTaskExecutor::new(router);
    let executor_id = executor.executor_id().to_string();
    let result = executor
        .execute_step(task, None)
        .map_err(|error| LocalTaskExecutionError {
            message: format!("subagent executor failed: {error}"),
        })?;
    // Reuse the existing ExecutorResult -> TaskExecutionOutcome bridge (the same
    // one the browser capability path uses).
    task_execution_outcome_from_executor_result(task, &executor_id, "subagent", result)
}

/// P2: executes a non-browser `capability.*` task by building a LIVE provider
/// from the registry and dispatching through `CapabilityFacade::call_tool`.
///
/// Today MCP is wired end-to-end (the crate ships a real `McpStdioTransport`):
/// the registry connection metadata gives the command/args, the provider spawns
/// the server and speaks JSON-RPC, and the facade enforces the grant-based
/// policy before calling the tool. Composio (no real HTTP transport yet) and
/// skills (need a runner) report a clear "kind not yet wired" instead of the
/// previous blanket "unwired" — so the unlock is incremental and honest.
fn execute_capability_generic(
    state: &AppState,
    task: &TaskRecord,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    let payload: CapabilityTaskPayload =
        serde_json::from_value(task.input_json.clone()).map_err(|error| {
            LocalTaskExecutionError {
                message: format!("Payload capability non valido: {error}"),
            }
        })?;
    let call = payload.call;
    let provider_id = call.provider_id.clone();
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();

    let (kind, connection, tool_policies, policy_context) = {
        let registry = lock_capability_registry(state).map_err(local_task_gateway_error)?;
        let kind = registry
            .provider_config(&provider_id)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("provider config: {error}"),
            })?
            .map(|config| config.provider_kind)
            .ok_or_else(|| LocalTaskExecutionError {
                message: format!("provider non configurato: {}", provider_id.as_str()),
            })?;
        let connection = registry
            .connection_configs(&user, &workspace)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("connection configs: {error}"),
            })?
            .into_iter()
            .find(|config| config.provider_id == provider_id);
        let tool_policies = registry
            .cached_tools(&provider_id)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("cached tools: {error}"),
            })?
            .into_iter()
            .map(|cached| McpToolPolicy {
                tool_name: cached.tool.name,
                action: cached.tool.action,
                privacy_domains: cached.tool.privacy_domains,
                sensitivity: cached.tool.sensitivity,
            })
            .collect::<Vec<_>>();
        let policy_context = registry
            .policy_context(&user, &workspace)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("policy context: {error}"),
            })?;
        (kind, connection, tool_policies, policy_context)
    };

    let result = match kind {
        CapabilityProviderKind::Mcp => {
            let connection = connection.ok_or_else(|| LocalTaskExecutionError {
                message: format!("nessuna connessione per provider {}", provider_id.as_str()),
            })?;
            let config = mcp_stdio_config_from_metadata(&connection.metadata)?;
            let transport =
                McpStdioTransport::spawn(config).map_err(|error| LocalTaskExecutionError {
                    message: format!("avvio MCP fallito: {error}"),
                })?;
            let mut facade = CapabilityFacade::new(
                CapabilityPolicy::default(),
                InMemoryCapabilityAudit::default(),
            );
            facade.register_provider(McpCapabilityProvider::new(
                provider_id.clone(),
                true,
                transport,
                tool_policies,
            ));
            facade.call_tool(&policy_context, call)
        }
        CapabilityProviderKind::Managed => {
            let connection = connection.ok_or_else(|| LocalTaskExecutionError {
                message: format!("nessuna connessione per provider {}", provider_id.as_str()),
            })?;
            let base_url = connection
                .metadata
                .get("base_url")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| composio_base_url(None));
            let secret_ref =
                SecretRef::new(user.as_str(), workspace.as_str(), "composio", "default")
                    .map_err(|error| LocalTaskExecutionError {
                        message: format!("secret ref: {error}"),
                    })?;
            let api_key = state
                .secret_store
                .get(&secret_ref)
                .map_err(|error| LocalTaskExecutionError {
                    message: format!("secret get: {error}"),
                })?
                .ok_or_else(|| LocalTaskExecutionError {
                    message: "segreto Composio mancante".to_string(),
                })?
                .expose_utf8()
                .map_err(|error| LocalTaskExecutionError {
                    message: format!("secret decode: {error}"),
                })?;
            let mut facade = CapabilityFacade::new(
                CapabilityPolicy::default(),
                InMemoryCapabilityAudit::default(),
            );
            facade.register_provider(ComposioCapabilityProvider::new(
                ComposioProviderConfig {
                    provider_id: provider_id.clone(),
                    // MUST match the Composio entity used at link time
                    // (`composio_entity_id()` = active workspace), otherwise
                    // Composio can't resolve the connected account for the tool
                    // call. `gateway_capability_user_id()` ("local-user") is a
                    // different namespace and would yield "no connected account".
                    user_id: CapabilityUserId::new(composio_entity_id()),
                    workspace_id: gateway_capability_workspace_id(),
                    enabled: true,
                    privacy_domains: vec!["managed-cloud".to_string()],
                    tool_policies: Vec::new(),
                },
                GatewayComposioTransport::new(base_url, api_key),
            ));
            facade.call_tool(&policy_context, call)
        }
        other => return Ok(capability_kind_not_wired_outcome(task, other)),
    };

    Ok(match result {
        Ok(call_result) => capability_call_completed_outcome(task, &call_result),
        Err(error) => capability_call_failed_outcome(task, &error.to_string()),
    })
}

/// Parses an MCP stdio launch config (command/args/env) from a connection's
/// registry metadata blob.
fn mcp_stdio_config_from_metadata(
    metadata: &Value,
) -> Result<McpStdioConfig, LocalTaskExecutionError> {
    let command = metadata
        .get("command")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| LocalTaskExecutionError {
            message: "metadata MCP senza `command`".to_string(),
        })?
        .to_string();
    let args = metadata
        .get("args")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let env = metadata
        .get("env")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(McpStdioConfig { command, args, env })
}

/// Inverse of [`mcp_stdio_config_from_metadata`]: serializes a stdio config to
/// the connection metadata shape. Keeping the two as an explicit pair (and
/// round-trip tested) guarantees what `mcp/connect` writes is exactly what the
/// executor reads back — the same connect↔execute contract that, left implicit,
/// produced the earlier model-default and model-label drifts.
fn mcp_stdio_config_to_metadata(config: &McpStdioConfig) -> Value {
    let env: serde_json::Map<String, Value> = config
        .env
        .iter()
        .map(|(key, value)| (key.clone(), Value::String(value.clone())))
        .collect();
    serde_json::json!({
        "transport": "stdio",
        "command": config.command,
        "args": config.args,
        "env": Value::Object(env),
    })
}

/// Slugifies a user-supplied MCP server name into a stable provider id segment:
/// lowercase, ASCII alphanumerics and dashes only, collapsed, never empty.
fn mcp_provider_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in name.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    let trimmed = slug.trim_end_matches('-');
    if trimmed.is_empty() {
        "server".to_string()
    } else {
        trimmed.to_string()
    }
}

#[derive(Debug, Deserialize)]
struct ConnectMcpRequest {
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: std::collections::HashMap<String, String>,
}

#[derive(Debug, Serialize)]
struct ConnectMcpResponse {
    provider_id: String,
    connection_id: String,
    tools_cached: usize,
    /// `Some` when the server was registered but tool discovery (spawn +
    /// initialize + tools/list) failed — surfaced, never swallowed, so the UI can
    /// say "registered, but couldn't reach the server" instead of faking success.
    discovery_error: Option<String>,
}

/// Registers a local stdio MCP server as a capability provider (per ADR 0009 it
/// is filesystem-confined to the workspace at execution time). The connection
/// metadata is written via [`mcp_stdio_config_to_metadata`] so the already-wired
/// executor (`execute_capability_generic`, MCP branch) reads back the identical
/// stdio config. Tool discovery is BEST-EFFORT: we try to spawn + initialize +
/// list so the Brain can plan with the server's tools, but a server that can't
/// start here still registers (with `discovery_error` set) rather than failing
/// the whole connect.
fn connect_mcp_blocking(
    state: &AppState,
    request: ConnectMcpRequest,
) -> Result<ConnectMcpResponse, GatewayError> {
    let name = request.name.trim().to_string();
    let command = request.command.trim().to_string();
    if name.is_empty() || command.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "mcp_connect_invalid",
            message: "MCP connect requires a non-empty name and command".to_string(),
        });
    }

    let slug = mcp_provider_slug(&name);
    let provider_id = CapabilityProviderId::new(format!("mcp:{slug}"));
    let connection_id = format!("mcp-{slug}");
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let config = McpStdioConfig {
        command,
        args: request.args,
        env: request.env.into_iter().collect(),
    };
    let metadata = mcp_stdio_config_to_metadata(&config);

    {
        let registry = lock_capability_registry(state)?;
        registry
            .upsert_provider_config(&CapabilityProviderConfig::new(
                provider_id.clone(),
                CapabilityProviderKind::Mcp,
                name.clone(),
                true,
            ))
            .map_err(GatewayError::capability)?;
        registry
            .upsert_provider_grant(
                &CapabilityProviderGrant::new(provider_id.clone(), user.clone(), workspace.clone())
                    .with_privacy_domains(vec!["local".to_string()])
                    .with_allowed_actions(vec![
                        ActionClass::Read,
                        ActionClass::WriteWithConfirmation,
                    ])
                    .with_max_autonomy_level(3),
            )
            .map_err(GatewayError::capability)?;
        registry
            .upsert_connection_config(
                &CapabilityConnectionConfig::new(
                    connection_id.as_str(),
                    provider_id.clone(),
                    user.clone(),
                    workspace.clone(),
                    name.clone(),
                    format!("stdio:{slug}"),
                )
                .with_privacy_domains(vec!["local".to_string()])
                .with_metadata(metadata),
            )
            .map_err(GatewayError::capability)?;
    }

    // Best-effort discovery: spawn the server, MCP-initialize, list tools, cache
    // them. Any failure is reported (not swallowed) and leaves the registration.
    let (tools_cached, discovery_error) =
        match mcp_discover_and_cache_tools(state, &provider_id, config) {
            Ok(count) => (count, None),
            Err(message) => (0, Some(message)),
        };

    Ok(ConnectMcpResponse {
        provider_id: provider_id.as_str().to_string(),
        connection_id,
        tools_cached,
        discovery_error,
    })
}

/// Spawns the MCP server, performs the `initialize` handshake (required by the
/// MCP protocol before `tools/list`), enumerates its tools, and caches them so
/// the Brain can plan with them. Returns the number cached, or an error string.
fn mcp_discover_and_cache_tools(
    state: &AppState,
    provider_id: &CapabilityProviderId,
    config: McpStdioConfig,
) -> Result<usize, String> {
    let transport = McpStdioTransport::spawn(config)
        .map_err(|error| format!("avvio MCP fallito: {error}"))?;
    let provider = McpCapabilityProvider::new(provider_id.clone(), true, transport, Vec::new());
    // Handshake first; some servers reject tools/list before initialize.
    provider
        .initialize("2024-11-05")
        .map_err(|error| format!("handshake MCP fallito: {error}"))?;
    let tools = provider
        .list_tools()
        .map_err(|error| format!("tools/list fallito: {error}"))?;
    let count = tools.len();
    let registry = lock_capability_registry(state).map_err(|error| error.message.to_string())?;
    for tool in tools {
        registry
            .upsert_cached_tool(&CachedCapabilityTool::new(
                provider_id.clone(),
                tool.name,
                CapabilityProviderKind::Mcp,
                tool.action,
                tool.description,
                tool.privacy_domains,
                tool.sensitivity,
                tool.input_schema,
            ))
            .map_err(|error| format!("cache tool fallita: {error}"))?;
    }
    Ok(count)
}

async fn connect_mcp(
    State(state): State<AppState>,
    Json(request): Json<ConnectMcpRequest>,
) -> Result<Json<ConnectMcpResponse>, GatewayError> {
    tokio::task::spawn_blocking(move || connect_mcp_blocking(&state, request))
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "mcp_connect_join",
            message: error.to_string(),
        })?
        .map(Json)
}

fn capability_call_completed_outcome(
    _task: &TaskRecord,
    result: &local_first_capabilities::CapabilityCallResult,
) -> TaskExecutionOutcome {
    let summary = format!("Tool `{}` eseguito.", result.tool_name);
    TaskExecutionOutcome {
        completed: true,
        blocked_reason: None,
        pending_approval: None,
        summary: summary.clone(),
        // Raw output stays in the (audited, non-UI) checkpoint; the redacted
        // checkpoint and chat message carry only provider/tool identifiers.
        checkpoint_payload: serde_json::json!({
            "kind": "capability_tool_completed",
            "provider": result.provider_id.as_str(),
            "tool": result.tool_name,
            "output": result.output,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "capability_tool_completed",
            "provider": result.provider_id.as_str(),
            "tool": result.tool_name,
        }),
        chat_message: format!(
            "Eseguito `{}` tramite `{}`.",
            result.tool_name,
            result.provider_id.as_str()
        ),
        surface: SurfaceKind::Logs,
        event_kind: "capability_tool_completed".to_string(),
        event_title: "Tool eseguito".to_string(),
        event_subtitle: summary,
        event_payload: serde_json::json!({
            "provider": result.provider_id.as_str(),
            "tool": result.tool_name,
        }),
        artifacts: vec![],
    }
}

fn capability_call_failed_outcome(task: &TaskRecord, reason: &str) -> TaskExecutionOutcome {
    TaskExecutionOutcome {
        completed: false,
        blocked_reason: Some(reason.to_string()),
        pending_approval: None,
        summary: reason.to_string(),
        checkpoint_payload: serde_json::json!({
            "kind": "capability_tool_failed",
            "task_kind": task.kind,
            "reason": reason,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "capability_tool_failed",
            "task_kind": task.kind,
            "reason": reason,
        }),
        chat_message: format!("Il tool capability non e' riuscito: {reason}"),
        surface: SurfaceKind::Logs,
        event_kind: "capability_tool_failed".to_string(),
        event_title: "Tool non riuscito".to_string(),
        event_subtitle: reason.to_string(),
        event_payload: serde_json::json!({ "task_kind": task.kind }),
        artifacts: vec![],
    }
}

fn capability_kind_not_wired_outcome(
    task: &TaskRecord,
    kind: CapabilityProviderKind,
) -> TaskExecutionOutcome {
    let reason = format!(
        "Esecuzione capability per provider kind {kind:?} non ancora collegata (MCP e Composio attivi)."
    );
    capability_call_failed_outcome(task, &reason)
}

// ---- P4.3 Composio connect -------------------------------------------------

#[derive(Debug, Deserialize)]
struct ConnectComposioRequest {
    api_key: String,
    base_url: Option<String>,
    display_name: Option<String>,
}

#[derive(Debug, Serialize)]
struct ConnectComposioResponse {
    provider_id: String,
    tools_cached: usize,
}

fn composio_base_url(explicit: Option<String>) -> String {
    explicit
        .filter(|url| !url.trim().is_empty())
        .or_else(|| env::var("LOCAL_FIRST_COMPOSIO_BASE_URL").ok().filter(|url| !url.is_empty()))
        .unwrap_or_else(|| "https://backend.composio.dev/api/v3".to_string())
}

/// Registers a Composio managed provider: stores the API key as an encrypted
/// secret (only the ref lands in the registry), records provider/grant/
/// connection config, then lists the available tools through the live HTTP
/// transport and caches them so the Brain can plan with them. Composio runs in
/// the cloud, so per ADR 0009 it needs no local sandbox — approval gates govern
/// its writes.
fn connect_composio_blocking(
    state: &AppState,
    request: ConnectComposioRequest,
) -> Result<ConnectComposioResponse, GatewayError> {
    let api_key = request.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "composio_api_key_required",
            message: "Composio API key must not be empty".to_string(),
        });
    }
    let base_url = composio_base_url(request.base_url);
    let display_name = request
        .display_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Composio".to_string());
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let provider_id = CapabilityProviderId::new("composio");

    // Verify the key against the v3 API FIRST and count available toolkits (apps),
    // before persisting anything. A bad key must not leave a phantom "active"
    // connection behind. We go transport-direct here: the crate's
    // ComposioCapabilityProvider targets a pre-v3 shape (expects `{tools}`), but
    // v3 returns `{items}`. We cache TOOLKITS (apps) for the connectors UI, not
    // the 1000s of individual tools — those are fetched per toolkit on demand.
    let transport = GatewayComposioTransport::new(base_url.clone(), api_key.clone());
    let toolkits = transport
        .request("GET", "/toolkits", None)
        .map_err(GatewayError::capability)?;
    let tools_cached = toolkits
        .get("items")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);

    // Key verified — now persist the secret (only the ref lands in the registry)
    // and the provider/grant/connection config.
    let secret_ref = SecretRef::new(user.as_str(), workspace.as_str(), "composio", "default")
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "secret_ref_invalid",
            message: error.to_string(),
        })?;
    state
        .secret_store
        .put(
            secret_ref.clone(),
            SecretMaterial::from_string(api_key),
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "secret_store_failed",
            message: error.to_string(),
        })?;

    {
        let registry = lock_capability_registry(state)?;
        registry
            .upsert_provider_config(&CapabilityProviderConfig::new(
                provider_id.clone(),
                CapabilityProviderKind::Managed,
                display_name.clone(),
                true,
            ))
            .map_err(GatewayError::capability)?;
        registry
            .upsert_provider_grant(
                &CapabilityProviderGrant::new(provider_id.clone(), user.clone(), workspace.clone())
                    .with_allow_managed_cloud(true)
                    .with_privacy_domains(vec!["managed-cloud".to_string()])
                    .with_allowed_actions(vec![
                        ActionClass::Read,
                        ActionClass::WriteWithConfirmation,
                    ])
                    .with_max_autonomy_level(3),
            )
            .map_err(GatewayError::capability)?;
        registry
            .upsert_connection_config(
                &CapabilityConnectionConfig::new(
                    "composio-default",
                    provider_id.clone(),
                    user.clone(),
                    workspace.clone(),
                    display_name.clone(),
                    secret_ref.as_str(),
                )
                .with_privacy_domains(vec!["managed-cloud".to_string()])
                .with_metadata(serde_json::json!({ "base_url": base_url })),
            )
            .map_err(GatewayError::capability)?;
    }

    Ok(ConnectComposioResponse {
        provider_id: provider_id.as_str().to_string(),
        tools_cached,
    })
}

#[derive(Debug, Serialize)]
struct ComposioToolkit {
    slug: String,
    name: String,
    managed_oauth: bool,
    no_auth: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    logo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    categories: Vec<String>,
}

#[derive(Debug, Serialize)]
struct ComposioToolkitsResponse {
    toolkits: Vec<ComposioToolkit>,
    total: u64,
}

/// Builds a live Composio v3 transport from the stored connection: base URL from
/// the connection metadata, API key from the encrypted secret store. Errors if
/// Composio is not connected for the active workspace.
fn composio_transport_for(state: &AppState) -> Result<GatewayComposioTransport, GatewayError> {
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let connection = {
        let registry = lock_capability_registry(state)?;
        registry
            .connection_configs(&user, &workspace)
            .map_err(GatewayError::capability)?
            .into_iter()
            .find(|config| config.provider_id.as_str() == "composio")
    }
    .ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "composio_not_connected",
        message: "Composio is not connected for this workspace".to_string(),
    })?;
    let base_url = connection
        .metadata
        .get("base_url")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| composio_base_url(None));
    let secret_ref = SecretRef::new(user.as_str(), workspace.as_str(), "composio", "default")
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "secret_ref_invalid",
            message: error.to_string(),
        })?;
    let api_key = state
        .secret_store
        .get(&secret_ref)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "secret_get_failed",
            message: error.to_string(),
        })?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "composio_secret_missing",
            message: "Composio API key not found".to_string(),
        })?
        .expose_utf8()
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "secret_decode_failed",
            message: error.to_string(),
        })?;
    Ok(GatewayComposioTransport::new(base_url, api_key))
}

fn composio_toolkits_blocking(state: &AppState) -> Result<ComposioToolkitsResponse, GatewayError> {
    let transport = composio_transport_for(state)?;
    let response = transport
        .request("GET", "/toolkits", None)
        .map_err(GatewayError::capability)?;
    let items = response
        .get("items")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = response
        .get("total_items")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(items.len() as u64);
    let toolkits = items
        .iter()
        .filter(|item| !item.get("deprecated").and_then(serde_json::Value::as_bool).unwrap_or(false))
        .filter_map(|item| {
            let slug = item.get("slug").and_then(serde_json::Value::as_str)?.to_string();
            let name = item
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&slug)
                .to_string();
            let managed_oauth = item
                .get("composio_managed_auth_schemes")
                .and_then(serde_json::Value::as_array)
                .map(|schemes| {
                    schemes
                        .iter()
                        .any(|s| s.as_str().is_some_and(|s| s.eq_ignore_ascii_case("OAUTH2")))
                })
                .unwrap_or(false);
            let no_auth = item.get("no_auth").and_then(serde_json::Value::as_bool).unwrap_or(false);
            // Composio v3 exposes display metadata under `meta`: logo URL, a short
            // description, and category tags (objects with a `name`, or bare strings).
            let meta = item.get("meta");
            let logo = meta
                .and_then(|m| m.get("logo"))
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let description = meta
                .and_then(|m| m.get("description"))
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let categories = meta
                .and_then(|m| m.get("categories"))
                .and_then(serde_json::Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| {
                            c.as_str()
                                .or_else(|| c.get("name").and_then(serde_json::Value::as_str))
                                .map(str::to_string)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(ComposioToolkit { slug, name, managed_oauth, no_auth, logo, description, categories })
        })
        .collect::<Vec<_>>();
    Ok(ComposioToolkitsResponse { toolkits, total })
}

#[derive(Debug, Deserialize)]
struct ComposioLinkRequest {
    toolkit_slug: String,
    /// When present, run the custom API-key flow instead of managed OAuth.
    #[serde(default)]
    api_key: Option<String>,
}

#[derive(Debug, Serialize)]
struct ComposioLinkResponse {
    redirect_url: String,
    connected_account_id: String,
}

#[derive(Debug, Serialize)]
struct ComposioConnection {
    id: String,
    toolkit_slug: String,
    status: String,
}

#[derive(Debug, Serialize)]
struct ComposioConnectionsResponse {
    connections: Vec<ComposioConnection>,
}

/// The Composio "user" (entity) for connected accounts. We scope it to the
/// active workspace so a project's connected accounts are isolated per project.
fn composio_entity_id() -> String {
    active_workspace_id()
}

/// Composio function tools to expose to the chat model, plus the subset that are
/// writes (need confirmation before running).
#[derive(Debug, Default)]
struct ComposioChatTools {
    /// OpenAI-style function tool schemas (name = tool slug).
    schemas: Vec<serde_json::Value>,
    /// Slugs classified as write/destructive actions.
    writes: std::collections::BTreeSet<String>,
}

/// Read-vs-write classification from the tool slug. Composio puts the verb
/// anywhere in the action (e.g. GMAIL_FETCH_EMAILS but also
/// GOOGLECALENDAR_EVENTS_LIST), so we tokenize and call it read only when a read
/// verb is present AND no write verb is — conservative: anything ambiguous is a
/// write that must be confirmed.
fn composio_tool_is_read(slug: &str) -> bool {
    const READ_VERBS: &[&str] = &[
        "FETCH", "GET", "LIST", "SEARCH", "READ", "FIND", "RETRIEVE", "VIEW", "DOWNLOAD",
        "CHECK", "COUNT", "QUERY", "LOOKUP", "DESCRIBE", "EXPORT",
    ];
    const WRITE_VERBS: &[&str] = &[
        "SEND", "CREATE", "DELETE", "UPDATE", "REMOVE", "ADD", "INSERT", "MODIFY", "EDIT",
        "ARCHIVE", "MOVE", "PATCH", "PUT", "POST", "REPLY", "FORWARD", "DRAFT", "TRASH",
        "MARK", "SET", "CLEAR", "WRITE", "UPLOAD", "IMPORT", "ENABLE", "DISABLE", "REVOKE",
        "GRANT", "CANCEL", "DUPLICATE", "RENAME", "PUBLISH",
    ];
    let upper = slug.to_ascii_uppercase();
    // Drop the toolkit prefix (first token), classify the action tokens.
    let action = upper.splitn(2, '_').nth(1).unwrap_or(&upper);
    let tokens: Vec<&str> = action.split('_').collect();
    let has_write = tokens.iter().any(|t| WRITE_VERBS.contains(t));
    let has_read = tokens.iter().any(|t| READ_VERBS.contains(t));
    has_read && !has_write
}

/// Human-readable tool name from a Composio slug, e.g. GMAIL_SEND_EMAIL →
/// "Send email · Gmail". Used wherever a tool is shown to the user.
fn humanize_composio_tool(slug: &str) -> String {
    let parts: Vec<&str> = slug.split('_').filter(|s| !s.is_empty()).collect();
    let Some((toolkit_raw, action_parts)) = parts.split_first() else {
        return slug.to_string();
    };
    let capitalize = |w: &str| {
        let mut chars = w.chars();
        match chars.next() {
            Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
            None => String::new(),
        }
    };
    let toolkit = capitalize(toolkit_raw);
    if action_parts.is_empty() {
        return toolkit;
    }
    let action = capitalize(&action_parts.iter().map(|w| w.to_lowercase()).collect::<Vec<_>>().join(" "));
    format!("{action} · {toolkit}")
}

/// ACTIVE connected toolkit slugs for the current entity.
fn composio_active_toolkit_slugs(transport: &GatewayComposioTransport) -> Vec<String> {
    let resp = transport
        .request(
            "GET",
            &format!("/connected_accounts?user_ids={}", composio_entity_id()),
            None,
        )
        .ok();
    let mut slugs = std::collections::BTreeSet::new();
    if let Some(items) = resp.as_ref().and_then(|r| r.get("items")).and_then(|v| v.as_array()) {
        for item in items {
            let active = item
                .get("status")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|s| s.eq_ignore_ascii_case("ACTIVE"));
            if !active {
                continue;
            }
            if let Some(slug) = item
                .get("toolkit")
                .and_then(|t| t.get("slug"))
                .or_else(|| item.get("toolkit_slug"))
                .and_then(serde_json::Value::as_str)
            {
                slugs.insert(slug.to_string());
            }
        }
    }
    slugs.into_iter().collect()
}

/// Fetches the executable tools (with input schemas) for the connected toolkits
/// and turns them into OpenAI function schemas, capped to avoid prompt bloat.
/// Best-effort: any failure yields an empty set so chat still works.
fn composio_chat_tools(state: &AppState, cap: usize) -> ComposioChatTools {
    let mut out = ComposioChatTools::default();
    let Ok(transport) = composio_transport_for(state) else {
        return out;
    };
    let slugs = composio_active_toolkit_slugs(&transport);
    if slugs.is_empty() {
        return out;
    }
    // Composio v3 /tools filters by the SINGULAR `toolkit_slug=` param, one
    // toolkit per request — verified empirically: `toolkits=`/`toolkit_slugs=`
    // are silently ignored (return the whole catalogue). So we query per
    // connected toolkit and merge, capping the total to avoid prompt bloat.
    let per_toolkit = cap.max(1);
    'outer: for slug in &slugs {
        let resp = match transport.request(
            "GET",
            &format!("/tools?toolkit_slug={slug}&limit={per_toolkit}"),
            None,
        ) {
            Ok(resp) => resp,
            Err(_) => continue,
        };
        let items = resp.get("items").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
        for item in items {
            if out.schemas.len() >= cap {
                break 'outer;
            }
            let Some(tool_slug) = item.get("slug").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if item.get("is_deprecated").and_then(serde_json::Value::as_bool).unwrap_or(false) {
                continue;
            }
            let description = item
                .get("description")
                .or_else(|| item.get("human_description"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .chars()
                .take(300)
                .collect::<String>();
            let parameters = item
                .get("input_parameters")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} }));
            if !composio_tool_is_read(tool_slug) {
                out.writes.insert(tool_slug.to_string());
            }
            out.schemas.push(serde_json::json!({
                "type": "function",
                "function": { "name": tool_slug, "description": description, "parameters": parameters },
            }));
        }
    }
    out
}

/// Executes a Composio tool for the current entity and returns its raw output.
fn composio_execute_tool(
    state: &AppState,
    tool: &str,
    arguments: &serde_json::Value,
) -> Result<serde_json::Value, GatewayError> {
    let transport = composio_transport_for(state)?;
    transport
        .request(
            "POST",
            &format!("/tools/execute/{tool}"),
            Some(serde_json::json!({
                "user_id": composio_entity_id(),
                "arguments": arguments,
            })),
        )
        .map_err(GatewayError::capability)
}

// ---- write-tool approval allow-list ("conferma sempre per questo tool") -------

fn composio_tool_allow_path() -> Option<PathBuf> {
    gateway_data_dir().ok().map(|dir| dir.join("composio-tool-allow.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ComposioToolAllow {
    /// Tool slugs the user approved to run WITHOUT per-call confirmation.
    #[serde(default)]
    always: Vec<String>,
}

/// Tool slugs the user has chosen to always allow (skip the confirmation card).
fn load_composio_tool_allow() -> std::collections::BTreeSet<String> {
    let Some(path) = composio_tool_allow_path() else {
        return std::collections::BTreeSet::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return std::collections::BTreeSet::new();
    };
    serde_json::from_str::<ComposioToolAllow>(&raw)
        .map(|a| a.always.into_iter().collect())
        .unwrap_or_default()
}

fn composio_tool_allowed(slug: &str) -> bool {
    load_composio_tool_allow().contains(slug)
}

fn write_composio_tool_allow(set: std::collections::BTreeSet<String>) -> Result<(), String> {
    let path = composio_tool_allow_path().ok_or_else(|| "data dir non disponibile".to_string())?;
    let value = ComposioToolAllow { always: set.into_iter().collect() };
    let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn add_composio_tool_allow(slug: &str) -> Result<(), String> {
    let mut set = load_composio_tool_allow();
    set.insert(slug.to_string());
    write_composio_tool_allow(set)
}

fn remove_composio_tool_allow(slug: &str) -> Result<(), String> {
    let mut set = load_composio_tool_allow();
    set.remove(slug);
    write_composio_tool_allow(set)
}

// ---- per-conversation linked folder ("@ file" context) -----------------------

fn thread_folders_path() -> Option<PathBuf> {
    gateway_data_dir().ok().map(|dir| dir.join("thread-folders.json"))
}

fn load_thread_folders() -> std::collections::BTreeMap<String, String> {
    thread_folders_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_thread_folders(map: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
    let path = thread_folders_path().ok_or_else(|| "data dir non disponibile".to_string())?;
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn thread_folder(thread_id: &str) -> Option<String> {
    load_thread_folders().get(thread_id).cloned()
}

/// The folder @ should search for a thread: the active PROJECT folder takes
/// precedence (a conversation in a project searches that project), falling back
/// to a per-conversation linked folder for projectless chats.
fn effective_thread_folder(thread_id: &str) -> Option<String> {
    active_workspace_folder().or_else(|| thread_folder(thread_id))
}

/// True if a candidate path stays inside `root` after canonicalization (anti
/// path-traversal): the user-linked folder is the only readable scope.
fn path_within(root: &std::path::Path, candidate: &std::path::Path) -> bool {
    match (root.canonicalize(), candidate.canonicalize()) {
        (Ok(r), Ok(c)) => c.starts_with(&r),
        _ => false,
    }
}

/// Skips noise/heavy dirs and obviously-binary files when walking a linked folder.
fn is_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | ".venv" | "venv" | "__pycache__" | ".next" | "dist" | "build"
            | "target" | ".cache" | ".idea" | ".DS_Store"
    )
}

fn looks_texty(name: &str) -> bool {
    let binary = [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".mp4",
        ".mov", ".mp3", ".wav", ".woff", ".woff2", ".ttf", ".otf", ".so", ".dylib", ".dll",
        ".exe", ".bin", ".class", ".o", ".a", ".lock",
    ];
    let lower = name.to_lowercase();
    !binary.iter().any(|ext| lower.ends_with(ext))
}

/// Walks `root` (bounded) and returns up to `limit` relative file paths whose name
/// matches `query` (case-insensitive substring; empty query = first files found).
fn search_folder_files(root: &std::path::Path, query: &str, limit: usize) -> Vec<String> {
    let q = query.trim().to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut walked = 0usize;
    while let Some(dir) = stack.pop() {
        if out.len() >= limit || walked > 20_000 {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            walked += 1;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != "." {
                continue;
            }
            if path.is_dir() {
                if !is_ignored_dir(&name) {
                    stack.push(path);
                }
                continue;
            }
            if !looks_texty(&name) {
                continue;
            }
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().to_string();
            if q.is_empty() || rel.to_lowercase().contains(&q) {
                out.push(rel);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    out.sort();
    out
}

#[derive(Debug, Serialize)]
struct ThreadFolderResponse {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SetThreadFolderRequest {
    /// Absolute folder path to link; null/empty unlinks.
    path: Option<String>,
}

async fn get_thread_folder(Path(thread_id): Path<String>) -> Json<ThreadFolderResponse> {
    Json(ThreadFolderResponse { path: effective_thread_folder(&thread_id) })
}

async fn set_thread_folder(
    Path(thread_id): Path<String>,
    Json(request): Json<SetThreadFolderRequest>,
) -> Result<Json<ThreadFolderResponse>, GatewayError> {
    let mut map = load_thread_folders();
    let cleaned = request.path.as_ref().map(|p| p.trim()).filter(|p| !p.is_empty());
    match cleaned {
        Some(path) => {
            let dir = PathBuf::from(path);
            if !dir.is_dir() {
                return Err(GatewayError {
                    status: StatusCode::BAD_REQUEST,
                    code: "folder_not_found",
                    message: "La cartella indicata non esiste.".to_string(),
                });
            }
            map.insert(thread_id.clone(), path.to_string());
        }
        None => {
            map.remove(&thread_id);
        }
    }
    write_thread_folders(&map).map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "folder_store",
        message: e,
    })?;
    Ok(Json(ThreadFolderResponse { path: thread_folder(&thread_id) }))
}

#[derive(Debug, Deserialize)]
struct ThreadFilesQuery {
    #[serde(default)]
    q: String,
}

#[derive(Debug, Serialize)]
struct ThreadFilesResponse {
    files: Vec<String>,
}

async fn search_thread_files(
    Path(thread_id): Path<String>,
    Query(query): Query<ThreadFilesQuery>,
) -> Result<Json<ThreadFilesResponse>, GatewayError> {
    let Some(folder) = effective_thread_folder(&thread_id) else {
        return Ok(Json(ThreadFilesResponse { files: Vec::new() }));
    };
    let root = PathBuf::from(folder);
    let files = tokio::task::spawn_blocking(move || search_folder_files(&root, &query.q, 40))
        .await
        .unwrap_or_default();
    Ok(Json(ThreadFilesResponse { files }))
}

#[derive(Debug, Deserialize)]
struct ThreadFileQuery {
    path: String,
}

#[derive(Debug, Serialize)]
struct ThreadFileResponse {
    path: String,
    content: String,
    truncated: bool,
}

const MAX_CONTEXT_FILE_BYTES: usize = 80_000;

async fn read_thread_file(
    Path(thread_id): Path<String>,
    Query(query): Query<ThreadFileQuery>,
) -> Result<Json<ThreadFileResponse>, GatewayError> {
    let folder = effective_thread_folder(&thread_id).ok_or_else(|| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "no_folder",
        message: "Nessuna cartella collegata.".to_string(),
    })?;
    let root = PathBuf::from(folder);
    let candidate = root.join(&query.path);
    if !path_within(&root, &candidate) {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "path_outside_folder",
            message: "Percorso fuori dalla cartella collegata.".to_string(),
        });
    }
    let rel = query.path.clone();
    let result = tokio::task::spawn_blocking(move || fs::read(&candidate))
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "file_read",
            message: e.to_string(),
        })?;
    let bytes = result.map_err(|e| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "file_read",
        message: e.to_string(),
    })?;
    let truncated = bytes.len() > MAX_CONTEXT_FILE_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_CONTEXT_FILE_BYTES)];
    let content = String::from_utf8_lossy(slice).to_string();
    Ok(Json(ThreadFileResponse { path: rel, content, truncated }))
}

#[derive(Debug, Serialize)]
struct AllowedToolView {
    slug: String,
    /// Human-readable name (GMAIL_SEND_EMAIL → "Send email · Gmail").
    name: String,
}

#[derive(Debug, Serialize)]
struct AllowedToolsResponse {
    tools: Vec<AllowedToolView>,
}

fn current_allowed_tools() -> AllowedToolsResponse {
    let tools = load_composio_tool_allow()
        .into_iter()
        .map(|slug| AllowedToolView { name: humanize_composio_tool(&slug), slug })
        .collect();
    AllowedToolsResponse { tools }
}

/// Lists the write tools the user marked "always allow" (skip confirmation).
async fn composio_allowed_tools() -> Json<AllowedToolsResponse> {
    Json(current_allowed_tools())
}

/// Revokes a tool's always-allow rule → it will ask for confirmation again.
async fn composio_revoke_allowed_tool(
    Path(slug): Path<String>,
) -> Result<Json<AllowedToolsResponse>, GatewayError> {
    remove_composio_tool_allow(&slug).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "composio_allow_write_failed",
        message,
    })?;
    Ok(Json(current_allowed_tools()))
}

#[derive(Debug, Deserialize)]
struct ComposioExecuteRequest {
    tool: String,
    #[serde(default)]
    arguments: serde_json::Value,
    /// "always" persists an allow-rule for this tool before executing.
    #[serde(default)]
    scope: Option<String>,
    /// When present, the originating chat message is rewritten on success so the
    /// confirmation card never reopens on reload (no risk of double-execution).
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
}

const COMPOSIO_CONFIRM_OPEN: &str = "‹‹COMPOSIO_CONFIRM››";
const COMPOSIO_CONFIRM_CLOSE: &str = "‹‹/COMPOSIO_CONFIRM››";

/// Rewrites a message that carries a pending-confirmation marker into a
/// "done" marker, dropping the "Serve la tua conferma…" prompt line. Idempotent
/// if no confirm marker is present.
fn rewrite_confirm_to_done(text: &str, tool: &str) -> String {
    let Some(open) = text.find(COMPOSIO_CONFIRM_OPEN) else {
        return text.to_string();
    };
    let Some(close_rel) = text[open..].find(COMPOSIO_CONFIRM_CLOSE) else {
        return text.to_string();
    };
    let close = open + close_rel + COMPOSIO_CONFIRM_CLOSE.len();
    let head_end = text[..open].rfind("Serve la tua conferma").unwrap_or(open);
    let mut out = text[..head_end].trim_end().to_string();
    let tail = text[close..].trim();
    if !tail.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(tail);
    }
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!("‹‹COMPOSIO_DONE››{tool}‹‹/COMPOSIO_DONE››"));
    out
}

#[derive(Debug, Serialize)]
struct ComposioExecuteResponse {
    ok: bool,
    /// Compact, human-readable outcome (the source of truth — not the model's word).
    summary: String,
}

/// Executes a Composio tool on explicit user confirmation (the chat
/// confirmation card calls this). `scope: "always"` also records an allow-rule
/// so future calls to this tool skip confirmation.
async fn composio_execute(
    State(state): State<AppState>,
    Json(request): Json<ComposioExecuteRequest>,
) -> Result<Json<ComposioExecuteResponse>, GatewayError> {
    if request.scope.as_deref() == Some("always") {
        let _ = add_composio_tool_allow(&request.tool);
    }
    let tool = request.tool.clone();
    let args = if request.arguments.is_null() {
        serde_json::json!({})
    } else {
        request.arguments.clone()
    };
    let output = tokio::task::spawn_blocking({
        let state = state.clone();
        move || composio_execute_tool(&state, &tool, &args)
    })
    .await
    .map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "composio_execute_join",
        message: e.to_string(),
    })??;

    // Persist the executed state into the transcript so reopening the chat shows
    // a "done" note, not the editable card (prevents accidental re-execution).
    if let (Some(thread_id), Some(message_id)) = (&request.thread_id, &request.message_id) {
        if let Ok(store) = lock_store(&state) {
            if let Ok(Some(message)) = store.message(thread_id, message_id) {
                let rewritten = rewrite_confirm_to_done(&message.text, &request.tool);
                let _ = store.set_message_text(thread_id, message_id, &rewritten);
            }
        }
    }

    let summary = output.to_string().chars().take(2000).collect::<String>();
    Ok(Json(ComposioExecuteResponse { ok: true, summary }))
}

/// Resolves a Composio-managed auth_config id for a toolkit, reusing an existing
/// one or creating a managed OAuth2 config. (Grounded on the real v3 shapes.)
/// Resolves (reusing, else creating) an auth config for `toolkit_slug`. With
/// `api_key=true` we want a CUSTOM API-key config (the user brings their own
/// credentials); otherwise a Composio-managed OAuth config. We never reuse a
/// config of the wrong kind — that's exactly what produced the
/// "Default auth config not found / no managed credentials" 400 for API-key-only
/// toolkits like openweather.
fn composio_auth_config_id(
    transport: &GatewayComposioTransport,
    toolkit_slug: &str,
    api_key: bool,
) -> Result<String, GatewayError> {
    let extract_id = |item: &serde_json::Value| {
        item.get("id")
            .or_else(|| item.get("auth_config").and_then(|ac| ac.get("id")))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let is_api_key_scheme = |item: &serde_json::Value| {
        let scheme = item
            .get("auth_scheme")
            .or_else(|| item.get("authScheme"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase();
        scheme == "API_KEY" || scheme == "BEARER_TOKEN"
    };

    let existing = transport
        .request("GET", &format!("/auth_configs?toolkit_slug={toolkit_slug}"), None)
        .map_err(GatewayError::capability)?;
    let reusable = existing
        .get("items")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| items.iter().find(|item| is_api_key_scheme(item) == api_key))
        .and_then(extract_id);
    if let Some(id) = reusable {
        return Ok(id);
    }

    let body = if api_key {
        serde_json::json!({
            "toolkit": { "slug": toolkit_slug },
            "auth_config": { "type": "use_custom_auth", "auth_scheme": "API_KEY", "credentials": {} }
        })
    } else {
        serde_json::json!({
            "toolkit": { "slug": toolkit_slug },
            "auth_config": { "type": "use_composio_managed_auth" }
        })
    };
    let created = transport
        .request("POST", "/auth_configs", Some(body))
        .map_err(GatewayError::capability)?;
    created
        .get("auth_config")
        .and_then(|ac| ac.get("id"))
        .or_else(|| created.get("id"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "composio_auth_config_failed",
            message: "Composio auth_config response missing id".to_string(),
        })
}

/// Links a toolkit. With an `api_key` we run Composio's custom API-key flow
/// (create a `use_custom_auth` config, then initiate with the key in
/// `config.val`) — the connection is active immediately, no redirect. Without a
/// key we run the managed-OAuth flow, which returns a `redirect_url` to open.
fn composio_link_blocking(
    state: &AppState,
    toolkit_slug: &str,
    api_key: Option<String>,
) -> Result<ComposioLinkResponse, GatewayError> {
    let transport = composio_transport_for(state)?;
    let use_api_key = api_key.as_ref().is_some_and(|k| !k.trim().is_empty());
    let auth_config_id = composio_auth_config_id(&transport, toolkit_slug, use_api_key)?;

    let mut body = serde_json::json!({
        "auth_config_id": auth_config_id,
        "user_id": composio_entity_id(),
    });
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        body["config"] = serde_json::json!({
            "auth_scheme": "API_KEY",
            "val": { "api_key": key.trim() },
        });
    }

    let link = transport
        .request("POST", "/connected_accounts/link", Some(body))
        .map_err(GatewayError::capability)?;
    // Managed OAuth returns a redirect_url; API-key connections do not.
    let redirect_url = link
        .get("redirect_url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let connected_account_id = link
        .get("connected_account_id")
        .or_else(|| link.get("id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(ComposioLinkResponse {
        redirect_url,
        connected_account_id,
    })
}

async fn composio_link(
    State(state): State<AppState>,
    Json(request): Json<ComposioLinkRequest>,
) -> Result<Json<ComposioLinkResponse>, GatewayError> {
    tokio::task::spawn_blocking(move || {
        composio_link_blocking(&state, &request.toolkit_slug, request.api_key)
    })
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "composio_link_join",
            message: error.to_string(),
        })?
        .map(Json)
}

fn composio_connections_blocking(
    state: &AppState,
) -> Result<ComposioConnectionsResponse, GatewayError> {
    let transport = composio_transport_for(state)?;
    let response = transport
        .request(
            "GET",
            &format!("/connected_accounts?user_ids={}", composio_entity_id()),
            None,
        )
        .map_err(GatewayError::capability)?;
    let connections = response
        .get("items")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(serde_json::Value::as_str)?.to_string();
                    let status = item
                        .get("status")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("UNKNOWN")
                        .to_string();
                    let toolkit_slug = item
                        .get("toolkit")
                        .and_then(|t| t.get("slug"))
                        .or_else(|| item.get("toolkit_slug"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    Some(ComposioConnection { id, toolkit_slug, status })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(ComposioConnectionsResponse { connections })
}

async fn composio_connections(
    State(state): State<AppState>,
) -> Result<Json<ComposioConnectionsResponse>, GatewayError> {
    tokio::task::spawn_blocking(move || composio_connections_blocking(&state))
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "composio_connections_join",
            message: error.to_string(),
        })?
        .map(Json)
}

async fn composio_toolkits(
    State(state): State<AppState>,
) -> Result<Json<ComposioToolkitsResponse>, GatewayError> {
    tokio::task::spawn_blocking(move || composio_toolkits_blocking(&state))
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "composio_toolkits_join",
            message: error.to_string(),
        })?
        .map(Json)
}

async fn connect_composio(
    State(state): State<AppState>,
    Json(request): Json<ConnectComposioRequest>,
) -> Result<Json<ConnectComposioResponse>, GatewayError> {
    tokio::task::spawn_blocking(move || connect_composio_blocking(&state, request))
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "composio_connect_join",
            message: error.to_string(),
        })?
        .map(Json)
}


fn task_execution_outcome_from_executor_result(
    task: &TaskRecord,
    executor_id: &str,
    tool_name: &str,
    result: ExecutorResult,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    match result {
        ExecutorResult::Completed { output } => Ok(completed_executor_outcome(
            task,
            executor_id,
            tool_name,
            output,
        )),
        ExecutorResult::Checkpoint {
            payload,
            redacted_payload,
        } => {
            let output = payload.clone();
            let mut outcome = completed_executor_outcome(task, executor_id, tool_name, output);
            outcome.checkpoint_payload = serde_json::json!({
                "kind": "executor_completed",
                "executor_id": executor_id,
                "tool": tool_name,
                "output": payload,
            });
            outcome.checkpoint_redacted = serde_json::json!({
                "kind": "executor_completed",
                "executor_id": executor_id,
                "tool": tool_name,
                "output": redacted_payload,
            });
            Ok(outcome)
        }
        ExecutorResult::NeedsApproval {
            action,
            risk_level,
            data_boundary,
            explanation,
        } => Ok(TaskExecutionOutcome {
            completed: false,
            blocked_reason: Some(explanation.clone()),
            pending_approval: Some(PendingExecutorApproval {
                action: action.clone(),
                risk_level: risk_level.clone(),
                data_boundary: data_boundary.clone(),
                explanation: explanation.clone(),
            }),
            summary: "Task in attesa di approval.".to_string(),
            checkpoint_payload: serde_json::json!({
                "kind": "executor_needs_approval",
                "executor_id": executor_id,
                "tool": tool_name,
                "approval": {
                    "action": action,
                    "risk_level": risk_level,
                    "data_boundary": data_boundary,
                    "explanation": explanation,
                },
            }),
            checkpoint_redacted: serde_json::json!({
                "kind": "executor_needs_approval",
                "executor_id": executor_id,
                "tool": tool_name,
                "approval": {
                    "action": action,
                    "risk_level": risk_level,
                    "data_boundary": data_boundary,
                    "explanation": explanation,
                },
            }),
            chat_message: format!(
                "Il task `{}` richiede una nuova approval prima di continuare: {}",
                task.kind, explanation
            ),
            surface: SurfaceKind::Logs,
            event_kind: "computer_executor_waiting_approval".to_string(),
            event_title: "Approval richiesta".to_string(),
            event_subtitle: explanation,
            event_payload: serde_json::json!({
                "executor_id": executor_id,
                "tool": tool_name,
            }),
            artifacts: vec![],
        }),
        ExecutorResult::WaitUntil { reason, .. } | ExecutorResult::RetryableFailure { reason } => {
            Ok(TaskExecutionOutcome {
                completed: false,
                blocked_reason: Some(reason.clone()),
                pending_approval: None,
                summary: reason.clone(),
                checkpoint_payload: serde_json::json!({
                    "kind": "executor_blocked",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "output": {
                        "blocked_reason": reason,
                    },
                }),
                checkpoint_redacted: serde_json::json!({
                    "kind": "executor_blocked",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "output": {
                        "blocked_reason": reason,
                    },
                }),
                chat_message: format!("Il task `{}` e' bloccato: {}", task.kind, reason),
                surface: SurfaceKind::Logs,
                event_kind: "computer_executor_blocked".to_string(),
                event_title: "Task bloccato".to_string(),
                event_subtitle: reason,
                event_payload: serde_json::json!({
                    "executor_id": executor_id,
                    "tool": tool_name,
                }),
                artifacts: vec![],
            })
        }
    }
}

fn completed_executor_outcome(
    task: &TaskRecord,
    executor_id: &str,
    tool_name: &str,
    output: Value,
) -> TaskExecutionOutcome {
    TaskExecutionOutcome {
        completed: true,
        blocked_reason: None,
        pending_approval: None,
        summary: format!("Executor `{executor_id}` completato."),
        checkpoint_payload: serde_json::json!({
            "kind": "executor_completed",
            "executor_id": executor_id,
            "tool": tool_name,
            "output": output,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "executor_completed",
            "executor_id": executor_id,
            "tool": tool_name,
            "output": redact_json_for_task_output(&output),
        }),
        chat_message: format!("Task `{}` completato tramite `{tool_name}`.", task.kind),
        surface: SurfaceKind::Browser,
        event_kind: "computer_executor_completed".to_string(),
        event_title: "Executor completato".to_string(),
        event_subtitle: format!("{} ha prodotto output strutturato.", tool_name),
        event_payload: serde_json::json!({
            "executor_id": executor_id,
            "tool": tool_name,
        }),
        artifacts: vec![],
    }
}

fn spawn_browser_sidecar_for_task(
    state: &AppState,
    task: &TaskRecord,
) -> Result<BrowserSidecarSession, LocalTaskExecutionError> {
    let browser_dir = browser_automation_dir();
    if !browser_dir.exists() {
        return Err(LocalTaskExecutionError {
            message: format!("Runtime browser non trovato: {}", browser_dir.display()),
        });
    }
    BrowserSidecarSession::spawn_with_options(
        "npm",
        &["run", "start", "--silent"],
        BrowserSidecarSpawnOptions {
            current_dir: Some(browser_dir),
            env: browser_sidecar_env(state, task),
        },
    )
    .map_err(|error| LocalTaskExecutionError {
        message: format!("Browser sidecar non avviato: {error}"),
    })
}

fn browser_method_for_capability_tool(tool_name: &str) -> Option<BrowserMethod> {
    match tool_name {
        "browser.health" => Some(BrowserMethod::Health),
        "browser.profiles" => Some(BrowserMethod::Profiles),
        "browser.tabs" => Some(BrowserMethod::Tabs),
        "browser.snapshot" => Some(BrowserMethod::Snapshot),
        "browser.console" => Some(BrowserMethod::Console),
        "browser.open" => Some(BrowserMethod::Open),
        "browser.focus" => Some(BrowserMethod::Focus),
        "browser.close_tab" => Some(BrowserMethod::CloseTab),
        "browser.navigate" => Some(BrowserMethod::Navigate),
        "browser.screenshot" => Some(BrowserMethod::Screenshot),
        "browser.pdf" => Some(BrowserMethod::Pdf),
        "browser.act" => Some(BrowserMethod::Act),
        "browser.arm_file_chooser" => Some(BrowserMethod::ArmFileChooser),
        "browser.respond_dialog" => Some(BrowserMethod::RespondDialog),
        "browser.wait_download" => Some(BrowserMethod::WaitDownload),
        _ => None,
    }
}

fn redact_json_for_task_output(output: &Value) -> Value {
    match output {
        Value::String(text) => Value::String(redact_sensitive_text(&truncate_chars(text, 2_000))),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(100)
                .map(redact_json_for_task_output)
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), redact_json_for_task_output(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn execute_local_read_only_task(
    task: &TaskRecord,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    if let Some(answer) = evaluate_simple_arithmetic(&task.goal) {
        return Ok(TaskExecutionOutcome {
            completed: true,
            blocked_reason: None,
            pending_approval: None,
            summary: format!("Calcolo completato: {answer}"),
            checkpoint_payload: serde_json::json!({ "kind": "calculation", "answer": answer }),
            checkpoint_redacted: serde_json::json!({ "kind": "calculation", "answer": answer }),
            chat_message: format!("Il risultato e' **{answer}**."),
            surface: SurfaceKind::Logs,
            event_kind: "computer_calculation_completed".to_string(),
            event_title: "Calcolo locale completato".to_string(),
            event_subtitle: "Risultato calcolato senza strumenti esterni.".to_string(),
            event_payload: serde_json::json!({ "answer": answer }),
            artifacts: vec![],
        });
    }
    Ok(TaskExecutionOutcome {
        completed: true,
        blocked_reason: None,
        pending_approval: None,
        summary: "Task locale letto e completato senza azioni esterne.".to_string(),
        checkpoint_payload: serde_json::json!({ "kind": "local_read_only", "goal": task.goal }),
        checkpoint_redacted: serde_json::json!({ "kind": "local_read_only", "goal": task.goal }),
        chat_message: "Ho registrato il task locale. Non servivano azioni esterne per questo primo passaggio read-only.".to_string(),
        surface: SurfaceKind::Logs,
        event_kind: "computer_local_task_completed".to_string(),
        event_title: "Task locale completato".to_string(),
        event_subtitle: "Nessuna azione esterna necessaria.".to_string(),
        event_payload: serde_json::json!({ "goal": task.goal }),
        artifacts: vec![],
    })
}

fn execute_shell_read_only_task(
    task: &TaskRecord,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    let normalized = task.goal.to_lowercase();
    let output = if normalized.contains("ora")
        || normalized.contains("orario")
        || normalized.contains("date")
        || normalized.contains("tempo")
    {
        run_read_only_command("date", &["+%Y-%m-%d %H:%M:%S %Z"])
    } else {
        Err(LocalTaskExecutionError {
            message: "Il task shell non contiene un comando read-only consentito.".to_string(),
        })
    }?;
    Ok(TaskExecutionOutcome {
        completed: true,
        blocked_reason: None,
        pending_approval: None,
        summary: "Comando shell read-only completato.".to_string(),
        checkpoint_payload: serde_json::json!({ "kind": "shell_read_only", "command": "date", "output": output }),
        checkpoint_redacted: serde_json::json!({ "kind": "shell_read_only", "command": "date", "output": output }),
        chat_message: format!(
            "Ho eseguito un controllo locale read-only:\n\n```text\n{}\n```",
            output.trim()
        ),
        surface: SurfaceKind::Shell,
        event_kind: "computer_terminal_output".to_string(),
        event_title: "Output terminale".to_string(),
        event_subtitle: "Comando read-only completato.".to_string(),
        event_payload: serde_json::json!({ "command": "date", "output": output }),
        artifacts: vec![],
    })
}

fn run_read_only_command(command: &str, args: &[&str]) -> Result<String, LocalTaskExecutionError> {
    let output =
        Command::new(command)
            .args(args)
            .output()
            .map_err(|error| LocalTaskExecutionError {
                message: format!("Comando read-only non avviato: {error}"),
            })?;
    if !output.status.success() {
        return Err(LocalTaskExecutionError {
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn execute_browser_read_only_task(
    state: &AppState,
    task: &TaskRecord,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    // The observe-act loop is the only browser execution path now. The legacy
    // keyword/train form-fill path was removed (de-gemma); this stays as a thin
    // alias because callers (chat tool, LegacyBrowser executor) use this name.
    execute_browser_loop_read_only_task(state, task)
}

fn execute_browser_loop_read_only_task(
    state: &AppState,
    task: &TaskRecord,
) -> Result<TaskExecutionOutcome, LocalTaskExecutionError> {
    let effective_goal = task_effective_goal(task);
    let mut operational_plan = task
        .input_json
        .get("operational_plan")
        .and_then(|value| serde_json::from_value::<OperationalPlan>(value.clone()).ok())
        .or_else(|| {
            // A1: prefer the OrchestratorBrain's plan when enabled; fall back to
            // the legacy keyword/train planner on any failure.
            brain_planner_enabled()
                .then(|| try_brain_operational_plan(state, &effective_goal))
                .flatten()
        })
        .unwrap_or_else(|| operational_plan_for_goal(&effective_goal, &task.kind));
    operational_plan.start_step("understand_request");
    operational_plan.complete_step("understand_request");
    append_operational_plan_progress(
        state,
        task,
        &operational_plan,
        "operational_plan_started",
        "Piano operativo",
        "Eseguo il task con loop browser osserva-agisci-verifica.",
    )
    .map_err(local_task_gateway_error)?;

    append_task_progress_checkpoint(
        state,
        task,
        "browser_runtime_starting",
        SurfaceKind::Browser,
        "Browser locale",
        "Avvio browser controllato locale.",
        serde_json::json!({ "kind": "browser_runtime_starting" }),
    )
    .map_err(local_task_gateway_error)?;

    // Per-thread reuse: if this chat thread already has a warm browser session,
    // attach to it (keeps cookies/login + the open tab) instead of spawning a
    // fresh sidecar. Otherwise spawn one and register it after the loop.
    let thread_id = task
        .input_json
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let reused_session = thread_id
        .as_deref()
        .and_then(|thread| take_thread_browser_session(state, thread));
    let session_reused = reused_session.is_some();
    let mut client = match reused_session {
        Some(existing) => existing,
        None => BrowserAutomationClient::new(spawn_browser_sidecar_for_task(state, task)?),
    };
    append_task_progress_checkpoint(
        state,
        task,
        "browser_runtime_ready",
        SurfaceKind::Browser,
        if session_reused {
            "Browser pronto (sessione del thread riusata)"
        } else {
            "Browser pronto"
        },
        if session_reused {
            "Riuso la sessione browser già aperta per questo thread."
        } else {
            "Runtime browser locale avviato."
        },
        serde_json::json!({ "kind": "browser_runtime_ready", "reused": session_reused }),
    )
    .map_err(local_task_gateway_error)?;
    let targets = browser_targets_for_goal(&effective_goal);
    let mut source_snapshots = Vec::new();
    let mut source_summaries = Vec::new();
    let mut form_drafts = Vec::new();
    let mut first_target_id: Option<String> = None;
    let mut completed_output: Option<Value> = None;

    // Load the local inference backend once per task and share it across every
    // source via Arc (a single mistral.rs model load, not one per target).
    let inference_router =
        std::sync::Arc::new(build_browser_inference_router());
    let context_profile = BrowserContextProfile::for_context_window(
        inference_router.active_context_window(&Requirements::default()),
    );

    operational_plan.start_step("open_sources");
    for (index, target) in targets.iter().enumerate() {
        let target_id = format!("loop_{index}");
        first_target_id.get_or_insert_with(|| target_id.clone());
        append_task_progress_checkpoint(
            state,
            task,
            "browser_loop_source_started",
            SurfaceKind::Browser,
            &format!("Loop browser {}", target.label),
            "Apro la fonte e procedo una micro-azione alla volta usando snapshot freschi.",
            serde_json::json!({
                "kind": "browser_loop_source_started",
                "label": target.label,
                "target_id": target_id,
                "url": target.url,
            }),
        )
        .map_err(local_task_gateway_error)?;

        let planner = RuntimeBrowserLoopPlanner::with_context_profile(
            std::sync::Arc::clone(&inference_router),
            context_profile,
        );
        let mut runner = BrowserLoopRunner::from_client(client, planner);
        let mut request = BrowserLoopRequest::new(
            format!("{effective_goal}\nFonte: {}", target.label),
            &target_id,
        )
        .with_max_iterations(browser_loop_max_iterations());
        // Tab reuse: when continuing a thread's warm session on the first source,
        // start from the EXISTING tab (snapshot the current page) instead of
        // navigating fresh — so a follow-up continues on the prior results/page
        // rather than redoing the search. The model still navigates if it needs
        // a different page. For a fresh session (or later sources) open the URL.
        if !(session_reused && index == 0) {
            request = request.with_initial_url(target.url.clone());
        }
        let loop_result = runner.run_with_iteration_observer(&request, |iteration| {
            // Live checklist for the Computer panel ("Avanzamento attività").
            push_browser_step(
                browser_step_label(iteration),
                if iteration.status == "no_progress" || iteration.status == "stale_ref_rejected" {
                    "retry"
                } else {
                    "done"
                },
            );
            append_task_progress_checkpoint(
                state,
                task,
                "browser_loop_iteration",
                SurfaceKind::Browser,
                &format!("{} azione {}", target.label, iteration.iteration),
                if iteration.status == "no_progress" {
                    "Azione eseguita, ma lo snapshot non e' cambiato: il controller dovra' cambiare strategia."
                } else {
                    "Azione eseguita e nuovo snapshot acquisito."
                },
                serde_json::json!({
                    "kind": "browser_loop_iteration",
                    "label": target.label,
                    "target_id": target_id,
                    "iteration": browser_loop_event_payload(iteration),
                }),
            )
            .map_err(|error| {
                BrowserAutomationError::InvalidResponse(format!(
                    "browser loop progress checkpoint failed: {}",
                    error.message
                ))
            })?;
            Ok(())
        });
        client = runner.into_client();

        match loop_result {
            Ok(output) => {
                let excerpt = truncate_chars(&output.final_observation.snapshot, 1_800);
                let verified_output = if output.completed {
                    Some(output.output.clone())
                } else {
                    None
                };
                let output_for_payload = verified_output.as_ref().unwrap_or(&output.output);
                let status = if let Some(verified_output) = verified_output.as_ref() {
                    completed_output.get_or_insert_with(|| verified_output.clone());
                    "completed"
                } else if output.completed {
                    "blocked"
                } else {
                    "blocked"
                };
                source_snapshots.push(serde_json::json!({
                    "label": target.label,
                    "url": output.final_observation.url,
                    "status": status,
                    "snapshot_excerpt": excerpt,
                    "loop_completed": output.completed,
                    "loop_output": redact_json_for_task_output(output_for_payload),
                    "iterations": output.iterations.len(),
                }));
                source_summaries.push(BrowserSourceSummary {
                    label: target.label.clone(),
                    url: output.final_observation.url.clone(),
                    status: status.to_string(),
                });
                form_drafts.push(BrowserFormDraftSummary {
                    label: target.label.clone(),
                    url: output.final_observation.url,
                    status: if verified_output.is_some() {
                        "completed".to_string()
                    } else {
                        "blocked".to_string()
                    },
                    filled_fields: Vec::new(),
                    reason: if output.completed {
                        None
                    } else {
                        output
                            .output
                            .get("blocked_reason")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    },
                    search_status: Some(status.to_string()),
                    search_excerpt: Some(loop_output_excerpt(output_for_payload, &excerpt)),
                });
                append_task_progress_checkpoint(
                    state,
                    task,
                    "browser_loop_source_completed",
                    SurfaceKind::Browser,
                    &format!("{} loop valutato", target.label),
                    if verified_output.is_some() {
                        "Il controller ha dichiarato completati i criteri sullo snapshot corrente."
                    } else if output.completed {
                        "Il controller ha terminato senza opzioni verificate; continuo con le altre fonti."
                    } else {
                        "Il controller ha bloccato questa fonte senza inventare risultati."
                    },
                    serde_json::json!({
                        "kind": "browser_loop_source_completed",
                        "label": target.label,
                        "target_id": target_id,
                        "completed": output.completed,
                        "output": redact_json_for_task_output(output_for_payload),
                    }),
                )
                .map_err(local_task_gateway_error)?;
                if verified_output.is_some() {
                    break;
                }
            }
            Err(error) => {
                let redacted_error =
                    redact_sensitive_text(&truncate_chars(&error.to_string(), 500));
                source_snapshots.push(serde_json::json!({
                    "label": target.label,
                    "url": target.url,
                    "status": "failed",
                    "error": redacted_error,
                }));
                source_summaries.push(BrowserSourceSummary {
                    label: target.label.clone(),
                    url: target.url.clone(),
                    status: "failed".to_string(),
                });
                append_task_progress_checkpoint(
                    state,
                    task,
                    "browser_loop_source_failed",
                    SurfaceKind::Browser,
                    &format!("{} loop fallito", target.label),
                    "La fonte e' stata saltata; continuo con le altre fonti disponibili.",
                    serde_json::json!({
                        "kind": "browser_loop_source_failed",
                        "label": target.label,
                        "target_id": target_id,
                        "error": redacted_error,
                    }),
                )
                .map_err(local_task_gateway_error)?;
            }
        }
    }
    operational_plan.complete_step("open_sources");

    if source_summaries.is_empty() {
        return Err(LocalTaskExecutionError {
            message: "Nessuna fonte browser raggiungibile dal loop.".to_string(),
        });
    }

    let final_url = source_summaries
        .iter()
        .find(|source| source.status == "completed")
        .or_else(|| source_summaries.first())
        .map(|source| source.url.clone())
        .unwrap_or_else(|| "about:blank".to_string());
    let artifact_id = format!("artifact_{}_browser_snapshot", task.task_id.as_str());
    let file_name = format!("{artifact_id}.png");
    let screenshot = client
        .call(
            BrowserMethod::Screenshot,
            serde_json::json!({
                "target_id": first_target_id.as_deref().unwrap_or("loop_0"),
                "file_name": file_name,
                "full_page": false
            }),
        )
        .map_err(|error| LocalTaskExecutionError {
            message: format!("Browser screenshot fallito: {error}"),
        })?;
    let screenshot_path = screenshot
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| LocalTaskExecutionError {
            message: "Browser screenshot senza path artifact.".to_string(),
        })?
        .to_string();
    let screenshot_bytes = screenshot
        .get("bytes")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| fs::metadata(&screenshot_path).map(|m| m.len()).unwrap_or(0));

    // Lifecycle: a thread-scoped session is kept WARM for the next browse_web in
    // the same thread (reaped on idle/thread-close), so a follow-up continues on
    // the same tab. A one-off (no thread) session is closed now — the Drop impl
    // only kills the child, so without this stop the context leaks in the
    // contained Chromium and orphaned targets pile up (observed: 282 -> failures).
    match thread_id.as_deref() {
        Some(thread) => store_thread_browser_session(state, thread, client),
        None => {
            let _ = client.call(BrowserMethod::Stop, serde_json::json!({}));
        }
    }

    let browser_success = completed_output.is_some();
    operational_plan.start_step("consolidate_options");
    if browser_success {
        operational_plan.complete_step("consolidate_options");
        operational_plan.complete_step("extract_options");
        operational_plan.complete_step("answer_and_next_gate");
    } else {
        operational_plan.block_step("consolidate_options");
        operational_plan.block_step("extract_options");
        operational_plan.block_step("answer_and_next_gate");
    }
    append_operational_plan_progress(
        state,
        task,
        &operational_plan,
        "operational_plan_completed",
        "Piano operativo valutato",
        "La tasklist markdown contiene lo stato finale del loop browser.",
    )
    .map_err(local_task_gateway_error)?;

    let plan_artifact = write_operational_plan_artifact(task, &operational_plan)?;
    let final_answer = completed_output
        .as_ref()
        .map(browser_loop_final_answer_markdown)
        .unwrap_or_else(|| {
            browser_final_answer_for_task(task, &source_summaries, &form_drafts).to_markdown()
        });
    let blocked_reason = if browser_success {
        None
    } else {
        Some("Il loop browser non ha completato il goal con dati verificabili.".to_string())
    };

    Ok(TaskExecutionOutcome {
        completed: browser_success,
        blocked_reason: blocked_reason.clone(),
        pending_approval: None,
        summary: if browser_success {
            "Loop browser completato con output strutturato.".to_string()
        } else {
            "Loop browser bloccato: risultati non estratti.".to_string()
        },
        checkpoint_payload: serde_json::json!({
            "kind": "browser_loop_guided",
            "operational_plan": operational_plan_payload(&operational_plan),
            "operational_plan_markdown": operational_plan_markdown(&operational_plan),
            "operational_plan_artifact_id": plan_artifact.artifact_id.clone(),
            "success_criteria_met": browser_success,
            "blocked_reason": blocked_reason.clone(),
            "url": final_url,
            "sources": source_snapshots.clone(),
            "form_drafts": form_drafts.iter().map(browser_form_draft_payload).collect::<Vec<_>>(),
            "loop_output": completed_output.as_ref().map(redact_json_for_task_output),
            "screenshot_artifact_id": artifact_id.clone(),
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "browser_loop_guided",
            "operational_plan": operational_plan_payload(&operational_plan),
            "operational_plan_markdown": operational_plan_markdown(&operational_plan),
            "operational_plan_artifact_id": plan_artifact.artifact_id.clone(),
            "success_criteria_met": browser_success,
            "blocked_reason": blocked_reason.clone(),
            "url": final_url,
            "sources": source_snapshots,
            "form_drafts": form_drafts.iter().map(browser_form_draft_payload).collect::<Vec<_>>(),
            "loop_output": completed_output.as_ref().map(redact_json_for_task_output),
            "screenshot_artifact_id": artifact_id.clone(),
        }),
        chat_message: final_answer,
        surface: SurfaceKind::Browser,
        event_kind: "computer_browser_loop_completed".to_string(),
        event_title: "Loop browser".to_string(),
        event_subtitle: if browser_success {
            "Risultato browser consolidato.".to_string()
        } else {
            "Loop browser bloccato prima di inventare dati.".to_string()
        },
        event_payload: serde_json::json!({
            "url": final_url,
            "operational_plan": operational_plan_payload(&operational_plan),
            "operational_plan_markdown": operational_plan_markdown(&operational_plan),
        }),
        artifacts: vec![
            TaskArtifactOutput {
                artifact_id: artifact_id.clone(),
                title: "Browser snapshot redatto".to_string(),
                kind: "screenshot".to_string(),
                path_ref: screenshot_path,
                size_bytes: screenshot_bytes,
                preview_ref: Some(format!("preview:{artifact_id}")),
            },
            plan_artifact,
        ],
    })
}

fn browser_final_answer_for_task(
    task: &TaskRecord,
    sources: &[BrowserSourceSummary],
    _form_drafts: &[BrowserFormDraftSummary],
) -> TaskFinalAnswer {
    // Generic fallback, used ONLY when the observe-act loop did not return
    // structured options. No domain/keyword special-casing (de-gemma): just
    // report honestly which sources were read.
    let _ = task;
    let completed = sources
        .iter()
        .filter(|source| source.status == "completed")
        .collect::<Vec<_>>();
    let failed = sources
        .iter()
        .filter(|source| source.status != "completed")
        .collect::<Vec<_>>();
    let title = if completed.is_empty() {
        "Ricerca browser non conclusa".to_string()
    } else {
        "Ricerca browser completata".to_string()
    };
    let summary = if completed.is_empty() {
        "Non sono riuscito a leggere fonti browser utili in questa sessione (alcune potrebbero essere bloccate o non aver caricato i risultati).".to_string()
    } else {
        "Ho aperto le fonti disponibili ma non ho estratto un elenco strutturato di opzioni; qui sotto cosa ho raggiunto.".to_string()
    };
    let findings = vec![format!(
        "Fonti raggiunte: {} su {}.",
        completed.len(),
        sources.len()
    )];
    let sources_markdown = sources
        .iter()
        .map(|source| {
            if source.status == "completed" {
                format!("{}: {}", source.label, source.url)
            } else {
                format!("{}: non raggiungibile/bloccata in questa sessione", source.label)
            }
        })
        .collect::<Vec<_>>();
    let mut limitations = vec![
        "Non ho selezionato opzioni, fatto login, inserito dati o acquistato nulla.".to_string(),
    ];
    if !failed.is_empty() {
        limitations.push(format!(
            "{} fonte/i non erano leggibili o raggiungibili.",
            failed.len()
        ));
    }
    TaskFinalAnswer {
        title,
        summary,
        findings,
        sources: sources_markdown,
        limitations,
        next_steps: Vec::new(),
    }
}

fn browser_loop_max_iterations() -> u32 {
    // The loop ends when the goal is done/blocked; this bounds it so a slow,
    // wandering model still RETURNS in reasonable time (and the forced-answer
    // round can run) instead of timing out. Raise per install if needed.
    env::var("LOCAL_FIRST_BROWSER_LOOP_MAX_ITERATIONS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .map(|value| value.clamp(1, 200))
        // 28: form-filling sources (Google Flights: consent wall + origin +
        // dest + date + search) need ~8-12 steps just to reach results, so 16
        // ran out before extracting. Deep-link sources finish in 1-2; this
        // budget covers both while still bounding latency.
        .unwrap_or(28)
}

/// The inference router (see `build_browser_inference_router`) uses the
/// configured OpenAI-compatible endpoint by default (Ollama local/cloud, OpenAI,
/// OpenRouter, ...), or Anthropic when `LOCAL_FIRST_INFERENCE_BACKEND=anthropic`
/// with a key. Cloud delegation is opt-in via `LOCAL_FIRST_INFERENCE_CLOUD` and
/// gated by the router's privacy policy.
fn brain_planner_enabled() -> bool {
    env::var("LOCAL_FIRST_USE_BRAIN_PLANNER")
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "on"))
        .unwrap_or(false)
}

/// Produces an `OperationalPlan` via the OrchestratorBrain (plan-only, no side
/// effects), or `None` on any failure so the caller falls back to the legacy
/// planner. Transitional A1 wiring (ADR 0008 pillars #1/#2): the Brain becomes
/// the live planner, seeing the registry's cached tools for planning visibility
/// via `CachedToolProvider`. Gated by `LOCAL_FIRST_USE_BRAIN_PLANNER`.
fn try_brain_operational_plan(state: &AppState, goal: &str) -> Option<OperationalPlan> {
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();

    let (policy_context, provider_tools) = {
        let registry = state.capability_registry.lock().ok()?;
        let policy = registry.policy_context(&user, &workspace).ok()?;
        let mut provider_tools = Vec::new();
        for provider in &policy.enabled_providers {
            let tools = registry
                .cached_tools(provider)
                .ok()?
                .into_iter()
                .map(|cached| cached.tool)
                .collect::<Vec<_>>();
            provider_tools.push((provider.clone(), tools));
        }
        (policy, provider_tools)
    };

    let mut facade =
        CapabilityFacade::new(CapabilityPolicy::default(), InMemoryCapabilityAudit::default());
    for (provider_id, tools) in provider_tools {
        let kind = tools
            .first()
            .map(|tool| tool.provider_kind)
            .unwrap_or(CapabilityProviderKind::Native);
        facade.register_provider(CachedToolProvider::new(provider_id, kind, tools));
    }

    let router = build_browser_inference_router();
    let budgets = brain_budgets_for_context_window(
        router.active_context_window(&Requirements::default()),
    );
    let mut brain = OrchestratorBrain::new(
        router,
        open_brain_memory(),
        facade,
        ToolSearchIndexStore::open_in_memory().ok()?,
        TaskStore::open_in_memory().ok()?,
    );
    let request = OrchestratorRequest {
        request_id: format!("brain_{}", uuid::Uuid::new_v4().simple()),
        policy_context,
        user_message: goal.to_string(),
        conversation_summary: None,
        attachments: Vec::new(),
        budgets,
    };
    let plan = brain.plan_only(&request).ok()?;
    Some(brain_adapter::execution_plan_to_operational_plan(&plan, goal))
}

fn brain_materialize_enabled() -> bool {
    match env::var("LOCAL_FIRST_BRAIN_MATERIALIZE") {
        // Explicit override always wins.
        Ok(value) => matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "on"),
        // A1.6: default ON. The only backends are capable cloud/router providers
        // (the weak local MLX/gemma path that this used to disable is gone), so
        // every configured setup plans through the Brain without a flag.
        Err(_) => true,
    }
}

/// A1.1: runs the OrchestratorBrain so it MATERIALIZES durable tasks into the
/// shared TaskStore (the same DB the background worker polls). Durable-only:
/// the request policy has empty `allowed_actions`, so every tool is
/// visible-but-not-executable -> the Brain never calls `call_tool` (so the
/// planning-only CachedToolProvider is safe) and enqueues every step as a
/// durable task, executed by the worker's real executors (browser/subagent).
/// Returns the materialized task ids, or an error so the caller can fall back.
/// P3 (read): the Brain's memory context provider, backed by a second handle on
/// the gateway's memory SQLite DB (same pattern as the shared task store). Holds
/// an `Option` so a memory-DB hiccup degrades to "no memory context" rather than
/// failing planning. `MemoryFacade` already implements the orchestrator's
/// `MemoryContextProvider` (policy-filtered `context_pack` → snippets), so this
/// just delegates.
struct GatewayBrainMemory(Option<MemoryFacade>);

impl MemoryContextProvider for GatewayBrainMemory {
    fn load_context(
        &self,
        request: &OrchestratorRequest,
    ) -> OrchestratorResult<Vec<MemoryContextSnippet>> {
        match &self.0 {
            Some(facade) => facade.load_context(request),
            None => Ok(Vec::new()),
        }
    }
}

fn open_brain_memory() -> GatewayBrainMemory {
    GatewayBrainMemory(
        gateway_memory_database_path()
            .ok()
            .and_then(|path| SQLiteMemoryStore::open(path).ok())
            .map(MemoryFacade::new),
    )
}

/// Context window (tokens) at/above which we treat the model as "capable" and
/// stop clamping its context — promptjuice becomes a no-op rather than a gate.
const CAPABLE_MODEL_CONTEXT_WINDOW: u32 = 32_000;

/// Budgets scaled to the active model's context window.
///
/// promptjuice (context compression) was built to optimize tokens for cost/time,
/// not to block: under budget it passes content through untouched, and a
/// `max_chars` of 0 means "unlimited". The earlier small-model hard-coded defaults are
/// tiny (1.2–3.2K chars, 768 planner tokens), which makes the compressor clamp
/// essential context away even when a capable model has room to spare. So scale
/// by the window: a big-context model gets generous/unlimited budgets
/// (passthrough); a small or unknown model keeps the cheap defaults.
fn brain_budgets_for_context_window(context_window: Option<u32>) -> OrchestratorBudgets {
    let mut budgets = OrchestratorBudgets::default();
    if context_window.is_some_and(|window| window >= CAPABLE_MODEL_CONTEXT_WINDOW) {
        budgets.max_planner_tokens = 8_000;
        budgets.max_loaded_tools = 16;
        budgets.max_tool_search_rounds = 2;
        // 0 = unlimited: let the compressor pass context through instead of
        // clamping the middle out from under a model that can read it all.
        budgets.max_conversation_summary_chars = 0;
        budgets.max_memory_context_chars = 0;
        budgets.max_tool_cards_context_chars = 0;
        budgets.max_loaded_tool_context_chars = 0;
    }
    budgets
}

/// Real HTTP transport for Composio (the crate ships only an in-memory double).
/// It is deliberately API-agnostic: it passes the method/path/body the
/// `ComposioCapabilityProvider` chooses, with `x-api-key` auth, so the protocol
/// shape stays owned by the crate and the base URL is configurable.
struct GatewayComposioTransport {
    base_url: String,
    api_key: String,
    http: reqwest::blocking::Client,
}

impl GatewayComposioTransport {
    fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            http: reqwest::blocking::Client::new(),
        }
    }
}

impl ComposioTransport for GatewayComposioTransport {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> CapabilityResult<serde_json::Value> {
        let url = format!("{}{}", self.base_url, path);
        let mut builder = match method.to_ascii_uppercase().as_str() {
            "GET" => self.http.get(&url),
            "POST" => self.http.post(&url),
            "DELETE" => self.http.delete(&url),
            other => {
                return Err(CapabilityError::ProviderUnavailable(format!(
                    "composio_unsupported_method:{other}"
                )));
            }
        };
        builder = builder.header("x-api-key", &self.api_key);
        if let Some(body) = body {
            builder = builder.json(&body);
        }
        let response = builder.send().map_err(|error| {
            CapabilityError::ProviderUnavailable(format!("composio_http:{error}"))
        })?;
        let status = response.status();
        if !status.is_success() {
            // Composio v3 errors carry a helpful envelope:
            // {"error":{"message":"…","code":2401,"slug":"…"}}. Surface the
            // message (not just the status code) so tool/auth failures are
            // actionable instead of an opaque "composio_status:400".
            let code = status.as_u16();
            let detail = response
                .text()
                .ok()
                .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(|err| err.get("message"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                });
            return Err(CapabilityError::ProviderUnavailable(match detail {
                Some(message) => format!("composio_status:{code}:{message}"),
                None => format!("composio_status:{code}"),
            }));
        }
        response
            .json::<serde_json::Value>()
            .map_err(|error| CapabilityError::ProviderUnavailable(format!("composio_json:{error}")))
    }
}

/// True when the Brain's plan acts on the browser provider — i.e. it needs live
/// web INTERACTION, which belongs to the observe-act loop rather than static
/// per-call capability steps.
fn plan_targets_browser(plan: &ExecutionPlan) -> bool {
    plan.steps
        .iter()
        .any(|step| step.provider_id.as_deref() == Some("browser"))
}

/// Materializes ONE durable `browser_task` carrying the user goal. The task
/// runtime worker dispatches `browser_task` to `execute_browser_loop_read_only_task`
/// (GatewayTaskExecutorKind::LegacyBrowser), which plans each step with the Brain
/// and drives the observe→act→verify loop — the validated end-to-end browser
/// path. The loop self-gates risky in-page actions (login/purchase/payment), so
/// this task does not require up-front approval.
fn materialize_browser_loop_task(
    store: &TaskStore,
    goal: &str,
) -> Result<String, LocalTaskExecutionError> {
    let task_id = format!("orchestrator_browser_{}", uuid::Uuid::new_v4().simple());
    let mut task = TaskRecord::new(
        task_id.clone(),
        gateway_user_id(),
        gateway_workspace_id(),
        "browser_task",
        task_goal_summary(goal),
        serde_json::json!({
            "source": "brain_browser_loop",
            "prompt_redacted": redact_sensitive_text(goal),
            "raw_prompt_stored": false,
        }),
    )
    .with_resource(ResourceRequirement::new(ResourceClass::ComputerSession, 1));
    task.risk_level = "low".to_string();
    task.permission_context = serde_json::json!({
        "privacy_domains": ["local", "browser"],
        "requires_user_approval": false,
        "cloud_allowed": false
    });
    store
        .insert_task(&task)
        .map_err(GatewayError::task)
        .map_err(local_task_gateway_error)?;
    Ok(task_id)
}

fn brain_materialize_tasks(
    state: &AppState,
    thread_id: &str,
    goal: &str,
) -> Result<Vec<String>, LocalTaskExecutionError> {
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();

    let (mut policy_context, provider_tools) = {
        let registry = lock_capability_registry(state).map_err(local_task_gateway_error)?;
        let policy = registry
            .policy_context(&user, &workspace)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("policy context: {error}"),
            })?;
        let mut provider_tools = Vec::new();
        for provider in &policy.enabled_providers {
            let tools = registry
                .cached_tools(provider)
                .map_err(|error| LocalTaskExecutionError {
                    message: format!("cached tools: {error}"),
                })?
                .into_iter()
                .map(|cached| cached.tool)
                .collect::<Vec<_>>();
            provider_tools.push((provider.clone(), tools));
        }
        (policy, provider_tools)
    };
    // Durable-first, but allow the NON-destructive action classes (Read/Draft)
    // so the planner can delegate sub-tasks to subagents (whose envelope must be
    // non-empty). Destructive classes (WriteWithConfirmation/ApprovedAutomation)
    // stay out, so no send/pay/write executes without an explicit user gate.
    policy_context.allowed_actions = vec![ActionClass::Read, ActionClass::Draft];

    let mut facade =
        CapabilityFacade::new(CapabilityPolicy::default(), InMemoryCapabilityAudit::default());
    for (provider_id, tools) in provider_tools {
        let kind = tools
            .first()
            .map(|tool| tool.provider_kind)
            .unwrap_or(CapabilityProviderKind::Native);
        facade.register_provider(CachedToolProvider::new(provider_id, kind, tools));
    }

    let task_store = TaskStore::open(gateway_task_database_path().map_err(|error| {
        LocalTaskExecutionError {
            message: error.to_string(),
        }
    })?)
    .map_err(|error| LocalTaskExecutionError {
        message: format!("shared task store: {error}"),
    })?;

    let router = build_browser_inference_router();
    let budgets = brain_budgets_for_context_window(
        router.active_context_window(&Requirements::default()),
    );
    let mut brain = OrchestratorBrain::new(
        router,
        open_brain_memory(),
        facade,
        ToolSearchIndexStore::open_in_memory().map_err(|error| LocalTaskExecutionError {
            message: format!("tool index: {error}"),
        })?,
        task_store,
    );
    let request = OrchestratorRequest {
        request_id: format!("brain_{}", uuid::Uuid::new_v4().simple()),
        policy_context,
        user_message: goal.to_string(),
        conversation_summary: None,
        attachments: Vec::new(),
        budgets,
    };
    let plan = brain.plan_only(&request).map_err(|error| LocalTaskExecutionError {
        message: format!("brain plan: {error}"),
    })?;

    // P1: browser INTERACTION is driven by the observe-act loop, not by static
    // `capability.browser.*` steps (which can navigate but cannot fill a
    // multi-field form — proven in live tests). When the Brain's plan targets
    // the browser provider, materialize ONE durable `browser_task`: the worker
    // runs it via execute_browser_loop_read_only_task, which itself plans each
    // step with the Brain and drives observe→act→verify. Non-browser plans
    // materialize their capability/subagent tasks as before.
    let task_ids = if plan_targets_browser(&plan) {
        vec![materialize_browser_loop_task(brain.task_store(), goal)?]
    } else {
        let outcome = brain.run(request).map_err(|error| LocalTaskExecutionError {
            message: format!("brain run: {error}"),
        })?;
        let mut ids = Vec::new();
        for summary in &outcome.enqueued_tasks {
            ids.push(summary.task_id.as_str().to_string());
        }
        for summary in &outcome.enqueued_subagent_tasks {
            ids.push(summary.task_id.as_str().to_string());
        }
        ids
    };

    // A1.2: bind the materialized task(s) to the originating chat thread so the
    // worker's existing session/chat surfacing (sync_session_for_task_run,
    // append_task_result_to_chat — both keyed on thread_by_task_id) resolves
    // them into the thread's single Local Computer session. Best-effort: a
    // linkage hiccup must not lose the materialized tasks (they just run
    // "headless" as before), so failures are logged, not propagated.
    if !task_ids.is_empty() {
        if let Err(error) = link_brain_tasks_to_thread(state, thread_id, goal, &task_ids) {
            eprintln!(
                "brain_materialize_tasks: thread linkage failed for {thread_id}: {}",
                error.message
            );
        }
    }

    Ok(task_ids)
}

/// Links Brain-materialized tasks to their chat thread and seeds the thread's
/// aggregating Local Computer session (progress_total = number of tasks), so a
/// single prompt that fans out into N durable tasks surfaces as ONE session
/// with per-task progress and results in chat.
fn link_brain_tasks_to_thread(
    state: &AppState,
    thread_id: &str,
    goal: &str,
    task_ids: &[String],
) -> Result<(), LocalTaskExecutionError> {
    let thread = {
        let chat_store = lock_store(state).map_err(local_task_gateway_error)?;
        chat_store
            .thread(thread_id)
            .map_err(GatewayError::store)
            .map_err(local_task_gateway_error)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };

    // Seed (or reuse) the aggregating session, then size its progress bar to the
    // number of tasks the Brain planned.
    let goal_redacted = task_goal_summary(goal);
    ensure_computer_session_for_task(
        state,
        &thread.computer_session_id,
        &thread.task_id,
        thread_id,
        &goal_redacted,
        false,
    )
    .map_err(local_task_gateway_error)?;
    set_session_progress_total(
        state,
        &thread.computer_session_id,
        task_ids.len() as u32,
    )
    .map_err(local_task_gateway_error)?;

    // Resolve every member task back to this thread.
    let chat_store = lock_store(state).map_err(local_task_gateway_error)?;
    for task_id in task_ids {
        chat_store
            .link_task_to_thread(task_id, thread_id)
            .map_err(GatewayError::store)
            .map_err(local_task_gateway_error)?;
    }
    Ok(())
}

/// Overrides the aggregating session's `progress_total` to the planned task
/// count (the seeding helper uses the legacy single-task default of 2/3).
fn set_session_progress_total(
    state: &AppState,
    session_id: &str,
    total: u32,
) -> Result<(), GatewayError> {
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let store = lock_computer_store(state)?;
    if let Some(mut session) = store
        .session(session_id, user.as_str(), workspace.as_str())
        .map_err(GatewayError::local_computer)?
    {
        session.progress_total = total.max(1);
        session.progress_current = session.progress_current.min(session.progress_total);
        session.updated_at = OffsetDateTime::now_utc();
        store
            .upsert_session(&session)
            .map_err(GatewayError::local_computer)?;
    }
    Ok(())
}

/// Resolves the cloud inference API key, preferring a 0600 key file over the
/// environment. A key file is not inherited by child processes (e.g. the browser
/// sidecar) and is not visible in `ps`/`/proc/<pid>/environ`, so it is the safer
/// source. Env remains supported for convenience but warns once.
///
/// TODO(security): migrate to `local-first-secrets` (`secret_ref`) per ADR 0007
/// for at-rest encryption / keychain — tracked as workstream S4-full in the
/// system elevation plan.
fn resolve_inference_api_key() -> Option<String> {
    // The active provider's own key wins (set via Settings → Modelli).
    if let Some(provider) = load_provider_registry().active()
        && let Some(key) = provider_api_key(&provider.id)
    {
        return Some(key);
    }
    // Legacy single-provider key in the encrypted secret store.
    if let Some(key) = persisted_inference_api_key() {
        return Some(key);
    }
    env_inference_api_key()
}

/// API key from the environment only (0600 key file preferred over the var).
/// Used as the per-provider fallback for role routing.
fn env_inference_api_key() -> Option<String> {
    if let Ok(path) = env::var("LOCAL_FIRST_INFERENCE_API_KEY_FILE")
        && !path.trim().is_empty()
    {
        match fs::read_to_string(path.trim()) {
            Ok(contents) => {
                let key = contents.trim().to_string();
                if !key.is_empty() {
                    return Some(key);
                }
            }
            Err(error) => {
                eprintln!("[inference] could not read LOCAL_FIRST_INFERENCE_API_KEY_FILE: {error}");
            }
        }
    }
    let from_env = env::var("LOCAL_FIRST_INFERENCE_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())?;
    eprintln!(
        "[inference] using API key from LOCAL_FIRST_INFERENCE_API_KEY (env); prefer \
         LOCAL_FIRST_INFERENCE_API_KEY_FILE (0600) — env is inherited by child processes"
    );
    Some(from_env)
}

/// Builds a single-provider `ModelRouter` for an explicit (kind, base_url, model).
/// Locality is inferred from the endpoint (loopback → local) and kind (Anthropic
/// is always cloud), which also picks the privacy policy.
fn build_router_from(
    kind: ProviderKind,
    base_url: &str,
    model: &str,
    api_key: Option<String>,
    context_window: u32,
) -> ModelRouter {
    let is_local = base_url.contains("127.0.0.1") || base_url.contains("localhost");
    if matches!(kind, ProviderKind::Anthropic)
        && let Some(api_key) = api_key.clone()
    {
        let descriptor = CapabilityDescriptor {
            id: format!("anthropic:{model}"),
            locality: Locality::Cloud,
            supports_vision: true,
            supports_tools: true,
            context_window,
            approx_tokens_per_second: None,
        };
        let provider = AnthropicProvider::new(descriptor, model.to_string(), api_key);
        return ModelRouter::new(PrivacyPolicy::allowing_cloud()).with_provider(Box::new(provider));
    }
    let locality = if is_local { Locality::Local } else { Locality::Cloud };
    let descriptor = CapabilityDescriptor {
        id: format!("openai-compat:{model}"),
        locality,
        supports_vision: true,
        supports_tools: true,
        context_window,
        approx_tokens_per_second: None,
    };
    let provider = OpenAiCompatProvider::new(descriptor, base_url.to_string(), model.to_string(), api_key);
    let policy = if is_local {
        PrivacyPolicy::local_only()
    } else {
        PrivacyPolicy::allowing_cloud()
    };
    ModelRouter::new(policy).with_provider(Box::new(provider))
}

/// Builds a `ModelRouter` from an already-resolved role/model (shared by role,
/// agent, and semantic-router paths). Resolves the provider's key + context.
fn build_router_for_resolved(resolved: &ResolvedRole) -> ModelRouter {
    let api_key = provider_api_key(&resolved.provider_id).or_else(env_inference_api_key);
    let context_window = env::var("LOCAL_FIRST_INFERENCE_CONTEXT_WINDOW")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(if matches!(resolved.kind, ProviderKind::Anthropic) {
            200_000
        } else {
            32_768
        });
    build_router_from(
        resolved.kind,
        &resolved.base_url,
        &resolved.model,
        api_key,
        context_window,
    )
}

/// Builds the inference router for a named role (Phase 2). Resolves the role
/// through the registry (manual binding or capability auto-match), falling back
/// to the legacy env/active-provider behavior when no provider is configured.
fn router_for_role(role: &str) -> ModelRouter {
    match load_provider_registry().resolve_role(role) {
        Some(resolved) => build_router_for_resolved(&resolved),
        None => build_inference_router_from_env(),
    }
}

/// Whether the semantic (LLM) model router is enabled. Default ON; set
/// `LOCAL_FIRST_SEMANTIC_ROUTER=0` to force the cheap heuristic.
fn semantic_router_enabled() -> bool {
    env::var("LOCAL_FIRST_SEMANTIC_ROUTER")
        .map(|value| value != "0" && !value.eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

/// One model-routing decision, logged for observability (why a model was picked).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RoutingDecision {
    ts: u64,
    role: String,
    /// Truncated + redacted task goal.
    goal: String,
    /// Eligible model ids (the stage-1 gate result).
    candidates: Vec<String>,
    chosen_provider: String,
    chosen_model: String,
    /// "semantic" | "heuristic_fallback" | "single_candidate" | "heuristic_disabled".
    stage: String,
}

const ROUTING_DECISIONS_CAP: usize = 50;

fn routing_decisions_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("routing-decisions.json"))
}

fn load_routing_decisions() -> Vec<RoutingDecision> {
    let Some(path) = routing_decisions_path() else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Appends a decision (capped ring of the most recent `ROUTING_DECISIONS_CAP`).
/// Best-effort: a logging hiccup must never break routing.
fn log_routing_decision(entry: RoutingDecision) {
    let Some(path) = routing_decisions_path() else {
        return;
    };
    let mut all = load_routing_decisions();
    all.push(entry);
    let len = all.len();
    if len > ROUTING_DECISIONS_CAP {
        all.drain(0..len - ROUTING_DECISIONS_CAP);
    }
    if let Ok(json) = serde_json::to_string_pretty(&all) {
        let _ = fs::write(path, json);
    }
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ----------------------------------------------------------------- skills API

/// Resolves the skills directory, creating it on demand so a fresh install has
/// a place for the user (or the future marketplace) to drop skill folders.
fn skills_dir() -> Result<PathBuf, std::io::Error> {
    let dir = skills::skills_root(&gateway_data_dir()?);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn skills_state_path() -> Option<PathBuf> {
    gateway_data_dir().ok().map(|dir| dir.join("skills-state.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SkillsState {
    #[serde(default)]
    disabled: Vec<String>,
}

/// Loads the set of disabled skill ids (default: empty → everything enabled).
fn load_skills_disabled() -> std::collections::BTreeSet<String> {
    let Some(path) = skills_state_path() else {
        return std::collections::BTreeSet::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return std::collections::BTreeSet::new();
    };
    serde_json::from_str::<SkillsState>(&raw)
        .map(|s| s.disabled.into_iter().collect())
        .unwrap_or_default()
}

fn save_skills_disabled(disabled: &std::collections::BTreeSet<String>) -> Result<(), String> {
    let path = skills_state_path().ok_or_else(|| "data dir non disponibile".to_string())?;
    let state = SkillsState { disabled: disabled.iter().cloned().collect() };
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
struct SkillsResponse {
    skills: Vec<skills::SkillSummary>,
    /// Absolute path of the skills directory (shown in the UI empty state).
    dir: String,
}

#[derive(Debug, Deserialize)]
struct SetSkillEnabledRequest {
    enabled: bool,
}

fn skills_origins_path() -> Option<PathBuf> {
    gateway_data_dir().ok().map(|dir| dir.join("skills-origins.json"))
}

/// Loads the id → source map (e.g. "github:anthropics/skills"). Skills not in
/// the map are treated as "local".
fn load_skills_origins() -> std::collections::BTreeMap<String, String> {
    let Some(path) = skills_origins_path() else {
        return std::collections::BTreeMap::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return std::collections::BTreeMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_skills_origins(
    origins: &std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    let path = skills_origins_path().ok_or_else(|| "data dir non disponibile".to_string())?;
    let json = serde_json::to_string_pretty(origins).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn current_skills_response() -> SkillsResponse {
    let dir = skills_dir().ok();
    let disabled = load_skills_disabled();
    let origins = load_skills_origins();
    let skills = dir
        .as_deref()
        .map(|d| skills::scan_skills(d, &disabled, &origins))
        .unwrap_or_default();
    SkillsResponse {
        skills,
        dir: dir.map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
    }
}

async fn list_skills() -> Json<SkillsResponse> {
    Json(current_skills_response())
}

/// Skill detail + a static security scan of its files.
#[derive(Debug, Serialize)]
struct SkillDetailResponse {
    #[serde(flatten)]
    detail: skills::SkillDetail,
    security: skill_security::SecurityReport,
}

async fn skill_detail(
    Path(id): Path<String>,
) -> Result<Json<SkillDetailResponse>, GatewayError> {
    let dir = skills_dir().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skills_dir_unavailable",
        message: e.to_string(),
    })?;
    let disabled = load_skills_disabled();
    let origins = load_skills_origins();
    match skills::load_detail(&dir, &id, &disabled, &origins).map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skill_read_failed",
        message: e.to_string(),
    })? {
        Some(detail) => {
            let security = skill_security::scan_dir(&dir.join(&id));
            Ok(Json(SkillDetailResponse { detail, security }))
        }
        None => Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "skill_not_found",
            message: format!("skill {id} non trovata"),
        }),
    }
}

async fn set_skill_enabled(
    Path(id): Path<String>,
    Json(request): Json<SetSkillEnabledRequest>,
) -> Result<Json<SkillsResponse>, GatewayError> {
    let mut disabled = load_skills_disabled();
    if request.enabled {
        disabled.remove(&id);
    } else {
        disabled.insert(id);
    }
    save_skills_disabled(&disabled).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skills_state_write_failed",
        message,
    })?;
    Ok(Json(current_skills_response()))
}

// ------------------------------------------------------------- skills catalog

fn skills_catalog_path() -> Option<PathBuf> {
    gateway_data_dir().ok().map(|dir| dir.join("clawhub-catalog.json"))
}

#[derive(Debug, Deserialize)]
struct CatalogQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct CategoryCount {
    name: String,
    count: usize,
}

#[derive(Debug, Serialize)]
struct CatalogResponse {
    skills: Vec<skills_catalog::CatalogEntry>,
    categories: Vec<CategoryCount>,
    /// Repo to install from (slug → `skills/<slug>` under this repo).
    repo: String,
    total: usize,
    fetched_at: u64,
}

fn catalog_response(cache: &skills_catalog::CatalogCache, query: &CatalogQuery) -> CatalogResponse {
    let limit = query.limit.unwrap_or(60).min(200);
    let skills = skills_catalog::search(
        cache,
        query.q.as_deref().unwrap_or(""),
        query.category.as_deref(),
        limit,
    );
    let mut categories: Vec<CategoryCount> = skills_catalog::category_counts(cache)
        .into_iter()
        .map(|(name, count)| CategoryCount { name, count })
        .collect();
    categories.sort_by(|a, b| b.count.cmp(&a.count));
    CatalogResponse {
        total: cache.entries.len(),
        skills,
        categories,
        repo: skills_catalog::CLAWHUB_REPO.to_string(),
        fetched_at: cache.fetched_at,
    }
}

/// Browse/search the skill catalog. On a cold or stale cache it refreshes from
/// ClawHub first (slow once, then cached ~6h).
async fn skill_catalog(
    State(state): State<AppState>,
    Query(query): Query<CatalogQuery>,
) -> Result<Json<CatalogResponse>, GatewayError> {
    let path = skills_catalog_path().ok_or_else(|| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "data_dir_unavailable",
        message: "data dir non disponibile".to_string(),
    })?;
    let fresh = skills_catalog::load_cache(&path).is_some_and(|c| skills_catalog::cache_is_fresh(&c));
    if !fresh {
        if let Err(error) = skills_catalog::refresh_cache(&state.http, &path).await {
            eprintln!("skill catalog refresh failed: {error}");
        }
    }
    let cache = skills_catalog::load_cache(&path).unwrap_or(skills_catalog::CatalogCache {
        fetched_at: 0,
        entries: Vec::new(),
    });
    Ok(Json(catalog_response(&cache, &query)))
}

/// Force a catalog refresh from ClawHub.
async fn skill_catalog_refresh(
    State(state): State<AppState>,
) -> Result<Json<CatalogResponse>, GatewayError> {
    let path = skills_catalog_path().ok_or_else(|| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "data_dir_unavailable",
        message: "data dir non disponibile".to_string(),
    })?;
    skills_catalog::refresh_cache(&state.http, &path)
        .await
        .map_err(|message| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "catalog_refresh_failed",
            message,
        })?;
    let cache = skills_catalog::load_cache(&path).unwrap_or(skills_catalog::CatalogCache {
        fetched_at: 0,
        entries: Vec::new(),
    });
    Ok(Json(catalog_response(&cache, &CatalogQuery { q: None, category: None, limit: None })))
}

#[derive(Debug, Deserialize)]
struct CatalogInstallRequest {
    slug: String,
}

/// Installs a catalog skill: download its ClawHub ZIP, extract into the skills
/// dir (the local scanner then picks it up), record origin. Returns the refreshed
/// local skill list.
async fn install_catalog_skill(
    State(state): State<AppState>,
    Json(request): Json<CatalogInstallRequest>,
) -> Result<Json<SkillsResponse>, GatewayError> {
    let slug = request.slug.trim().to_string();
    if !skills::is_safe_id(&slug) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_slug",
            message: format!("slug non valido: «{slug}»"),
        });
    }
    let root = skills_dir().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skills_dir_unavailable",
        message: e.to_string(),
    })?;
    let dest = root.join(&slug);
    if dest.exists() {
        return Err(GatewayError {
            status: StatusCode::CONFLICT,
            code: "skill_exists",
            message: format!("skill «{slug}» già installata"),
        });
    }
    let zip = skills_catalog::download_zip(&state.http, &slug)
        .await
        .map_err(|message| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "catalog_download_failed",
            message,
        })?;
    let dest_for_extract = dest.clone();
    tokio::task::spawn_blocking(move || skills_catalog::extract_zip(&zip, &dest_for_extract))
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "catalog_extract_join",
            message: e.to_string(),
        })?
        .map_err(|message| {
            let _ = std::fs::remove_dir_all(&dest);
            GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "catalog_extract_failed",
                message,
            }
        })?;
    let mut origins = load_skills_origins();
    origins.insert(slug.clone(), format!("clawhub:{slug}"));
    let _ = save_skills_origins(&origins);
    Ok(Json(current_skills_response()))
}

#[derive(Debug, Deserialize)]
struct CatalogPreviewQuery {
    slug: String,
}

#[derive(Debug, Serialize)]
struct CatalogPreview {
    slug: String,
    name: String,
    description: String,
    /// SKILL.md body (frontmatter stripped) for rendering.
    body: String,
    files: Vec<String>,
    security: skill_security::SecurityReport,
}

/// Previews a catalog skill WITHOUT installing: downloads the ZIP, extracts the
/// SKILL.md + file list in memory, and runs the security scan.
async fn preview_catalog_skill(
    State(state): State<AppState>,
    Query(query): Query<CatalogPreviewQuery>,
) -> Result<Json<CatalogPreview>, GatewayError> {
    let slug = query.slug.trim().to_string();
    let zip = skills_catalog::download_zip(&state.http, &slug)
        .await
        .map_err(|message| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "catalog_download_failed",
            message,
        })?;
    let files = skills_catalog::read_zip_text_files(&zip).map_err(|message| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "catalog_zip_invalid",
        message,
    })?;
    let manifest = files
        .iter()
        .find(|(p, _)| p == "SKILL.md" || p.ends_with("/SKILL.md"))
        .map(|(_, c)| c.clone())
        .unwrap_or_default();
    let (frontmatter, body) = skills::split_frontmatter(&manifest);
    let security = skill_security::scan_blobs(&files);
    Ok(Json(CatalogPreview {
        name: frontmatter.name.unwrap_or_else(|| slug.clone()),
        description: frontmatter.description.unwrap_or_default(),
        body,
        files: files.iter().map(|(p, _)| p.clone()).collect(),
        security,
        slug,
    }))
}

// ---------------------------------------------------------- skills marketplace

/// Curated, directly-installable skill collections (GitHub repos whose folders
/// each contain a `SKILL.md`). Shown as suggestions; the user can also enter any
/// `owner/repo`.
const CURATED_SKILL_REPOS: &[&str] = &["anthropics/skills"];

const SKILL_REGISTRY_MAX: usize = 80;
const SKILL_INSTALL_MAX_FILES: usize = 150;
const SKILL_INSTALL_MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
struct RegistrySkill {
    /// Folder leaf — the id it would get once installed.
    id: String,
    /// Folder path within the repo (e.g. "skills/pdf"), "" if at the root.
    path: String,
    name: String,
    description: String,
    /// True if a skill with this id already exists locally.
    installed: bool,
}

#[derive(Debug, Serialize)]
struct RegistryResponse {
    repo: String,
    skills: Vec<RegistrySkill>,
    suggested: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RegistryQuery {
    repo: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InstallSkillRequest {
    repo: String,
    path: String,
}

/// Validates an `owner/repo` slug. Strict on purpose: the value is interpolated
/// into api.github.com / raw.githubusercontent.com URLs, so rejecting anything
/// unusual prevents being redirected to another host.
fn valid_github_repo(repo: &str) -> bool {
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 {
        return false;
    }
    let ok = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s != "."
            && s != ".."
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    ok(parts[0]) && ok(parts[1])
}

/// Optional GitHub token, which raises the 60 req/hour anonymous limit. Read
/// from env first, then a 0600 file under the data dir. Never logged.
fn github_token() -> Option<String> {
    if let Ok(token) = env::var("LOCAL_FIRST_GITHUB_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return Some(token);
        }
    }
    let path = gateway_data_dir().ok()?.join("github-token");
    let token = fs::read_to_string(path).ok()?.trim().to_string();
    (!token.is_empty()).then_some(token)
}

fn github_get(http: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    let mut builder = http
        .get(url)
        .header(reqwest::header::USER_AGENT, "local-first-personal-assistant");
    if let Some(token) = github_token() {
        builder = builder.bearer_auth(token);
    }
    builder
}

fn github_err(code: &'static str, message: impl Into<String>) -> GatewayError {
    GatewayError { status: StatusCode::BAD_GATEWAY, code, message: message.into() }
}

async fn github_default_branch(http: &reqwest::Client, repo: &str) -> Result<String, GatewayError> {
    let url = format!("https://api.github.com/repos/{repo}");
    let resp = github_get(http, &url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| github_err("github_unreachable", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(github_err(
            "github_repo_error",
            format!("repo {repo}: HTTP {}", resp.status()),
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| github_err("github_bad_json", e.to_string()))?;
    Ok(body
        .get("default_branch")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("main")
        .to_string())
}

/// Recursive git tree as (path, is_blob) pairs.
async fn github_tree(
    http: &reqwest::Client,
    repo: &str,
    branch: &str,
) -> Result<Vec<(String, bool)>, GatewayError> {
    let url = format!("https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1");
    let resp = github_get(http, &url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| github_err("github_unreachable", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(github_err(
            "github_tree_error",
            format!("tree {repo}@{branch}: HTTP {}", resp.status()),
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| github_err("github_bad_json", e.to_string()))?;
    let tree = body
        .get("tree")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| github_err("github_no_tree", "albero del repo mancante"))?;
    Ok(tree
        .iter()
        .filter_map(|node| {
            let path = node.get("path").and_then(serde_json::Value::as_str)?.to_string();
            let is_blob = node.get("type").and_then(serde_json::Value::as_str) == Some("blob");
            Some((path, is_blob))
        })
        .collect())
}

async fn github_raw_bytes(
    http: &reqwest::Client,
    repo: &str,
    branch: &str,
    path: &str,
) -> Result<Vec<u8>, GatewayError> {
    let url = format!("https://raw.githubusercontent.com/{repo}/{branch}/{path}");
    let resp = github_get(http, &url)
        .send()
        .await
        .map_err(|e| github_err("github_unreachable", e.to_string()))?;
    if !resp.status().is_success() {
        return Err(github_err(
            "github_raw_error",
            format!("{path}: HTTP {}", resp.status()),
        ));
    }
    Ok(resp
        .bytes()
        .await
        .map_err(|e| github_err("github_read_error", e.to_string()))?
        .to_vec())
}

/// Derives the install id (folder leaf) from a skill folder path within a repo.
/// A root-level skill (empty folder) uses the repo name.
fn skill_id_for(repo: &str, folder: &str) -> String {
    if folder.is_empty() {
        repo.split('/').nth(1).unwrap_or("skill").to_string()
    } else {
        folder.rsplit('/').next().unwrap_or("skill").to_string()
    }
}

/// Lists installable skills (folders containing a `SKILL.md`) in a GitHub repo.
/// One GitHub API call for the branch + one for the tree; `SKILL.md` previews
/// are fetched from raw.githubusercontent.com, which is not API-rate-limited.
async fn registry_skills(
    State(state): State<AppState>,
    Query(query): Query<RegistryQuery>,
) -> Result<Json<RegistryResponse>, GatewayError> {
    let repo = query
        .repo
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| CURATED_SKILL_REPOS[0].to_string());
    if !valid_github_repo(&repo) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_repo",
            message: format!("repo non valido: «{repo}» (atteso owner/nome)"),
        });
    }
    let branch = github_default_branch(&state.http, &repo).await?;
    let tree = github_tree(&state.http, &repo, &branch).await?;
    let installed: std::collections::BTreeSet<String> =
        current_skills_response().skills.into_iter().map(|s| s.id).collect();

    let mut skills = Vec::new();
    for (path, is_blob) in &tree {
        if !is_blob {
            continue;
        }
        if path != "SKILL.md" && !path.ends_with("/SKILL.md") {
            continue;
        }
        if skills.len() >= SKILL_REGISTRY_MAX {
            break;
        }
        let folder = path.strip_suffix("SKILL.md").unwrap_or("").trim_end_matches('/').to_string();
        let id = skill_id_for(&repo, &folder);
        if !skills::is_safe_id(&id) {
            continue;
        }
        let (name, description) = match github_raw_bytes(&state.http, &repo, &branch, path).await {
            Ok(bytes) => {
                let (fm, _) = skills::split_frontmatter(&String::from_utf8_lossy(&bytes));
                (fm.name.unwrap_or_else(|| id.clone()), fm.description.unwrap_or_default())
            }
            Err(_) => (id.clone(), String::new()),
        };
        let installed = installed.contains(&id);
        skills.push(RegistrySkill { id, path: folder, name, description, installed });
    }

    Ok(Json(RegistryResponse {
        repo,
        skills,
        suggested: CURATED_SKILL_REPOS.iter().map(|s| s.to_string()).collect(),
    }))
}

/// Downloads one skill folder from a GitHub repo into the local skills dir.
/// Staged to a temp directory and atomically renamed so a failed download never
/// leaves a half-written skill. Refuses to overwrite an existing skill.
async fn install_registry_skill(
    State(state): State<AppState>,
    Json(request): Json<InstallSkillRequest>,
) -> Result<Json<SkillsResponse>, GatewayError> {
    if !valid_github_repo(&request.repo) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_repo",
            message: format!("repo non valido: «{}»", request.repo),
        });
    }
    if request.path.contains("..") {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_path",
            message: "path skill non valido".to_string(),
        });
    }
    let folder = request.path.trim_matches('/').to_string();
    let id = skill_id_for(&request.repo, &folder);
    if !skills::is_safe_id(&id) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_skill_id",
            message: format!("id skill non valido: «{id}»"),
        });
    }

    let root = skills_dir().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skills_dir_unavailable",
        message: e.to_string(),
    })?;
    let dest = root.join(&id);
    if dest.exists() {
        return Err(GatewayError {
            status: StatusCode::CONFLICT,
            code: "skill_exists",
            message: format!("skill «{id}» già presente — rimuovila prima di reinstallarla"),
        });
    }

    let branch = github_default_branch(&state.http, &request.repo).await?;
    let tree = github_tree(&state.http, &request.repo, &branch).await?;
    let prefix = if folder.is_empty() { String::new() } else { format!("{folder}/") };
    let blobs: Vec<String> = tree
        .iter()
        .filter(|(path, is_blob)| *is_blob && (prefix.is_empty() || path.starts_with(&prefix)))
        .map(|(path, _)| path.clone())
        .collect();

    let manifest = format!("{prefix}SKILL.md");
    if !blobs.iter().any(|p| *p == manifest) {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "skill_manifest_missing",
            message: "nessun SKILL.md nel path indicato".to_string(),
        });
    }
    if blobs.len() > SKILL_INSTALL_MAX_FILES {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "skill_too_many_files",
            message: format!("la skill ha {} file (max {SKILL_INSTALL_MAX_FILES})", blobs.len()),
        });
    }

    // Stage to a sibling temp dir, then atomically rename into place.
    let staging = root.join(format!(".staging-{id}"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "skill_stage_failed",
        message: e.to_string(),
    })?;

    let mut total = 0usize;
    for path in &blobs {
        let rel = path.strip_prefix(&prefix).unwrap_or(path);
        if rel.is_empty() || rel.split('/').any(|c| c == ".." || c.is_empty()) {
            continue;
        }
        let bytes = match github_raw_bytes(&state.http, &request.repo, &branch, path).await {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
        };
        total += bytes.len();
        if total > SKILL_INSTALL_MAX_BYTES {
            let _ = fs::remove_dir_all(&staging);
            return Err(GatewayError {
                status: StatusCode::BAD_REQUEST,
                code: "skill_too_large",
                message: "skill troppo grande".to_string(),
            });
        }
        let out = staging.join(rel);
        if let Some(parent) = out.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(error) = fs::write(&out, &bytes) {
            let _ = fs::remove_dir_all(&staging);
            return Err(GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "skill_write_failed",
                message: error.to_string(),
            });
        }
    }

    if let Err(error) = fs::rename(&staging, &dest) {
        let _ = fs::remove_dir_all(&staging);
        return Err(GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "skill_install_failed",
            message: error.to_string(),
        });
    }

    let mut origins = load_skills_origins();
    origins.insert(id, format!("github:{}", request.repo));
    let _ = save_skills_origins(&origins);

    Ok(Json(current_skills_response()))
}

/// STAGE 2 (semantic): among the models eligible for `role`, ask a fast model
/// which one best fits `goal`, reading each model's profile ("in cosa eccelle").
/// Falls back to the heuristic `resolve_role` on: disabled flag, <2 candidates,
/// LLM error, or an unrecognized pick. Async task path only (adds one LLM hop).
/// Every decision is logged for observability.
fn resolve_role_for_task(goal: &str, role: &str) -> Option<ResolvedRole> {
    let registry = load_provider_registry();
    let heuristic = registry.resolve_role(role);
    // Owned candidate tuples: (provider_id, model_id, tier, strengths, kind, base_url).
    let candidates: Vec<(String, String, String, String, ProviderKind, String)> = registry
        .eligible_models(role)
        .iter()
        .map(|(provider, model)| {
            let (tier, strengths) = model
                .profile
                .as_ref()
                .map(|p| (p.tier.as_str().to_string(), p.strengths.clone()))
                .unwrap_or_default();
            (
                provider.id.clone(),
                model.id.clone(),
                tier,
                strengths,
                provider.kind,
                provider.base_url.clone(),
            )
        })
        .collect();
    let candidate_ids: Vec<String> = candidates.iter().map(|c| c.1.clone()).collect();

    // Decide (and remember which stage produced the choice).
    let (resolved, stage): (Option<ResolvedRole>, &'static str) = if !semantic_router_enabled() {
        (heuristic.clone(), "heuristic_disabled")
    } else if candidates.len() < 2 {
        (heuristic.clone(), "single_candidate")
    } else {
        let list = candidates
            .iter()
            .enumerate()
            .map(|(i, (pid, mid, tier, strengths, _, _))| {
                let desc = if strengths.trim().is_empty() {
                    "(nessuna descrizione)"
                } else {
                    strengths.as_str()
                };
                format!("{}. id=\"{mid}\" provider={pid} tier={tier} — {desc}", i + 1)
            })
            .collect::<Vec<_>>()
            .join("\n");
        let prompt = format!(
            "Sei un router di modelli. Scegli il modello che esegue MEGLIO questo compito, \
             in base a in cosa ciascun modello eccelle.\n\nCompito:\n{goal}\n\nModelli candidati:\n{list}\n\n\
             Rispondi SOLO con JSON: {{\"model_id\": \"<uno degli id elencati esattamente>\"}}."
        );
        let request = GenerateJsonRequest {
            prompt,
            max_tokens: 200,
            temperature: 0.0,
            wait_if_busy: true,
            request_timeout_seconds: Some(30.0),
            json_schema: None,
            required_keys: vec!["model_id".to_string()],
            repair: true,
        };
        // The role's heuristic model runs the (cheap) selection call.
        let selector = router_for_role(role);
        match selector.generate_json_with(&Requirements::default(), &request) {
            Ok(response) if response.valid => {
                let chosen = response.json.get("model_id").and_then(Value::as_str);
                if let Some(chosen) = chosen
                    && let Some((pid, mid, _, _, kind, base_url)) =
                        candidates.iter().find(|c| c.1 == chosen)
                {
                    (
                        Some(ResolvedRole {
                            role: role.to_string(),
                            provider_id: pid.clone(),
                            model: mid.clone(),
                            kind: *kind,
                            base_url: base_url.clone(),
                            auto: true,
                        }),
                        "semantic",
                    )
                } else {
                    (heuristic.clone(), "heuristic_fallback")
                }
            }
            _ => (heuristic.clone(), "heuristic_fallback"),
        }
    };

    if let Some(chosen) = &resolved {
        log_routing_decision(RoutingDecision {
            ts: now_epoch_secs(),
            role: role.to_string(),
            goal: truncate_chars(&redact_sensitive_text(goal), 140),
            candidates: candidate_ids,
            chosen_provider: chosen.provider_id.clone(),
            chosen_model: chosen.model.clone(),
            stage: stage.to_string(),
        });
    }
    resolved
}

/// Browser-loop router (Phase 2): the "browser" role.
fn build_browser_inference_router() -> ModelRouter {
    router_for_role("browser")
}

/// Legacy env-only router, used when the registry has no providers yet.
fn build_inference_router_from_env() -> ModelRouter {
    let backend = env::var("LOCAL_FIRST_INFERENCE_BACKEND")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let context_window = env::var("LOCAL_FIRST_INFERENCE_CONTEXT_WINDOW")
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    if backend == "anthropic"
        && let Some(api_key) = resolve_inference_api_key()
    {
        let model = active_inference_model();
        return build_router_from(
            ProviderKind::Anthropic,
            "https://api.anthropic.com",
            &model,
            Some(api_key),
            context_window.unwrap_or(200_000),
        );
    }
    let base_url =
        effective_inference_base_url().unwrap_or_else(|| "http://127.0.0.1:11434/v1".to_string());
    let model = env::var("LOCAL_FIRST_BROWSER_PLANNER_MODEL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(active_inference_model);
    build_router_from(
        ProviderKind::OpenaiCompat,
        &base_url,
        &model,
        resolve_inference_api_key(),
        context_window.unwrap_or(32_768),
    )
}

#[derive(Debug, Serialize)]
struct ActiveModelResponse {
    /// "anthropic" | "openai-compat"
    backend: String,
    model: String,
    /// "cloud" | "local"
    locality: String,
    context_window: u32,
    /// Always true: the only backends are capable cloud/router providers (the
    /// small local MLX/Gemma fallback that this flag used to gate is gone).
    capable: bool,
    /// True when the selected backend needs a cloud API key but none is present
    /// — the UI can warn that chat will silently fall back to local.
    missing_api_key: bool,
}

/// Default cloud/compat model ids — the SINGLE source of truth shared by the
/// router builder ([`build_browser_inference_router`]) and the reporter
/// ([`active_inference_model_info`]) so the two can never drift (the bug class
/// behind both the de-gemma labels and the earlier mistralrs default mismatch).
const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-4-6";
const OPENAI_COMPAT_DEFAULT_MODEL: &str = "gpt-4o-mini";

/// Pure, env-free inputs for [`resolve_active_model`] — lets the selection
/// logic be unit-tested without mutating process env (which is parallel-unsafe).
struct ActiveModelInputs {
    backend: String,
    model: Option<String>,
    cloud_flag: bool,
    context_window: Option<u32>,
    has_api_key: bool,
}

/// Pure selection logic mirroring [`build_browser_inference_router`]: anthropic
/// only when explicitly selected AND a key is present; otherwise the configured
/// OpenAI-compatible provider (the local MLX/Gemma fallback is gone). Kept
/// separate from env reading so it is deterministically testable.
fn resolve_active_model(input: &ActiveModelInputs) -> ActiveModelResponse {
    if input.backend == "anthropic" && input.has_api_key {
        return ActiveModelResponse {
            backend: "anthropic".to_string(),
            model: input
                .model
                .clone()
                .unwrap_or_else(|| ANTHROPIC_DEFAULT_MODEL.to_string()),
            locality: "cloud".to_string(),
            context_window: input.context_window.unwrap_or(200_000),
            capable: true,
            missing_api_key: false,
        };
    }

    // Default for every other case (incl. anthropic-without-key, which the
    // router resolves to the OpenAI-compatible provider too).
    ActiveModelResponse {
        backend: "openai-compat".to_string(),
        model: input
            .model
            .clone()
            .unwrap_or_else(|| OPENAI_COMPAT_DEFAULT_MODEL.to_string()),
        locality: if input.cloud_flag { "cloud" } else { "local" }.to_string(),
        context_window: input.context_window.unwrap_or(32_768),
        capable: true,
        // An OpenAI-compatible endpoint may be keyless (local Ollama); only flag
        // a missing key when it is a cloud endpoint.
        missing_api_key: input.cloud_flag && !input.has_api_key,
    }
}

/// Reports which inference backend/model is actually active, mirroring the exact
/// selection logic in [`build_browser_inference_router`]. Read-only — the
/// recurring pain that started the de-gemma arc was "am I on cloud or gemma4?";
/// this makes the answer visible in the UI instead of buried in env vars.
fn active_inference_model_info() -> ActiveModelResponse {
    resolve_active_model(&ActiveModelInputs {
        backend: env::var("LOCAL_FIRST_INFERENCE_BACKEND")
            .unwrap_or_default()
            .to_ascii_lowercase(),
        model: persisted_inference_model()
            .or_else(|| env::var("LOCAL_FIRST_INFERENCE_MODEL").ok())
            .filter(|value| !value.is_empty()),
        cloud_flag: env::var("LOCAL_FIRST_INFERENCE_CLOUD")
            .map(|value| value == "1" || value.to_ascii_lowercase() == "true")
            .unwrap_or(false),
        context_window: env::var("LOCAL_FIRST_INFERENCE_CONTEXT_WINDOW")
            .ok()
            .and_then(|value| value.parse::<u32>().ok()),
        has_api_key: resolve_inference_api_key().is_some(),
    })
}

#[derive(Debug, Serialize)]
struct RuntimeModelsResponse {
    active: Option<String>,
    backend: String,
    available: Vec<String>,
}

/// Lists the models the configured backend exposes (OpenAI-compatible `/models`,
/// which Ollama also serves) so Settings can offer a real picker.
async fn runtime_models(State(state): State<AppState>) -> Json<RuntimeModelsResponse> {
    let backend = env::var("LOCAL_FIRST_INFERENCE_BACKEND")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let active = persisted_inference_model().or_else(|| env::var("LOCAL_FIRST_INFERENCE_MODEL").ok());
    let mut available = Vec::new();
    if let Ok(base) = env::var("LOCAL_FIRST_INFERENCE_BASE_URL") {
        if !base.is_empty() {
            let url = format!("{}/models", base.trim_end_matches('/'));
            let mut request = state.http.get(&url).timeout(std::time::Duration::from_secs(4));
            if let Some(key) = resolve_inference_api_key() {
                request = request.bearer_auth(key);
            }
            if let Ok(response) = request.send().await {
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    if let Some(data) = body.get("data").and_then(Value::as_array) {
                        for entry in data {
                            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                                available.push(id.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    available.sort();
    available.dedup();
    Json(RuntimeModelsResponse {
        active,
        backend,
        available,
    })
}

#[derive(Debug, Deserialize)]
struct SetRuntimeModelRequest {
    model: String,
}

/// Persists the user-selected active model. Applies to the next chat (no
/// restart): chat_openai_stream_config reads the override fresh each call.
async fn set_runtime_model(
    Json(request): Json<SetRuntimeModelRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let model = request.model.trim();
    if model.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "model_required",
            message: "model must not be empty".to_string(),
        });
    }
    // Set the active provider's model in the registry when one exists; always
    // keep the legacy file in sync so env-only setups still resolve.
    let mut registry = load_provider_registry();
    if let Some(active_id) = registry.active().map(|p| p.id.clone())
        && let Some(provider) = registry.get_mut(&active_id)
    {
        provider.active_model = Some(model.to_string());
        save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    }
    set_persisted_inference_model(model).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "model_persist_failed",
        message: error.to_string(),
    })?;
    Ok(Json(serde_json::json!({ "active": model })))
}

#[derive(Debug, Serialize)]
struct InferenceProviderResponse {
    base_url: Option<String>,
    model: Option<String>,
    has_key: bool,
}

/// The configured inference provider (base URL + model + whether a key is set).
/// Never returns the key itself.
async fn runtime_provider() -> Json<InferenceProviderResponse> {
    Json(InferenceProviderResponse {
        base_url: effective_inference_base_url(),
        model: persisted_inference_model().or_else(|| env::var("LOCAL_FIRST_INFERENCE_MODEL").ok()),
        has_key: resolve_inference_api_key().is_some(),
    })
}

#[derive(Debug, Deserialize)]
struct SetInferenceProviderRequest {
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
}

/// Configure an external OpenAI-compatible provider: base URL + model persisted
/// in the data dir, API key stored in the encrypted secret store (never echoed).
async fn set_runtime_provider(
    Json(request): Json<SetInferenceProviderRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let persist_err = |message: String| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "provider_persist_failed",
        message,
    };
    if let Some(base) = request
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_persisted_inference_base_url(base).map_err(|error| persist_err(error.to_string()))?;
    }
    if let Some(model) = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_persisted_inference_model(model).map_err(|error| persist_err(error.to_string()))?;
    }
    if let Some(key) = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_persisted_inference_api_key(key).map_err(persist_err)?;
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ── Provider registry endpoints (Phase 1) ─────────────────────────────────

#[derive(Debug, Serialize)]
struct ProviderModelView {
    id: String,
    vision: bool,
    tools: bool,
    reasoning: bool,
    modality: String,
    context_window: Option<u32>,
    /// Qualitative profile used for ranking ("in cosa eccelle").
    tier: Option<String>,
    strengths: Option<String>,
    profile_source: Option<String>,
    profile_confidence: Option<u8>,
}

#[derive(Debug, Serialize)]
struct ProviderView {
    id: String,
    label: String,
    kind: String,
    base_url: String,
    has_key: bool,
    active_model: Option<String>,
    models: Vec<ProviderModelView>,
    models_fetched_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct ProvidersResponse {
    active_provider_id: Option<String>,
    providers: Vec<ProviderView>,
}

fn provider_view(entry: &ProviderEntry) -> ProviderView {
    ProviderView {
        id: entry.id.clone(),
        label: entry.label.clone(),
        kind: entry.kind.as_str().to_string(),
        base_url: entry.base_url.clone(),
        has_key: provider_api_key(&entry.id).is_some(),
        active_model: entry.effective_model(),
        models: entry
            .models
            .iter()
            .map(|m| ProviderModelView {
                id: m.id.clone(),
                vision: m.vision,
                tools: m.tools,
                reasoning: m.reasoning,
                modality: m.modality.clone(),
                context_window: m.context_window,
                tier: m.profile.as_ref().map(|p| p.tier.as_str().to_string()),
                strengths: m.profile.as_ref().map(|p| p.strengths.clone()),
                profile_source: m.profile.as_ref().map(|p| p.source.clone()),
                profile_confidence: m.profile.as_ref().map(|p| p.confidence),
            })
            .collect(),
        models_fetched_at: entry.models_fetched_at.clone(),
    }
}

fn providers_response(registry: &ProviderRegistry) -> ProvidersResponse {
    ProvidersResponse {
        active_provider_id: registry.active().map(|p| p.id.clone()),
        providers: registry.providers.iter().map(provider_view).collect(),
    }
}

async fn list_providers() -> Json<ProvidersResponse> {
    Json(providers_response(&load_provider_registry()))
}

#[derive(Debug, Deserialize)]
struct UpsertProviderRequest {
    id: Option<String>,
    label: Option<String>,
    kind: Option<String>,
    base_url: String,
    api_key: Option<String>,
    active_model: Option<String>,
}

/// Adds or updates a provider. The API key (if supplied) goes to the encrypted
/// secret store under the provider id and is never echoed back.
async fn upsert_provider(
    Json(request): Json<UpsertProviderRequest>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let bad = |message: &str| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "provider_invalid",
        message: message.to_string(),
    };
    let base_url = request.base_url.trim();
    if base_url.is_empty() {
        return Err(bad("base_url must not be empty"));
    }
    let kind = request
        .kind
        .as_deref()
        .and_then(ProviderKind::parse)
        .unwrap_or(ProviderKind::OpenaiCompat);
    let label = request
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| base_url.to_string());
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(model_registry::slugify)
        .unwrap_or_else(|| model_registry::slugify(&label));

    let mut registry = load_provider_registry();
    let mut entry = ProviderEntry::new(id.clone(), label, kind, base_url.to_string());
    entry.active_model = request
        .active_model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    registry.upsert(entry);

    if let Some(key) = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        set_provider_api_key(&id, key).map_err(|message| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "provider_key_persist_failed",
            message,
        })?;
    }

    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(providers_response(&registry)))
}

async fn remove_provider(
    Path(id): Path<String>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let mut registry = load_provider_registry();
    if !registry.remove(&id) {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "provider_not_found",
            message: format!("provider {id} non configurato"),
        });
    }
    delete_provider_api_key(&id);
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(providers_response(&registry)))
}

async fn activate_provider(
    Path(id): Path<String>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let mut registry = load_provider_registry();
    if registry.get(&id).is_none() {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "provider_not_found",
            message: format!("provider {id} non configurato"),
        });
    }
    registry.active_provider_id = Some(id);
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(providers_response(&registry)))
}

/// Fetches the provider's live model catalog, infers capability flags, caches it
/// in the registry, and returns the refreshed view.
async fn refresh_provider_models(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let mut registry = load_provider_registry();
    let entry = registry.get(&id).cloned().ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "provider_not_found",
        message: format!("provider {id} non configurato"),
    })?;

    let url = entry.models_endpoint();
    let mut request = state.http.get(&url).timeout(std::time::Duration::from_secs(6));
    let key = provider_api_key(&id);
    if let Some(key) = key.as_deref() {
        match entry.kind {
            ProviderKind::Anthropic => {
                request = request
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01");
            }
            _ if entry.kind.lists_with_bearer() => {
                request = request.bearer_auth(key);
            }
            _ => {}
        }
    }
    let response = request.send().await.map_err(|error| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "provider_models_unreachable",
        message: format!("modelli non raggiungibili: {error}"),
    })?;
    if !response.status().is_success() {
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "provider_models_http_error",
            message: format!("HTTP {} dal provider", response.status().as_u16()),
        });
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "provider_models_decode_failed",
            message: error.to_string(),
        })?;
    let ids = model_registry::parse_models_response(entry.kind, &body);

    if let Some(stored) = registry.get_mut(&id) {
        // Preserve the user's manual profile edits across a catalog refresh;
        // re-infer everything else (so heuristic fixes apply).
        let user_profiles: std::collections::HashMap<String, model_registry::ModelProfile> = stored
            .models
            .iter()
            .filter_map(|m| {
                m.profile
                    .as_ref()
                    .filter(|p| p.source == "user")
                    .map(|p| (m.id.clone(), p.clone()))
            })
            .collect();
        stored.models = ids
            .iter()
            .map(|model_id| {
                let mut entry = model_registry::ModelEntry::inferred(model_id);
                if let Some(profile) = user_profiles.get(model_id) {
                    entry.profile = Some(profile.clone());
                }
                entry
            })
            .collect();
        stored.models_fetched_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs().to_string());
    }
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(providers_response(&registry)))
}

fn provider_registry_persist_error(message: String) -> GatewayError {
    GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "provider_registry_persist_failed",
        message,
    }
}

#[derive(Debug, Deserialize)]
struct SetModelProfileRequest {
    provider_id: String,
    model: String,
    tier: String,
    strengths: Option<String>,
    /// Optional capability overrides (the gate fields). Absent = leave as-is.
    vision: Option<bool>,
    tools: Option<bool>,
    reasoning: Option<bool>,
    context_window: Option<u32>,
}

/// User-curates a model's profile (tier + strengths) and, optionally, its
/// capability flags (vision/tools/context window). Source becomes "user" /
/// confidence 100, so it wins over curated/inferred and drives ranking + gating.
async fn set_model_profile(
    Json(request): Json<SetModelProfileRequest>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let tier = model_registry::ModelTier::parse(&request.tier).ok_or_else(|| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "tier_invalid",
        message: "tier must be fast|balanced|reasoning".to_string(),
    })?;
    let mut registry = load_provider_registry();
    // Keep the existing strengths text when the caller doesn't supply one.
    let strengths = request
        .strengths
        .or_else(|| {
            registry
                .get(&request.provider_id)
                .and_then(|p| p.models.iter().find(|m| m.id == request.model))
                .and_then(|m| m.profile.as_ref().map(|pr| pr.strengths.clone()))
        })
        .unwrap_or_default();
    let profile = model_registry::ModelProfile {
        tier,
        strengths,
        source: "user".to_string(),
        confidence: 100,
    };
    let updated = registry.update_model(&request.provider_id, &request.model, |model| {
        model.profile = Some(profile);
        if let Some(vision) = request.vision {
            model.vision = vision;
        }
        if let Some(tools) = request.tools {
            model.tools = tools;
        }
        if let Some(reasoning) = request.reasoning {
            model.reasoning = reasoning;
        }
        if let Some(context_window) = request.context_window {
            model.context_window = Some(context_window);
        }
    });
    if !updated {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "model_not_found",
            message: format!("modello {} non trovato in {}", request.model, request.provider_id),
        });
    }
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(providers_response(&registry)))
}

/// Generates `strengths` + `tier` drafts for the provider's models that only have
/// an inferred placeholder profile (the "generated where not curated" half of the
/// hybrid). Asks a capable model to describe each model id; results are marked
/// source="generated" (medium confidence) and remain user-editable. Curated and
/// user profiles are left untouched.
async fn generate_provider_profiles(
    Path(id): Path<String>,
) -> Result<Json<ProvidersResponse>, GatewayError> {
    let registry = load_provider_registry();
    let provider = registry.get(&id).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "provider_not_found",
        message: format!("provider {id} non configurato"),
    })?;
    // Only fill the inferred placeholders (no profile, or source == "inferred").
    let to_describe: Vec<String> = provider
        .models
        .iter()
        .filter(|m| {
            m.profile
                .as_ref()
                .map(|p| p.source == "inferred")
                .unwrap_or(true)
        })
        .map(|m| m.id.clone())
        .collect();
    if to_describe.is_empty() {
        return Ok(Json(providers_response(&registry)));
    }

    let list = to_describe
        .iter()
        .map(|mid| format!("- {mid}"))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "Per ciascun id-modello elencato, indica in cosa eccelle e il tier.\n\
         tier ∈ {{fast, balanced, reasoning}} (fast=veloce/economico, balanced=uso \
         generale forte, reasoning=ragionamento profondo). strengths = UNA frase \
         concisa. Se non conosci il modello, usa tier \"balanced\" e strengths \"\".\n\n\
         Modelli:\n{list}\n\n\
         Rispondi SOLO con JSON: {{\"profiles\": [{{\"id\":\"<id esatto>\",\"tier\":\"...\",\"strengths\":\"...\"}}]}}."
    );
    let request = GenerateJsonRequest {
        prompt,
        max_tokens: 1_200,
        temperature: 0.0,
        wait_if_busy: true,
        request_timeout_seconds: Some(60.0),
        json_schema: None,
        required_keys: vec!["profiles".to_string()],
        repair: true,
    };
    // The provider's HTTP call is blocking; run it off the async runtime.
    let response = tokio::task::spawn_blocking(move || {
        router_for_role("orchestrator").generate_json_with(&Requirements::default(), &request)
    })
    .await
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "profile_generation_join_failed",
        message: error.to_string(),
    })?
    .map_err(|error| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "profile_generation_failed",
        message: format!("generazione profili fallita: {error:?}"),
    })?;
    if !response.valid {
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "profile_generation_invalid",
            message: response.errors.join("; "),
        });
    }

    // Re-load and apply (the LLM call is async; keep the write atomic-ish).
    let mut registry = load_provider_registry();
    let valid_ids: std::collections::HashSet<&str> =
        to_describe.iter().map(String::as_str).collect();
    if let Some(profiles) = response.json.get("profiles").and_then(Value::as_array) {
        for entry in profiles {
            let model_id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
            if model_id.is_empty() || !valid_ids.contains(model_id) {
                continue;
            }
            let tier = entry
                .get("tier")
                .and_then(Value::as_str)
                .and_then(model_registry::ModelTier::parse)
                .unwrap_or(model_registry::ModelTier::Balanced);
            let strengths = entry
                .get("strengths")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            registry.set_model_profile(
                &id,
                model_id,
                model_registry::ModelProfile {
                    tier,
                    strengths,
                    source: "generated".to_string(),
                    confidence: 50,
                },
            );
        }
    }
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(providers_response(&registry)))
}

// ── Role → model endpoints (Phase 2) ──────────────────────────────────────

#[derive(Debug, Serialize)]
struct RoleView {
    key: &'static str,
    label: &'static str,
    description: &'static str,
    /// True when the role resolves via capability auto-match (no manual pin).
    auto: bool,
    /// The user's explicit pin, if any.
    binding_provider_id: Option<String>,
    binding_model: Option<String>,
    /// What the role actually resolves to right now.
    resolved_provider_id: Option<String>,
    resolved_model: Option<String>,
    resolved_kind: Option<String>,
}

#[derive(Debug, Serialize)]
struct RolesResponse {
    roles: Vec<RoleView>,
}

fn roles_response(registry: &ProviderRegistry) -> RolesResponse {
    let roles = model_registry::ROLES
        .iter()
        .map(|info| {
            let binding = registry.roles.get(info.key);
            let resolved = registry.resolve_role(info.key);
            RoleView {
                key: info.key,
                label: info.label,
                description: info.description,
                auto: resolved.as_ref().map(|r| r.auto).unwrap_or(true),
                binding_provider_id: binding.and_then(|b| b.provider_id.clone()),
                binding_model: binding.and_then(|b| b.model.clone()),
                resolved_provider_id: resolved.as_ref().map(|r| r.provider_id.clone()),
                resolved_model: resolved.as_ref().map(|r| r.model.clone()),
                resolved_kind: resolved.as_ref().map(|r| r.kind.as_str().to_string()),
            }
        })
        .collect();
    RolesResponse { roles }
}

async fn list_roles() -> Json<RolesResponse> {
    Json(roles_response(&load_provider_registry()))
}

#[derive(Debug, Serialize)]
struct RoutingDecisionsResponse {
    decisions: Vec<RoutingDecision>,
}

/// The recent model-routing decisions (most recent first) — observability for the
/// semantic router: which model was chosen for a task, among which candidates, why.
async fn list_routing_decisions() -> Json<RoutingDecisionsResponse> {
    let mut decisions = load_routing_decisions();
    decisions.reverse();
    Json(RoutingDecisionsResponse { decisions })
}

#[derive(Debug, Deserialize)]
struct SetRoleRequest {
    role: String,
    /// Both present → manual pin; either missing/empty → auto.
    provider_id: Option<String>,
    model: Option<String>,
}

async fn set_role(
    Json(request): Json<SetRoleRequest>,
) -> Result<Json<RolesResponse>, GatewayError> {
    if !model_registry::ROLES.iter().any(|r| r.key == request.role) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "role_unknown",
            message: format!("ruolo sconosciuto: {}", request.role),
        });
    }
    let provider_id = request
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut registry = load_provider_registry();
    match (provider_id, model) {
        (Some(pid), Some(model)) => {
            if registry.get(pid).is_none() {
                return Err(GatewayError {
                    status: StatusCode::NOT_FOUND,
                    code: "provider_not_found",
                    message: format!("provider {pid} non configurato"),
                });
            }
            registry.roles.insert(
                request.role.clone(),
                RoleBinding {
                    provider_id: Some(pid.to_string()),
                    model: Some(model.to_string()),
                },
            );
        }
        // Anything else clears the pin → auto.
        _ => {
            registry.roles.remove(&request.role);
        }
    }
    save_provider_registry(&registry).map_err(provider_registry_persist_error)?;
    Ok(Json(roles_response(&registry)))
}

async fn runtime_model() -> Json<ActiveModelResponse> {
    Json(active_inference_model_info())
}

fn loop_output_excerpt(output: &Value, fallback_excerpt: &str) -> String {
    let rendered = serde_json::to_string_pretty(output).unwrap_or_default();
    if rendered.trim().is_empty() || rendered == "{}" {
        return fallback_excerpt.to_string();
    }
    truncate_chars(&rendered, 1_800)
}

fn browser_loop_final_answer_markdown(output: &Value) -> String {
    let summary = output
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("Ho completato il controllo browser e raccolto l'output disponibile.");
    let mut lines = vec![
        "### Ricerca completata".to_string(),
        String::new(),
        summary.to_string(),
    ];
    if let Some(options) = output.get("options").and_then(Value::as_array)
        && !options.is_empty()
    {
        lines.push(String::new());
        lines.push("**Opzioni trovate**".to_string());
        for option in options.iter().take(10) {
            lines.push(format!("- {}", browser_loop_option_line(option)));
        }
    }
    if let Some(sources) = output.get("sources").and_then(Value::as_array)
        && !sources.is_empty()
    {
        lines.push(String::new());
        lines.push("**Fonti**".to_string());
        for source in sources.iter().take(8) {
            if let Some(source) = source.as_str() {
                lines.push(format!("- {source}"));
            } else {
                lines.push(format!("- {}", truncate_chars(&source.to_string(), 180)));
            }
        }
    }
    lines.push(String::new());
    lines.push(
        "Dimmi quale opzione vuoi prenotare e procedo fino al prossimo gate sicuro. Prima di login, dati passeggero, pagamento o acquisto ti chiedero' conferma esplicita."
            .to_string(),
    );
    lines.join("\n")
}

fn browser_loop_option_line(option: &Value) -> String {
    if let Some(text) = option.as_str() {
        return text.to_string();
    }
    let Some(map) = option.as_object() else {
        return truncate_chars(&option.to_string(), 240);
    };
    // Render EVERY field the worker extracted, in the order it emitted them —
    // NO hardcoded key list at all (de-gemma): whatever the model captured
    // (airline, airport, times, price, …) flows through to the orchestrator,
    // which builds the per-row table from it.
    let parts: Vec<String> = map
        .iter()
        .filter_map(|(key, value)| {
            browser_option_scalar_text(value).map(|text| format!("{key}: {text}"))
        })
        .collect();
    if parts.is_empty() {
        truncate_chars(&option.to_string(), 240)
    } else {
        parts.join(" · ")
    }
}

/// A scalar option field as display text (skips empty strings and nested values).
fn browser_option_scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

async fn local_computer_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<Option<local_first_local_computer_session::ComputerSessionSnapshot>>, GatewayError>
{
    let store = lock_computer_store(&state)?;
    let snapshot = LocalComputerReadModel::new(&store)
        .snapshot(
            &session_id,
            gateway_user_id().as_str(),
            gateway_workspace_id().as_str(),
        )
        .map_err(GatewayError::local_computer)?;
    Ok(Json(snapshot))
}

async fn local_computer_artifact_preview(
    State(state): State<AppState>,
    Path((session_id, artifact_id)): Path<(String, String)>,
) -> Result<Json<Option<ComputerArtifactPreviewResponse>>, GatewayError> {
    let store = lock_computer_store(&state)?;
    let artifacts = store
        .artifacts_for_session(
            &session_id,
            gateway_user_id().as_str(),
            gateway_workspace_id().as_str(),
        )
        .map_err(GatewayError::local_computer)?;
    let Some(artifact) = artifacts
        .into_iter()
        .find(|artifact| artifact.artifact_id == artifact_id)
    else {
        return Ok(Json(None));
    };
    let path = PathBuf::from(&artifact.path_ref);
    let bytes = fs::read(&path).map_err(|error| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "artifact_preview_unavailable",
        message: error.to_string(),
    })?;
    let mime = match path.extension().and_then(|extension| extension.to_str()) {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Json(Some(ComputerArtifactPreviewResponse {
        artifact_id: artifact.artifact_id,
        title_redacted: redact_sensitive_text(&artifact.title),
        kind: artifact.kind,
        size_bytes: artifact.size_bytes,
        data_url: format!("data:{mime};base64,{encoded}"),
    })))
}

async fn memory_dashboard(
    State(state): State<AppState>,
) -> Result<Json<MemoryDashboard>, GatewayError> {
    let request = gateway_memory_access_request();
    let facade = lock_memory_facade(&state)?;
    let dashboard = MemoryUiReadModel::new(&facade)
        .dashboard(&request)
        .map_err(GatewayError::memory)?;
    Ok(Json(dashboard))
}

async fn capability_snapshot(
    State(state): State<AppState>,
) -> Result<Json<CapabilitySnapshotResponse>, GatewayError> {
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let registry = lock_capability_registry(&state)?;
    let policy = registry
        .policy_context(&user, &workspace)
        .map_err(GatewayError::capability)?;
    let snapshot = capability_snapshot_response(&registry, &user, &workspace, policy)?;
    Ok(Json(snapshot))
}

fn task_queue_response_for_state(state: &AppState) -> Result<TaskQueueResponse, GatewayError> {
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let store = lock_task_store(state)?;
    let snapshot = TaskUiReadModel::new(&store)
        .queue_snapshot(&user, &workspace)
        .map_err(GatewayError::task)?;
    task_queue_response(snapshot)
}

fn task_queue_response(snapshot: TaskQueueSnapshot) -> Result<TaskQueueResponse, GatewayError> {
    let mut resource_usage = snapshot
        .resource_usage
        .into_iter()
        .map(|(resource_class, units)| ResourceUsageResponse {
            resource_class: resource_class_label(resource_class).to_string(),
            units,
        })
        .collect::<Vec<_>>();
    resource_usage.sort_by(|left, right| left.resource_class.cmp(&right.resource_class));

    Ok(TaskQueueResponse {
        queued: snapshot
            .queued
            .into_iter()
            .map(task_item_response)
            .collect::<Result<Vec<_>, _>>()?,
        active: snapshot
            .active
            .into_iter()
            .map(task_item_response)
            .collect::<Result<Vec<_>, _>>()?,
        blocked: snapshot
            .blocked
            .into_iter()
            .map(task_item_response)
            .collect::<Result<Vec<_>, _>>()?,
        waiting_approvals: snapshot
            .waiting_approvals
            .into_iter()
            .map(approval_item_response)
            .collect::<Result<Vec<_>, _>>()?,
        recent_failures: snapshot
            .recent_failures
            .into_iter()
            .map(task_item_response)
            .collect::<Result<Vec<_>, _>>()?,
        resource_usage,
    })
}

fn task_detail_response(detail: TaskUiDetail) -> Result<TaskDetailResponse, GatewayError> {
    Ok(TaskDetailResponse {
        item: task_item_response(TaskUiItem {
            task_id: detail.task_id,
            kind: detail.kind,
            goal: detail.goal,
            status: detail.status,
            priority: detail.priority,
            blocked_reason: detail.blocked_reason,
        })?,
        latest_checkpoint: detail.latest_checkpoint,
        runtime_metadata: detail.runtime_metadata,
        exposes_raw_input: detail.exposes_raw_input,
    })
}

fn task_item_response(item: TaskUiItem) -> Result<TaskItemResponse, GatewayError> {
    Ok(TaskItemResponse {
        task_id: item.task_id.as_str().to_string(),
        kind: item.kind,
        goal: item.goal,
        status: enum_label(&item.status)?,
        priority: enum_label(&item.priority)?,
        blocked_reason: item.blocked_reason,
    })
}

fn approval_item_response(approval: ApprovalRequest) -> Result<ApprovalItemResponse, GatewayError> {
    let browser_scoped = approval.action == "browser.manual_action"
        || approval.action == "prompt_plan.approve_step"
        || approval.data_boundary.contains("browser")
        || approval.explanation.to_lowercase().contains("browser");
    Ok(ApprovalItemResponse {
        approval_id: approval.approval_id,
        task_id: approval.task_id.as_str().to_string(),
        action: approval.action,
        risk_level: approval.risk_level,
        data_boundary: approval.data_boundary,
        explanation: approval.explanation,
        status: enum_label(&approval.status)?,
        scope_options: if browser_scoped {
            vec!["once".to_string(), "always".to_string()]
        } else {
            vec!["once".to_string()]
        },
        browser_visibility_options: if browser_scoped {
            vec![
                "auto".to_string(),
                "visible".to_string(),
                "headless".to_string(),
            ]
        } else {
            Vec::new()
        },
        default_browser_visibility: "auto".to_string(),
    })
}

fn ensure_operational_task_for_thread(
    state: &AppState,
    thread_id: &str,
    source_message_id: &str,
    goal: &str,
    mode: TaskCreationMode,
) -> Result<Option<String>, GatewayError> {
    let thread = lock_store(state)?
        .thread(thread_id)
        .map_err(GatewayError::store)?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "chat_thread_not_found",
            message: format!("chat thread not found: {thread_id}"),
        })?;
    let task_id = thread.task_id.clone();
    let session_id = thread.computer_session_id.clone();
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let task_id_ref = TaskId::new(task_id.clone());
    let goal_redacted = task_goal_summary(goal);
    let prompt_redacted = redact_sensitive_text(goal);
    // De-gemma: no keyword classification of the task. The browser loop is the
    // general model-driven executor and figures out the goal itself, so a chat
    // task is a browser_task. (Multi-step/durable planning is the Brain-as-tool
    // follow-up; shell tasks get their own explicit entry, not keyword-sniffed.)
    let task_kind = "browser_task";
    let operational_plan = operational_plan_for_goal(goal, task_kind);
    // Approval is conservative and keyword-free: auto-created tasks always
    // require confirmation; the browser loop's own action gate still stops
    // before login/payment/purchase regardless. Pre-approved plans skip it.
    let requires_approval = (mode == TaskCreationMode::AutoFromPrompt)
        && !browser_plan_is_preapproved(state, task_kind, goal);

    {
        let store = lock_task_store(state)?;
        if store
            .get_task(&task_id_ref, &user, &workspace)
            .map_err(GatewayError::task)?
            .is_none()
        {
            let mut task = TaskRecord::new(
                task_id.clone(),
                user.clone(),
                workspace.clone(),
                task_kind,
                goal_redacted.clone(),
                serde_json::json!({
                    "source": "desktop_chat",
                    "thread_id": thread_id,
                    "message_id": source_message_id,
                    "mode": match mode {
                        TaskCreationMode::AutoFromPrompt => "auto_from_prompt",
                        TaskCreationMode::ExplicitMessageAction => "explicit_message_action",
                    },
                    "operational_plan": operational_plan_payload(&operational_plan),
                    "prompt_redacted": prompt_redacted,
                    "raw_prompt_stored": false
                }),
            )
            .with_priority(if mode == TaskCreationMode::ExplicitMessageAction {
                TaskPriority::High
            } else {
                TaskPriority::Normal
            })
            .with_resource(ResourceRequirement::new(ResourceClass::ComputerSession, 1))
            .with_resource(ResourceRequirement::new(ResourceClass::BrowserSession, 1))
            .with_resource(ResourceRequirement::new(ResourceClass::NetworkIo, 1));
            task.risk_level = if requires_approval {
                "medium".to_string()
            } else {
                "low".to_string()
            };
            task.permission_context = serde_json::json!({
                "privacy_domains": ["local", "browser"],
                "requires_user_approval": requires_approval,
                "cloud_allowed": false
            });
            store.insert_task(&task).map_err(GatewayError::task)?;
            store
                .append_checkpoint(
                    &task_id_ref,
                    &user,
                    &workspace,
                    serde_json::json!({
                        "kind": "operational_plan",
                        "plan": operational_plan_payload(&operational_plan),
                    }),
                    serde_json::json!({
                        "kind": "operational_plan",
                        "plan": operational_plan_payload(&operational_plan),
                    }),
                )
                .map_err(GatewayError::task)?;
        }

        let latest_approval = store
            .latest_approval(&task_id_ref, &user, &workspace)
            .map_err(GatewayError::task)?;
        if requires_approval
            && !matches!(
                latest_approval.as_ref().map(|approval| approval.status),
                Some(ApprovalStatus::Pending)
            )
        {
            ApprovalGate::new()
                .request_approval(
                    &store,
                    &task_id_ref,
                    &user,
                    &workspace,
                    "prompt_plan.approve_step",
                    "medium",
                    "local_computer",
                    &approval_explanation_for_plan(&operational_plan),
                )
                .map_err(GatewayError::task)?;
        }
    }

    ensure_computer_session_for_task(
        state,
        &session_id,
        &task_id,
        thread_id,
        &goal_redacted,
        requires_approval,
    )?;
    lock_store(state)?
        .link_message_task(thread_id, source_message_id, &task_id)
        .map_err(GatewayError::store)?;
    Ok(Some(task_id))
}

fn ensure_computer_session_for_task(
    state: &AppState,
    session_id: &str,
    task_id: &str,
    thread_id: &str,
    goal_redacted: &str,
    requires_approval: bool,
) -> Result<(), GatewayError> {
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let mut store = lock_computer_store(state)?;
    if store
        .session(session_id, user.as_str(), workspace.as_str())
        .map_err(GatewayError::local_computer)?
        .is_some()
    {
        return Ok(());
    }

    let now = OffsetDateTime::now_utc();
    let session = ComputerSessionRecord {
        session_id: session_id.to_string(),
        task_id: task_id.to_string(),
        workflow_id: Some(format!("workflow_{thread_id}")),
        user_id: user.as_str().to_string(),
        workspace_id: workspace.as_str().to_string(),
        status: if requires_approval {
            SessionStatus::WaitingUser
        } else {
            SessionStatus::Running
        },
        active_surface: if goal_redacted.to_lowercase().contains("terminal") {
            SurfaceKind::Shell
        } else {
            SurfaceKind::Browser
        },
        surfaces: default_computer_surfaces(now),
        title: "Computer locale".to_string(),
        subtitle: goal_redacted.to_string(),
        progress_current: 0,
        progress_total: if requires_approval { 3 } else { 2 },
        approval_state: if requires_approval {
            ApprovalState::WaitingUser
        } else {
            ApprovalState::None
        },
        takeover_state: TakeoverState::None,
        risk_level: if requires_approval { "medium" } else { "low" }.to_string(),
        last_error: None,
        started_at: now,
        updated_at: now,
    };
    store
        .upsert_session(&session)
        .map_err(GatewayError::local_computer)?;
    append_computer_event(
        &mut store,
        session_id,
        &user,
        &workspace,
        SurfaceKind::Logs,
        "computer_session_started",
        "done",
        "Task locale creato",
        "Sessione Computer locale associata alla chat.",
        false,
    )?;
    if requires_approval {
        append_computer_event(
            &mut store,
            session_id,
            &user,
            &workspace,
            SurfaceKind::Logs,
            "computer_approval_required",
            "waiting",
            "Approval richiesta",
            "Conferma il piano prima di eseguire azioni locali.",
            true,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_computer_event(
    store: &mut LocalComputerSessionStore,
    session_id: &str,
    user: &UserId,
    workspace: &WorkspaceId,
    surface: SurfaceKind,
    kind: &str,
    status: &str,
    title: &str,
    subtitle: &str,
    approval_required: bool,
) -> Result<(), GatewayError> {
    store
        .append_event(&ComputerEventRecord {
            event_id: format!(
                "event_{}_{}",
                OffsetDateTime::now_utc().unix_timestamp_nanos(),
                kind
            ),
            session_id: session_id.to_string(),
            user_id: user.as_str().to_string(),
            workspace_id: workspace.as_str().to_string(),
            surface,
            kind: kind.to_string(),
            status: status.to_string(),
            title: title.to_string(),
            subtitle: subtitle.to_string(),
            payload: serde_json::json!({ "payload_redacted": true }),
            artifact_refs: vec![],
            approval_required,
            created_at: OffsetDateTime::now_utc(),
        })
        .map_err(GatewayError::local_computer)
}

#[allow(clippy::too_many_arguments)]
fn append_computer_event_with_payload(
    store: &mut LocalComputerSessionStore,
    session_id: &str,
    user: &UserId,
    workspace: &WorkspaceId,
    surface: SurfaceKind,
    kind: &str,
    status: &str,
    title: &str,
    subtitle: &str,
    payload: Value,
    approval_required: bool,
    artifact_refs: Vec<String>,
) -> Result<(), GatewayError> {
    store
        .append_event(&ComputerEventRecord {
            event_id: format!(
                "event_{}_{}",
                OffsetDateTime::now_utc().unix_timestamp_nanos(),
                kind
            ),
            session_id: session_id.to_string(),
            user_id: user.as_str().to_string(),
            workspace_id: workspace.as_str().to_string(),
            surface,
            kind: kind.to_string(),
            status: status.to_string(),
            title: title.to_string(),
            subtitle: subtitle.to_string(),
            payload,
            artifact_refs,
            approval_required,
            created_at: OffsetDateTime::now_utc(),
        })
        .map_err(GatewayError::local_computer)
}

fn default_computer_surfaces(now: OffsetDateTime) -> Vec<ComputerSurfaceRecord> {
    [
        (SurfaceKind::Browser, "Browser"),
        (SurfaceKind::Shell, "Terminale"),
        (SurfaceKind::Files, "File"),
        (SurfaceKind::Logs, "Log"),
    ]
    .into_iter()
    .map(|(surface, label)| ComputerSurfaceRecord {
        surface,
        label: label.to_string(),
        status: SurfaceStatus::Idle,
        detail: None,
        updated_at: now,
    })
    .collect()
}

fn surface_for_task(task: &TaskRecord) -> SurfaceKind {
    match task.kind.as_str() {
        "local_shell_task" => SurfaceKind::Shell,
        "browser_task" => SurfaceKind::Browser,
        kind if kind.starts_with("capability.browser.") => SurfaceKind::Browser,
        _ => SurfaceKind::Logs,
    }
}

fn browser_automation_dir() -> PathBuf {
    if let Ok(path) = env::var("LOCAL_FIRST_BROWSER_AUTOMATION_DIR") {
        return PathBuf::from(path);
    }
    FsPath::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../runtimes/browser-automation")
        .components()
        .collect()
}

/// Phase-1 default for the browser surface: HEADLESS.
///
/// Previously "0" (visible), which opened a real OS window that grabbed focus —
/// the behavior users dislike. Headless-by-default means the automated browser
/// runs invisibly; the user watches it *inside the chat* (the live frame view),
/// not as a window that takes over the desktop. This does NOT lose capability:
/// the sidecar's `restartAssistantVisible` self-heal still recovers the rare
/// site that genuinely fails headless, so it's "invisible by default, a window
/// only as a last resort" rather than "a window always". Override per install
/// with `LOCAL_FIRST_BROWSER_HEADLESS=0`.
fn default_browser_headless_value() -> &'static str {
    "1"
}

fn browser_headless_env_value() -> String {
    env::var("LOCAL_FIRST_BROWSER_HEADLESS")
        .unwrap_or_else(|_| default_browser_headless_value().to_string())
}

/// Resolves the contained-computer CDP endpoint (ADR 0010) from config, pure for
/// testability. An explicit `LOCAL_FIRST_CONTAINED_COMPUTER_CDP` wins; otherwise
/// `LOCAL_FIRST_CONTAINED_COMPUTER=1|true` enables the default local endpoint.
/// `None` means "use the on-host browser" (current default).
fn resolve_contained_computer_cdp(
    explicit: Option<&str>,
    enabled_flag: Option<&str>,
) -> Option<String> {
    if let Some(endpoint) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(endpoint.to_string());
    }
    let enabled = enabled_flag
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    enabled.then(|| "http://127.0.0.1:9222".to_string())
}

fn contained_computer_cdp_endpoint() -> Option<String> {
    resolve_contained_computer_cdp(
        env::var("LOCAL_FIRST_CONTAINED_COMPUTER_CDP").ok().as_deref(),
        env::var("LOCAL_FIRST_CONTAINED_COMPUTER").ok().as_deref(),
    )
}

/// The noVNC live-view URL for the contained computer (ADR 0010), or `None` when
/// contained mode is off. Pure for testability; the in-chat panel embeds this URL.
fn resolve_contained_computer_novnc(enabled: bool, explicit: Option<&str>) -> Option<String> {
    if !enabled {
        return None;
    }
    Some(
        explicit
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("http://127.0.0.1:6080/vnc.html")
            .to_string(),
    )
}

#[derive(Debug, Serialize)]
struct ContainedComputerLiveResponse {
    enabled: bool,
    novnc_url: Option<String>,
    /// True only while a browse_web is actually running right now.
    active: bool,
    /// The current activity (goal) when active, for the panel subtitle.
    activity: Option<String>,
    /// Steps executed so far — the live checklist ("Avanzamento attività").
    steps: Vec<BrowserStepView>,
    /// True while a CLI skill command is running in the contained computer.
    terminal_active: bool,
    /// Terminal commands + output for the current chat response (CLI skills).
    terminal: Vec<TerminalEntryView>,
}

/// Reports whether the contained computer's live view is available, where to
/// embed it, whether the browser is working RIGHT NOW, and the live step
/// checklist. Polled by the desktop panel.
async fn contained_computer_live() -> Json<ContainedComputerLiveResponse> {
    let novnc_url = resolve_contained_computer_novnc(
        contained_computer_cdp_endpoint().is_some(),
        env::var("LOCAL_FIRST_CONTAINED_COMPUTER_NOVNC").ok().as_deref(),
    );
    let activity_state = current_browser_activity();
    let terminal = current_sandbox_activity();
    let terminal_active = terminal.iter().any(|entry| entry.running);
    Json(ContainedComputerLiveResponse {
        // The panel is useful for terminal activity even when the noVNC view is
        // not available, so report enabled when either surface has something.
        enabled: novnc_url.is_some() || !terminal.is_empty(),
        novnc_url,
        active: activity_state.is_some(),
        activity: activity_state.as_ref().map(|state| state.goal.clone()),
        steps: activity_state.map(|state| state.steps).unwrap_or_default(),
        terminal_active,
        terminal,
    })
}

const CONTAINED_CONTAINER_NAME: &str = "lfpa-cc";

#[derive(Debug, Serialize)]
struct DockerStatus {
    installed: bool,
    running: bool,
    container_up: bool,
}

#[derive(Debug, Serialize)]
struct SystemStatusResponse {
    docker: DockerStatus,
    contained_enabled: bool,
    contained_cdp_ok: bool,
    gateway_memory_mb: u64,
    container_memory_mb: Option<u64>,
    browser_sessions: usize,
}

/// Run a CLI command, returning trimmed stdout on success (None otherwise).
fn run_cli(program: &str, args: &[&str]) -> Option<String> {
    std::process::Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Resident memory of THIS gateway process, in MB (best-effort via `ps`).
fn gateway_memory_mb() -> u64 {
    let pid = std::process::id().to_string();
    run_cli("ps", &["-o", "rss=", "-p", &pid])
        .and_then(|stdout| stdout.split_whitespace().next().map(str::to_string))
        .and_then(|kb| kb.parse::<u64>().ok())
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

/// Parse the first figure of a `docker stats` MemUsage cell (e.g. "123.4MiB / 512MiB").
fn parse_docker_mem_mb(usage: &str) -> Option<u64> {
    let first = usage.split('/').next()?.trim();
    let digits: String = first
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let value: f64 = digits.parse().ok()?;
    let mb = if first.contains("GiB") || first.contains("GB") {
        value * 1024.0
    } else if first.contains("KiB") || first.contains("KB") {
        value / 1024.0
    } else {
        value // MiB/MB
    };
    Some(mb.round() as u64)
}

/// System/Computer status for Settings: Docker (installed/running + the contained
/// computer container), tool memory usage, live browser-session count.
async fn system_status(State(state): State<AppState>) -> Json<SystemStatusResponse> {
    let browser_sessions = state
        .browser_thread_sessions
        .lock()
        .map(|map| map.len())
        .unwrap_or(0);
    let cdp = contained_computer_cdp_endpoint();
    let contained_enabled = cdp.is_some();
    let contained_cdp_ok = if let Some(endpoint) = cdp.as_ref() {
        state
            .http
            .get(format!("{}/json/version", endpoint.trim_end_matches('/')))
            .timeout(std::time::Duration::from_millis(800))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    } else {
        false
    };
    let (docker, gateway_mb, container_mb) = tokio::task::spawn_blocking(|| {
        let installed = run_cli("docker", &["--version"]).is_some();
        let running =
            installed && run_cli("docker", &["info", "--format", "{{.ServerVersion}}"]).is_some();
        let filter = format!("name={CONTAINED_CONTAINER_NAME}");
        let container_up = running
            && run_cli("docker", &["ps", "--filter", &filter, "--format", "{{.Names}}"])
                .map(|names| names.contains(CONTAINED_CONTAINER_NAME))
                .unwrap_or(false);
        let container_mb = if container_up {
            run_cli(
                "docker",
                &["stats", "--no-stream", "--format", "{{.MemUsage}}", CONTAINED_CONTAINER_NAME],
            )
            .as_deref()
            .and_then(parse_docker_mem_mb)
        } else {
            None
        };
        (
            DockerStatus { installed, running, container_up },
            gateway_memory_mb(),
            container_mb,
        )
    })
    .await
    .unwrap_or((
        DockerStatus { installed: false, running: false, container_up: false },
        0,
        None,
    ));

    Json(SystemStatusResponse {
        docker,
        contained_enabled,
        contained_cdp_ok,
        gateway_memory_mb: gateway_mb,
        container_memory_mb: container_mb,
        browser_sessions,
    })
}

#[derive(Debug, Serialize)]
struct CloseAllBrowsersResponse {
    closed_sessions: usize,
    closed_tabs: usize,
}

/// Close every per-thread browser session AND any lingering page in the contained
/// browser. Exposed in Settings as "Chiudi tutti i browser".
async fn close_all_browsers(State(state): State<AppState>) -> Json<CloseAllBrowsersResponse> {
    let sessions: Vec<ThreadBrowserSession> = state
        .browser_thread_sessions
        .lock()
        .map(|mut map| map.drain().map(|(_, session)| session).collect())
        .unwrap_or_default();
    let closed_sessions = sessions.len();
    let _ = tokio::task::spawn_blocking(move || {
        for session in sessions {
            let _ = session.client.call(BrowserMethod::Stop, serde_json::json!({}));
        }
    })
    .await;

    let mut closed_tabs = 0usize;
    if let Some(endpoint) = contained_computer_cdp_endpoint() {
        let base = endpoint.trim_end_matches('/').to_string();
        if let Ok(response) = state
            .http
            .get(format!("{base}/json"))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            if let Ok(targets) = response.json::<Vec<serde_json::Value>>().await {
                for target in targets {
                    if target.get("type").and_then(Value::as_str) != Some("page") {
                        continue;
                    }
                    let Some(id) = target.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let closed = state
                        .http
                        .get(format!("{base}/json/close/{id}"))
                        .timeout(std::time::Duration::from_secs(2))
                        .send()
                        .await
                        .map(|response| response.status().is_success())
                        .unwrap_or(false);
                    if closed {
                        closed_tabs += 1;
                    }
                }
            }
        }
    }

    Json(CloseAllBrowsersResponse { closed_sessions, closed_tabs })
}

/// Env for the browser sidecar, shared by every spawn site so contained-computer
/// mode can never be wired into one path and missed in another. In contained
/// mode we add the CDP endpoint of the in-container real browser; the sidecar
/// then attaches via connectOverCDP instead of launching a host Chromium.
fn browser_sidecar_env(state: &AppState, task: &TaskRecord) -> Vec<(String, String)> {
    let artifact_root = env::temp_dir().join("local-first-browser-artifacts");
    let mut env = vec![
        (
            "BROWSER_AUTOMATION_HEADLESS".to_string(),
            browser_headless_env_value_for_task(state, task),
        ),
        (
            "BROWSER_AUTOMATION_ARTIFACT_ROOT".to_string(),
            artifact_root.display().to_string(),
        ),
    ];
    if let Some(endpoint) = contained_computer_cdp_endpoint() {
        env.push((
            "BROWSER_AUTOMATION_USER_CDP_ENDPOINT".to_string(),
            endpoint,
        ));
        // Isolated context is OFF by default: measured that a fresh ("cold")
        // context regresses reliability (no cookies -> consent/geo walls ->
        // the worker wanders and burns iterations). The default warm shared
        // context is far more reliable. Isolation is opt-in per worker (set via
        // LOCAL_FIRST_BROWSER_PARALLEL when fanning out) — see parallel path.
        if env::var("LOCAL_FIRST_BROWSER_ISOLATED_CONTEXT").as_deref() == Ok("1") {
            env.push((
                "BROWSER_AUTOMATION_ISOLATED_CONTEXT".to_string(),
                "1".to_string(),
            ));
        }
    }
    env
}

fn browser_headless_env_value_for_task(state: &AppState, task: &TaskRecord) -> String {
    let fallback = browser_headless_env_value();
    browser_visibility_for_task(state, task).headless_env_value(&fallback)
}

fn browser_visibility_for_task(state: &AppState, task: &TaskRecord) -> BrowserVisibilityMode {
    if !task_uses_browser(task) {
        return BrowserVisibilityMode::Auto;
    }
    let latest_checkpoint_visibility = task
        .checkpoint_json
        .as_ref()
        .and_then(|checkpoint| checkpoint.get("browser_visibility"))
        .and_then(Value::as_str)
        .map(|value| parse_browser_visibility(Some(value)))
        .filter(|visibility| *visibility != BrowserVisibilityMode::Auto);
    if let Some(visibility) = latest_checkpoint_visibility {
        return visibility;
    }

    let Ok(policy_store) = lock_browser_url_policies(state) else {
        return BrowserVisibilityMode::Auto;
    };
    for target in browser_targets_for_goal(&task_effective_goal(task)) {
        let Ok(Some(rule)) = policy_store.rule_for_url(
            gateway_user_id().as_str(),
            gateway_workspace_id().as_str(),
            &target.url,
            "navigate",
        ) else {
            continue;
        };
        if rule.visibility != BrowserVisibilityMode::Auto {
            return rule.visibility;
        }
    }
    BrowserVisibilityMode::Auto
}

fn task_uses_browser(task: &TaskRecord) -> bool {
    task.kind == "browser_task"
        || task.kind.starts_with("capability.browser.")
        || task
            .resource_requirements
            .iter()
            .any(|resource| resource.class == ResourceClass::BrowserSession)
}

fn browser_plan_is_preapproved(state: &AppState, task_kind: &str, goal: &str) -> bool {
    if task_kind != "browser_task" {
        return false;
    }
    let targets = browser_targets_for_goal(goal);
    if targets.is_empty() {
        return false;
    }
    let Ok(policy_store) = lock_browser_url_policies(state) else {
        return false;
    };
    targets.iter().all(|target| {
        policy_store
            .rule_for_url(
                gateway_user_id().as_str(),
                gateway_workspace_id().as_str(),
                &target.url,
                "navigate",
            )
            .ok()
            .flatten()
            .is_some()
    })
}

fn parse_approval_scope(value: Option<&str>) -> BrowserUrlApprovalScope {
    match value {
        Some("always") => BrowserUrlApprovalScope::Always,
        _ => BrowserUrlApprovalScope::Once,
    }
}

fn parse_browser_visibility(value: Option<&str>) -> BrowserVisibilityMode {
    match value {
        Some("headless") => BrowserVisibilityMode::Headless,
        Some("visible") => BrowserVisibilityMode::Visible,
        _ => BrowserVisibilityMode::Auto,
    }
}

fn approval_scope_label(value: BrowserUrlApprovalScope) -> &'static str {
    match value {
        BrowserUrlApprovalScope::Once => "once",
        BrowserUrlApprovalScope::Always => "always",
    }
}

fn browser_visibility_label(value: BrowserVisibilityMode) -> &'static str {
    match value {
        BrowserVisibilityMode::Auto => "auto",
        BrowserVisibilityMode::Headless => "headless",
        BrowserVisibilityMode::Visible => "visible",
    }
}

#[derive(Debug, Clone)]
struct BrowserTarget {
    label: String,
    url: String,
}

/// ONE general entry for every goal: a web search of the goal. The model-driven
/// observe-act loop navigates from there. No keyword/domain/transport routing —
/// the model understands what the goal needs and decides where to go.
fn browser_targets_for_goal(goal: &str) -> Vec<BrowserTarget> {
    vec![BrowserTarget {
        label: "Ricerca web".to_string(),
        url: browser_url_for_goal(goal),
    }]
}

fn operational_plan_for_goal(goal: &str, task_kind: &str) -> OperationalPlan {
    let needs_browser = task_kind == "browser_task";
    OperationalPlan {
        objective: task_goal_summary(goal),
        intent_type: if needs_browser {
            OperationalIntentType::Navigational
        } else {
            OperationalIntentType::Informational
        },
        autonomy: if needs_browser {
            OperationalAutonomy::AutomaticUntilGate
        } else {
            OperationalAutonomy::AskBeforeEachExternalAction
        },
        tools: if needs_browser {
            vec!["browser".to_string()]
        } else {
            Vec::new()
        },
        steps: vec![
            operational_step(
                "understand_request",
                "Comprendere richiesta",
                "Capire obiettivo e vincoli dichiarati dall'utente.",
                None,
            ),
            operational_step(
                "execute_safe_actions",
                "Eseguire azioni consentite",
                "Usare solo strumenti locali e fermarsi ai gate di rischio.",
                if needs_browser { Some("browser") } else { None },
            ),
            operational_step(
                "answer",
                "Rispondere",
                "Sintetizzare risultato e limiti in chat.",
                None,
            ),
        ],
        constraints: vec!["Tutto local-first; nessuna API cloud.".to_string()],
        success_criteria: vec!["Risposta utile prodotta senza violare i vincoli.".to_string()],
        stop_conditions: vec!["Serve conferma utente per azioni rischiose.".to_string()],
        approval_gates: Vec::new(),
        data_schema: Vec::new(),
    }
}

fn operational_plan_payload(plan: &OperationalPlan) -> Value {
    serde_json::to_value(plan).unwrap_or_else(|_| serde_json::json!({ "error": "plan_encode" }))
}

fn operational_plan_markdown(plan: &OperationalPlan) -> String {
    let mut lines = Vec::new();
    lines.push(format!(
        "# Piano operativo\n\nObiettivo: {}",
        plan.objective
    ));
    lines.push(format!(
        "Intento: {:?}  \nAutonomia: {:?}  \nTool: {}",
        plan.intent_type,
        plan.autonomy,
        if plan.tools.is_empty() {
            "nessuno".to_string()
        } else {
            plan.tools.join(", ")
        }
    ));
    lines.push("\n## Tasklist".to_string());
    for step in &plan.steps {
        let marker = match step.status {
            OperationalStepStatus::Pending => "[ ]",
            OperationalStepStatus::InProgress => "[-]",
            OperationalStepStatus::Completed => "[x]",
            OperationalStepStatus::Blocked => "[!]",
        };
        let tool = step
            .tool
            .as_deref()
            .map(|tool| format!(" `{tool}`"))
            .unwrap_or_default();
        lines.push(format!(
            "- {marker} **{}**{} (`{}`): {}",
            step.title, tool, step.id, step.detail
        ));
    }
    if !plan.success_criteria.is_empty() {
        lines.push("\n## Criteri di successo".to_string());
        lines.extend(plan.success_criteria.iter().map(|item| format!("- {item}")));
    }
    if !plan.constraints.is_empty() {
        lines.push("\n## Vincoli".to_string());
        lines.extend(plan.constraints.iter().map(|item| format!("- {item}")));
    }
    if !plan.stop_conditions.is_empty() {
        lines.push("\n## Stop condition".to_string());
        lines.extend(plan.stop_conditions.iter().map(|item| format!("- {item}")));
    }
    if !plan.approval_gates.is_empty() {
        lines.push("\n## Gate di approvazione".to_string());
        lines.extend(plan.approval_gates.iter().map(|item| format!("- {item}")));
    }
    lines.join("\n")
}

fn write_operational_plan_artifact(
    task: &TaskRecord,
    plan: &OperationalPlan,
) -> Result<TaskArtifactOutput, LocalTaskExecutionError> {
    let artifact_id = format!("artifact_{}_operational_plan", task.task_id.as_str());
    let file_name = format!("{artifact_id}.md");
    let artifact_root = env::temp_dir().join("local-first-browser-artifacts");
    fs::create_dir_all(&artifact_root).map_err(|error| LocalTaskExecutionError {
        message: format!("Creazione directory artifact piano fallita: {error}"),
    })?;
    let path = artifact_root.join(file_name);
    let markdown = operational_plan_markdown(plan);
    fs::write(&path, markdown.as_bytes()).map_err(|error| LocalTaskExecutionError {
        message: format!("Scrittura artifact piano fallita: {error}"),
    })?;
    Ok(TaskArtifactOutput {
        artifact_id,
        title: "Piano operativo seguito".to_string(),
        kind: "markdown".to_string(),
        path_ref: path.display().to_string(),
        size_bytes: markdown.len() as u64,
        preview_ref: None,
    })
}

fn approval_explanation_for_plan(plan: &OperationalPlan) -> String {
    let steps = plan
        .steps
        .iter()
        .map(|step| step.title.as_str())
        .collect::<Vec<_>>()
        .join(" -> ");
    let gates = if plan.approval_gates.is_empty() {
        "Mi fermo prima di azioni rischiose o non comprese nel piano.".to_string()
    } else {
        plan.approval_gates.join(" ")
    };
    format!(
        "Conferma il piano operativo prima di usare browser, terminale o azioni locali. Piano: {steps}. {gates}"
    )
}

fn browser_url_for_goal(goal: &str) -> String {
    // Uniform entry for EVERY goal: a web search of the goal verbatim. No
    // keyword/site special-casing — the observe-act loop navigates from the
    // results to wherever the goal actually leads.
    format!("https://duckduckgo.com/?q={}", url_encode(goal))
}



fn browser_form_draft_payload(draft: &BrowserFormDraftSummary) -> Value {
    serde_json::json!({
        "label": draft.label,
        "url": draft.url,
        "status": draft.status,
        "filled_fields": draft.filled_fields,
        "reason": draft.reason,
        "search_status": draft.search_status,
        "search_excerpt": draft.search_excerpt,
    })
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        truncated.push_str("\n...");
    }
    truncated
}

fn evaluate_simple_arithmetic(text: &str) -> Option<String> {
    let expression = text
        .chars()
        .filter(|char| {
            char.is_ascii_digit() || matches!(char, '+' | '-' | '*' | '/' | 'x' | 'X' | ' ' | '.')
        })
        .collect::<String>()
        .replace(['x', 'X'], "*");
    let compact = expression.split_whitespace().collect::<String>();
    if compact.is_empty()
        || !compact
            .chars()
            .any(|char| matches!(char, '+' | '-' | '*' | '/'))
    {
        return None;
    }
    let (left, operator, right) = split_binary_expression(&compact)?;
    let left = left.parse::<f64>().ok()?;
    let right = right.parse::<f64>().ok()?;
    let value = match operator {
        '+' => left + right,
        '-' => left - right,
        '*' => left * right,
        '/' if right != 0.0 => left / right,
        '/' => return None,
        _ => return None,
    };
    if value.fract() == 0.0 {
        Some(format!("{}", value as i64))
    } else {
        Some(
            format!("{value:.4}")
                .trim_end_matches('0')
                .trim_end_matches('.')
                .to_string(),
        )
    }
}

fn split_binary_expression(expression: &str) -> Option<(&str, char, &str)> {
    for operator in ['*', '/', '+', '-'] {
        if let Some(index) = expression[1..].find(operator).map(|index| index + 1) {
            let left = &expression[..index];
            let right = &expression[index + 1..];
            if !left.is_empty() && !right.is_empty() {
                return Some((left, operator, right));
            }
        }
    }
    None
}

fn task_goal_summary(goal: &str) -> String {
    let redacted = redact_sensitive_text(goal)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let compact = compact_thread_title(&redacted);
    if compact.is_empty() {
        "Task locale dalla chat".to_string()
    } else {
        compact
    }
}

fn task_effective_goal(task: &TaskRecord) -> String {
    task.input_json
        .get("prompt_redacted")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(task.goal.as_str())
        .to_string()
}

fn capability_snapshot_response(
    registry: &CapabilityRegistryStore,
    user: &CapabilityUserId,
    workspace: &CapabilityWorkspaceId,
    policy: PolicyContext,
) -> Result<CapabilitySnapshotResponse, GatewayError> {
    let connections = registry
        .connection_configs(user, workspace)
        .map_err(GatewayError::capability)?
        .into_iter()
        .map(capability_connection_response)
        .collect::<Result<Vec<_>, _>>()?;

    let mut tools = Vec::new();
    for provider in &policy.enabled_providers {
        for cached in registry
            .cached_tools(provider)
            .map_err(GatewayError::capability)?
        {
            tools.push(capability_tool_response(cached)?);
        }
    }
    tools.sort_by(|left, right| {
        left.provider_id
            .cmp(&right.provider_id)
            .then(left.name.cmp(&right.name))
    });

    Ok(CapabilitySnapshotResponse {
        connections,
        tools,
        policy: CapabilityPolicyResponse {
            enabled_providers: policy
                .enabled_providers
                .into_iter()
                .map(|provider| provider.as_str().to_string())
                .collect(),
            allow_managed_cloud: policy.allow_managed_cloud,
            privacy_domains: policy.privacy_domains,
            max_autonomy_level: policy.max_autonomy_level,
        },
    })
}

fn capability_connection_response(
    config: CapabilityConnectionConfig,
) -> Result<CapabilityConnectionResponse, GatewayError> {
    Ok(CapabilityConnectionResponse {
        id: config.connection_id,
        provider_id: config.provider_id.as_str().to_string(),
        display_name: config.display_name,
        status: enum_label(&config.status)?,
        privacy_domains: config.privacy_domains,
        metadata: config.metadata,
    })
}

fn capability_tool_response(
    cached: CachedCapabilityTool,
) -> Result<CapabilityToolResponse, GatewayError> {
    Ok(CapabilityToolResponse {
        provider_id: cached.tool.provider_id.as_str().to_string(),
        name: cached.tool.name,
        provider_kind: enum_label(&cached.tool.provider_kind)?,
        action: enum_label(&cached.tool.action)?,
        description: cached.tool.description,
        privacy_domains: cached.tool.privacy_domains,
        sensitivity: cached.tool.sensitivity,
    })
}

fn open_seeded_capability_registry() -> Result<CapabilityRegistryStore, std::io::Error> {
    let registry = CapabilityRegistryStore::open(gateway_capability_database_path()?)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    seed_default_capabilities(&registry)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(registry)
}

fn seed_default_capabilities(
    registry: &CapabilityRegistryStore,
) -> Result<(), local_first_capabilities::CapabilityError> {
    let browser_provider = CapabilityProviderId::new("browser");
    registry.upsert_provider_config(&CapabilityProviderConfig::new(
        browser_provider.clone(),
        CapabilityProviderKind::Browser,
        "Il mio browser".to_string(),
        true,
    ))?;
    registry.upsert_provider_grant(
        &CapabilityProviderGrant::new(
            browser_provider.clone(),
            gateway_capability_user_id(),
            gateway_capability_workspace_id(),
        )
        .with_privacy_domains(vec!["browser".to_string(), "local".to_string()])
        .with_allowed_actions(vec![ActionClass::Read, ActionClass::WriteWithConfirmation])
        .with_max_autonomy_level(3),
    )?;
    registry.upsert_connection_config(
        &CapabilityConnectionConfig::new(
            "browser-local",
            browser_provider.clone(),
            gateway_capability_user_id(),
            gateway_capability_workspace_id(),
            "Il mio browser",
            "local-browser-profile",
        )
        .with_privacy_domains(vec!["browser".to_string()])
        .with_metadata(serde_json::json!({
            "data_boundary": "local",
            "transport": "playwright_cdp",
            "requires_confirmation": true
        })),
    )?;

    for (name, action, description) in [
        (
            "browser.health",
            ActionClass::Read,
            "Stato del browser locale",
        ),
        (
            "browser.tabs",
            ActionClass::Read,
            "Elenco tab browser locali",
        ),
        (
            "browser.snapshot",
            ActionClass::Read,
            "Snapshot redatto della pagina corrente",
        ),
        (
            "browser.navigate",
            ActionClass::WriteWithConfirmation,
            "Navigazione browser con conferma",
        ),
        (
            "browser.act",
            ActionClass::WriteWithConfirmation,
            "Azione controllata su pagina web",
        ),
        (
            "browser.screenshot",
            ActionClass::WriteWithConfirmation,
            "Screenshot locale redatto",
        ),
    ] {
        registry.upsert_cached_tool(&CachedCapabilityTool::new(
            browser_provider.clone(),
            name,
            CapabilityProviderKind::Browser,
            action,
            description,
            vec!["browser".to_string()],
            "private",
            serde_json::json!({"type": "object"}),
        ))?;
    }
    Ok(())
}

fn enum_label(value: &impl Serialize) -> Result<String, GatewayError> {
    serde_json::to_value(value)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "enum_serialize_failed",
            message: error.to_string(),
        })?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "enum_serialize_failed",
            message: "enum did not serialize to string".to_string(),
        })
}

fn resource_class_label(resource: ResourceClass) -> &'static str {
    resource.as_str()
}

fn redact_sensitive_text(input: &str) -> String {
    let mut output = strip_terminal_control_sequences(input);
    for marker in [
        "sk-",
        "sk_proj_",
        "token=",
        "Authorization:",
        "Bearer ",
        "password=",
        "secret=",
    ] {
        if let Some(index) = output.to_lowercase().find(&marker.to_lowercase()) {
            output.truncate(index + marker.len());
            output.push_str("[REDACTED]");
            return output;
        }
    }
    output
}

fn strip_terminal_control_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(char) = chars.next() {
        if char == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        if char.is_control() && char != '\n' && char != '\t' {
            continue;
        }
        output.push(char);
    }
    output
}

#[derive(Debug)]
struct GatewayError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl GatewayError {
    fn store(error: rusqlite::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "chat_store_error",
            message: error.to_string(),
        }
    }

    fn task(error: local_first_task_runtime::TaskRuntimeError) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "task_runtime_error",
            message: error.to_string(),
        }
    }

    fn local_computer(error: String) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "local_computer_error",
            message: error,
        }
    }

    fn memory(error: String) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "memory_error",
            message: error,
        }
    }

    fn capability(error: local_first_capabilities::CapabilityError) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "capability_error",
            message: error.to_string(),
        }
    }
}

fn lock_store(state: &AppState) -> Result<MutexGuard<'_, ChatStore>, GatewayError> {
    state.chat_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "chat_store_lock_error",
        message: error.to_string(),
    })
}

fn lock_task_store(state: &AppState) -> Result<MutexGuard<'_, TaskStore>, GatewayError> {
    state.task_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "task_store_lock_error",
        message: error.to_string(),
    })
}

fn lock_computer_store(
    state: &AppState,
) -> Result<MutexGuard<'_, LocalComputerSessionStore>, GatewayError> {
    state.computer_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "local_computer_store_lock_error",
        message: error.to_string(),
    })
}

fn lock_browser_url_policies(
    state: &AppState,
) -> Result<MutexGuard<'_, BrowserUrlPolicyStore>, GatewayError> {
    state
        .browser_url_policies
        .lock()
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "browser_url_policy_lock_error",
            message: error.to_string(),
        })
}

fn lock_memory_facade(state: &AppState) -> Result<MutexGuard<'_, MemoryFacade>, GatewayError> {
    state.memory_facade.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "memory_store_lock_error",
        message: error.to_string(),
    })
}

fn lock_capability_registry(
    state: &AppState,
) -> Result<MutexGuard<'_, CapabilityRegistryStore>, GatewayError> {
    state
        .capability_registry
        .lock()
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "capability_registry_lock_error",
            message: error.to_string(),
        })
}

fn lock_task_executor_status(
    state: &AppState,
) -> Result<MutexGuard<'_, TaskExecutorStatus>, GatewayError> {
    state
        .task_executor_status
        .lock()
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "task_executor_status_lock_error",
            message: error.to_string(),
        })
}

fn gateway_database_path() -> Result<PathBuf, std::io::Error> {
    if let Ok(path) = env::var("LOCAL_FIRST_DESKTOP_GATEWAY_DB") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        return Ok(path);
    }

    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant");
    fs::create_dir_all(&base)?;
    Ok(base.join("desktop-gateway.sqlite"))
}

fn gateway_task_database_path() -> Result<PathBuf, std::io::Error> {
    if let Ok(path) = env::var("LOCAL_FIRST_TASK_RUNTIME_DB") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        return Ok(path);
    }

    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant");
    fs::create_dir_all(&base)?;
    Ok(base.join("task-runtime.sqlite"))
}

fn gateway_local_computer_database_path() -> Result<PathBuf, std::io::Error> {
    if let Ok(path) = env::var("LOCAL_FIRST_LOCAL_COMPUTER_DB") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        return Ok(path);
    }

    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant");
    fs::create_dir_all(&base)?;
    Ok(base.join("local-computer-session.sqlite"))
}

fn gateway_browser_policy_database_path() -> Result<PathBuf, std::io::Error> {
    if let Ok(path) = env::var("LOCAL_FIRST_BROWSER_POLICY_DB") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        return Ok(path);
    }

    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant");
    fs::create_dir_all(&base)?;
    Ok(base.join("browser-url-policy.sqlite"))
}

fn gateway_memory_database_path() -> Result<PathBuf, std::io::Error> {
    if let Ok(path) = env::var("LOCAL_FIRST_MEMORY_DB") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        return Ok(path);
    }

    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant");
    fs::create_dir_all(&base)?;
    Ok(base.join("memory.sqlite"))
}

/// Directory for human-readable/editable memory wiki markdown pages.
fn gateway_memory_wiki_dir() -> Result<PathBuf, std::io::Error> {
    if let Ok(path) = env::var("LOCAL_FIRST_MEMORY_WIKI_DIR") {
        let path = PathBuf::from(path);
        fs::create_dir_all(&path)?;
        return Ok(path);
    }
    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant")
        .join("memory-wiki");
    fs::create_dir_all(&base)?;
    Ok(base)
}

fn gateway_capability_database_path() -> Result<PathBuf, std::io::Error> {
    if let Ok(path) = env::var("LOCAL_FIRST_CAPABILITY_REGISTRY_DB") {
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        return Ok(path);
    }

    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant");
    fs::create_dir_all(&base)?;
    Ok(base.join("capability-registry.sqlite"))
}

fn gateway_token() -> String {
    env::var("LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn gateway_data_dir() -> Result<PathBuf, std::io::Error> {
    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant");
    fs::create_dir_all(&base)?;
    Ok(base)
}

/// Resolves the gateway bearer token, deny-by-default. The gateway binds to
/// loopback and drives the browser/local computer, so it must never run with
/// auth disabled. Order: explicit env (set by the Electron shell) -> previously
/// persisted local token -> a freshly generated token stored 0600 so a
/// same-user client can read it but other-user/sandboxed processes cannot.
fn resolve_gateway_auth_token() -> Result<String, std::io::Error> {
    let from_env = gateway_token();
    if !from_env.is_empty() {
        return Ok(from_env);
    }

    let token_path = gateway_data_dir()?.join("desktop-gateway-token");
    if let Ok(existing) = fs::read_to_string(&token_path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }

    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    write_private_file(&token_path, token.as_bytes())?;
    eprintln!(
        "[gateway] no LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN set; generated a local token at {} (auth required)",
        token_path.display()
    );
    Ok(token)
}

/// Writes a file readable/writable only by the current user (0600 on Unix).
#[cfg(unix)]
fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    fs::write(path, bytes)
}

fn gateway_user_id() -> UserId {
    UserId::new(
        env::var("LOCAL_FIRST_USER_ID")
            .unwrap_or_else(|_| "local-user".to_string())
            .trim()
            .to_string(),
    )
}

/// Active workspace ("project") — the scoping unit for tasks, memory, and
/// capabilities. A project IS a workspace (isolated context), so selecting one
/// re-scopes everything through the three workspace_id helpers below, which all
/// read this. Process-global because the helpers are stateless free functions
/// called from ~25 sites; the select endpoint sets it.
static ACTIVE_WORKSPACE: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

fn active_workspace_id() -> String {
    if let Ok(guard) = ACTIVE_WORKSPACE.read() {
        if let Some(id) = guard.as_ref().filter(|id| !id.trim().is_empty()) {
            return id.clone();
        }
    }
    env::var("LOCAL_FIRST_WORKSPACE_ID")
        .unwrap_or_else(|_| "local-workspace".to_string())
        .trim()
        .to_string()
}

fn set_active_workspace(id: &str) {
    if let Ok(mut guard) = ACTIVE_WORKSPACE.write() {
        *guard = Some(id.trim().to_string());
    }
}

fn gateway_workspace_id() -> WorkspaceId {
    WorkspaceId::new(active_workspace_id())
}

fn gateway_memory_user_id() -> MemoryUserId {
    MemoryUserId::new(
        env::var("LOCAL_FIRST_USER_ID")
            .unwrap_or_else(|_| "local-user".to_string())
            .trim()
            .to_string(),
    )
}

fn gateway_memory_workspace_id() -> MemoryWorkspaceId {
    MemoryWorkspaceId::new(active_workspace_id())
}

fn gateway_capability_user_id() -> CapabilityUserId {
    CapabilityUserId::new(
        env::var("LOCAL_FIRST_USER_ID")
            .unwrap_or_else(|_| "local-user".to_string())
            .trim()
            .to_string(),
    )
}

fn gateway_capability_workspace_id() -> CapabilityWorkspaceId {
    CapabilityWorkspaceId::new(active_workspace_id())
}

// ---- P4.1 Projects = Workspaces ----------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceRecord {
    id: String,
    name: String,
    /// Project root folder: drives @ file search and generated-file output for
    /// every conversation in this project. None for the legacy default project.
    #[serde(default)]
    folder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspacesFile {
    active: String,
    workspaces: Vec<WorkspaceRecord>,
}

#[derive(Debug, Serialize)]
struct WorkspacesResponse {
    active_workspace_id: String,
    workspaces: Vec<WorkspaceRecord>,
}

#[derive(Debug, Deserialize)]
struct CreateWorkspaceRequest {
    name: String,
    /// Project folder (required): becomes the @ search root + output dir.
    #[serde(default)]
    folder: Option<String>,
}

fn gateway_workspaces_path() -> Result<PathBuf, std::io::Error> {
    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant");
    fs::create_dir_all(&base)?;
    Ok(base.join("workspaces.json"))
}

/// Loads the persisted workspaces, seeding a default ("project") from the
/// env/default id on first run so there is always at least one.
fn load_workspaces_file() -> WorkspacesFile {
    let default_id = env::var("LOCAL_FIRST_WORKSPACE_ID")
        .unwrap_or_else(|_| "local-workspace".to_string())
        .trim()
        .to_string();
    gateway_workspaces_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<WorkspacesFile>(&raw).ok())
        .filter(|file| !file.workspaces.is_empty())
        .unwrap_or_else(|| WorkspacesFile {
            active: default_id.clone(),
            workspaces: vec![WorkspaceRecord {
                id: default_id,
                name: "Predefinito".to_string(),
                folder: None,
            }],
        })
}

/// The active project's root folder, if one is set.
fn active_workspace_folder() -> Option<String> {
    let active = active_workspace_id();
    load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id == active)
        .and_then(|w| w.folder)
        .filter(|f| !f.trim().is_empty())
}

fn save_workspaces_file(file: &WorkspacesFile) -> Result<(), std::io::Error> {
    let path = gateway_workspaces_path()?;
    let body = serde_json::to_string_pretty(file).unwrap_or_else(|_| "{}".to_string());
    fs::write(path, body)
}

/// Sets the in-process active workspace from the persisted selection at startup.
fn init_active_workspace_from_disk() {
    set_active_workspace(&load_workspaces_file().active);
}

/// 32-byte local key for at-rest secret encryption, generated once into a 0600
/// file. Connection API keys are encrypted with this; only `secret_ref`s live in
/// the registry DB (ADR 0009 / memory design: never plaintext in the DB).
fn gateway_secret_key_seed() -> Result<[u8; 32], std::io::Error> {
    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant");
    fs::create_dir_all(&base)?;
    let path = base.join("secret-key");
    if let Ok(bytes) = fs::read(&path) {
        if bytes.len() == 32 {
            let mut seed = [0u8; 32];
            seed.copy_from_slice(&bytes);
            return Ok(seed);
        }
    }
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    write_private_file(&path, &seed)?;
    Ok(seed)
}

fn open_gateway_secret_store()
-> Result<EncryptedFileSecretStore<DevelopmentSecretKeyProvider>, std::io::Error> {
    let seed = gateway_secret_key_seed()?;
    let base = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
        .join(".local-first-personal-assistant");
    fs::create_dir_all(&base)?;
    EncryptedFileSecretStore::open(base.join("secrets.json"), DevelopmentSecretKeyProvider::new(seed))
        .map_err(|error| std::io::Error::other(error.to_string()))
}

async fn workspaces_list() -> Json<WorkspacesResponse> {
    let file = load_workspaces_file();
    Json(WorkspacesResponse {
        active_workspace_id: file.active,
        workspaces: file.workspaces,
    })
}

async fn create_workspace(
    Json(request): Json<CreateWorkspaceRequest>,
) -> Result<Json<WorkspacesResponse>, GatewayError> {
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "workspace_name_required",
            message: "workspace name must not be empty".to_string(),
        });
    }
    let folder = request.folder.as_ref().map(|f| f.trim()).filter(|f| !f.is_empty());
    let Some(folder) = folder else {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "workspace_folder_required",
            message: "Scegli una cartella per il progetto.".to_string(),
        });
    };
    if !PathBuf::from(folder).is_dir() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "workspace_folder_not_found",
            message: "La cartella del progetto non esiste.".to_string(),
        });
    }
    let mut file = load_workspaces_file();
    let id = format!("workspace_{}", uuid::Uuid::new_v4().simple());
    file.workspaces.push(WorkspaceRecord {
        id,
        name,
        folder: Some(folder.to_string()),
    });
    save_workspaces_file(&file).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspaces_write_failed",
        message: error.to_string(),
    })?;
    Ok(Json(WorkspacesResponse {
        active_workspace_id: file.active.clone(),
        workspaces: file.workspaces,
    }))
}

#[derive(Debug, Deserialize)]
struct SetWorkspaceFolderRequest {
    folder: String,
}

/// Sets (or changes) a project's folder — also for the legacy default project.
async fn set_workspace_folder(
    Path(workspace_id): Path<String>,
    Json(request): Json<SetWorkspaceFolderRequest>,
) -> Result<Json<WorkspacesResponse>, GatewayError> {
    let folder = request.folder.trim().to_string();
    if !folder.is_empty() && !PathBuf::from(&folder).is_dir() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "workspace_folder_not_found",
            message: "La cartella non esiste.".to_string(),
        });
    }
    let mut file = load_workspaces_file();
    let Some(workspace) = file.workspaces.iter_mut().find(|w| w.id == workspace_id) else {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "workspace_not_found",
            message: format!("workspace not found: {workspace_id}"),
        });
    };
    workspace.folder = if folder.is_empty() { None } else { Some(folder) };
    save_workspaces_file(&file).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspaces_write_failed",
        message: error.to_string(),
    })?;
    Ok(Json(WorkspacesResponse {
        active_workspace_id: file.active.clone(),
        workspaces: file.workspaces,
    }))
}

async fn select_workspace(
    Path(workspace_id): Path<String>,
) -> Result<Json<WorkspacesResponse>, GatewayError> {
    let mut file = load_workspaces_file();
    if !file.workspaces.iter().any(|workspace| workspace.id == workspace_id) {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "workspace_not_found",
            message: format!("workspace not found: {workspace_id}"),
        });
    }
    file.active = workspace_id.clone();
    save_workspaces_file(&file).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspaces_write_failed",
        message: error.to_string(),
    })?;
    set_active_workspace(&workspace_id);
    Ok(Json(WorkspacesResponse {
        active_workspace_id: file.active.clone(),
        workspaces: file.workspaces,
    }))
}

fn gateway_memory_access_request() -> MemoryAccessRequest {
    MemoryAccessRequest {
        actor_id: "desktop-ui".to_string(),
        user_id: gateway_memory_user_id(),
        workspace_id: gateway_memory_workspace_id(),
        purpose: "desktop_memory_dashboard".to_string(),
        allowed_domains: vec![
            PrivacyDomain::new("local"),
            PrivacyDomain::new("personal"),
            PrivacyDomain::new("work"),
            PrivacyDomain::new("browser"),
        ],
        max_sensitivity: MemoryDataSensitivity::Private,
        allow_raw_payload: false,
        allow_export: false,
        broad_query: true,
    }
}

fn cors_layer() -> CorsLayer {
    let mut origins = vec![
        HeaderValue::from_static("http://127.0.0.1:1420"),
        HeaderValue::from_static("http://localhost:1420"),
        HeaderValue::from_static("http://127.0.0.1:1421"),
        HeaderValue::from_static("http://localhost:1421"),
        HeaderValue::from_static("null"),
    ];
    if let Ok(origin) = env::var("LOCAL_FIRST_DESKTOP_ALLOWED_ORIGIN") {
        if let Ok(header) = HeaderValue::from_str(origin.trim()) {
            origins.push(header);
        }
    }

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([CONTENT_TYPE, AUTHORIZATION])
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        adapt_skill_body,
        extract_source_urls,
        fonti_section,
        skill_id_from_command,
        browser_method_for_capability_tool,
        browser_targets_for_goal,
        browser_url_for_goal,
        evaluate_simple_arithmetic,
        redact_sensitive_text,
        task_effective_goal,
        task_execution_outcome_from_executor_result,
        task_goal_summary,
        aggregate_session_state_from_counts,
        brain_budgets_for_context_window,
        browser_error_indicates_dead_sidecar,
        capability_call_completed_outcome,
        collect_member_counts,
        composio_tool_is_read,
        resolve_active_model,
        rewrite_confirm_to_done,
        search_composio_catalog,
        ActiveModelInputs,
        default_browser_headless_value,
        resolve_contained_computer_cdp,
        resolve_contained_computer_novnc,
        mcp_stdio_config_from_metadata,
        mcp_stdio_config_to_metadata,
        mcp_provider_slug,
        sanitize_wiki_filename,
        task_queue_response,
        wiki_title_from_text,
    };
    use local_first_capabilities::{CapabilityCallResult, ProviderId as CapProviderId};
    use crate::chat_store::ChatStore;
    use local_first_browser_automation::BrowserAutomationError;
    use local_first_local_computer_session::SessionStatus;
    use local_first_browser_automation::BrowserMethod;
    use local_first_task_runtime::{
        ApprovalRequest, ExecutorResult, ResourceClass, TaskId, TaskPriority, TaskQueueSnapshot,
        TaskRecord, TaskStatus, TaskStore, TaskUiItem, UserId, WorkspaceId,
    };
    use std::collections::HashMap;

    #[test]
    fn adapt_skill_body_substitutes_base_dir() {
        let body = "Run `python3 {baseDir}/scripts/x.py` and ${baseDir}/a";
        let out = adapt_skill_body(body, "weather");
        assert!(out.contains("/home/agent/skills/weather/scripts/x.py"));
        assert!(!out.contains("{baseDir}"));
        assert!(!out.contains("${baseDir}"));
    }

    #[test]
    fn extract_source_urls_finds_and_trims() {
        let text = "Vedi https://example.com/a, e (https://kayak.it/flights). Fine.";
        let urls = extract_source_urls(text);
        assert!(urls.contains(&"https://example.com/a".to_string()));
        assert!(urls.contains(&"https://kayak.it/flights".to_string()));
    }

    #[test]
    fn fonti_section_skips_when_already_cited() {
        let sources = vec!["https://example.com".to_string()];
        assert!(fonti_section(&sources, "Risposta\n\n**Fonti**\n- x").is_none());
        assert!(fonti_section(&[], "Risposta").is_none());
        assert!(fonti_section(&sources, "Risposta").is_some());
    }

    #[test]
    fn skill_id_from_command_extracts_id() {
        assert_eq!(
            skill_id_from_command("python3 /home/agent/skills/polymarket-trade/scripts/p.py search btc"),
            Some("polymarket-trade".to_string())
        );
        assert_eq!(skill_id_from_command("ls -la"), None);
        assert_eq!(skill_id_from_command("cat /home/agent/skills/"), None);
    }

    #[test]
    fn aggregate_session_state_reflects_member_progress() {
        // No member terminal yet -> session stays Running at 0 completed.
        assert_eq!(
            aggregate_session_state_from_counts(5, 0, 0, false, false),
            (SessionStatus::Running, 0)
        );
        // Some done, others still running -> Running, progress = completed.
        assert_eq!(
            aggregate_session_state_from_counts(5, 2, 2, false, false),
            (SessionStatus::Running, 2)
        );
        // All members completed -> Completed at full progress.
        assert_eq!(
            aggregate_session_state_from_counts(5, 5, 5, false, false),
            (SessionStatus::Completed, 5)
        );
        // All terminal but one failed -> Failed (progress counts completed only).
        assert_eq!(
            aggregate_session_state_from_counts(5, 4, 5, true, false),
            (SessionStatus::Failed, 4)
        );
        // Any member awaiting approval wins regardless of the rest.
        assert_eq!(
            aggregate_session_state_from_counts(5, 1, 1, false, true),
            (SessionStatus::WaitingUser, 1)
        );
    }

    #[test]
    fn wiki_title_and_filename_helpers_are_safe() {
        // Title = first non-empty line, length-bounded with an ellipsis.
        assert_eq!(wiki_title_from_text("\n  Prenota treno  \naltro"), "Prenota treno");
        let long = "x".repeat(100);
        let title = wiki_title_from_text(&long);
        assert!(title.chars().count() <= 60 && title.ends_with('…'));
        // Filename keeps only alphanumerics (refs can carry ':' and '/').
        assert_eq!(sanitize_wiki_filename("mem:abc/12-3"), "mem-abc-12-3");
    }

    #[test]
    fn mcp_stdio_config_parses_command_args_env() {
        let config = mcp_stdio_config_from_metadata(&serde_json::json!({
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            "env": { "FOO": "bar" }
        }))
        .unwrap();
        assert_eq!(config.command, "npx");
        assert_eq!(config.args.len(), 3);
        assert_eq!(config.env, vec![("FOO".to_string(), "bar".to_string())]);

        // Missing command is a hard error (cannot spawn a server).
        assert!(mcp_stdio_config_from_metadata(&serde_json::json!({})).is_err());
    }

    #[test]
    fn capability_completed_outcome_keeps_raw_output_out_of_redacted_and_chat() {
        let task = TaskRecord::new(
            "t1",
            UserId::new("u"),
            WorkspaceId::new("w"),
            "capability.fs.read_file",
            "read a file",
            serde_json::json!({}),
        );
        let result = CapabilityCallResult {
            provider_id: CapProviderId::new("fs"),
            tool_name: "fs.read_file".to_string(),
            output: serde_json::json!({ "contents": "SECRET-CONTENTS" }),
        };
        let outcome = capability_call_completed_outcome(&task, &result);
        assert!(outcome.completed);
        // Raw output is preserved in the audited checkpoint...
        assert_eq!(outcome.checkpoint_payload["output"]["contents"], "SECRET-CONTENTS");
        // ...but never leaks into the redacted checkpoint or the chat message.
        assert!(outcome.checkpoint_redacted.get("output").is_none());
        assert!(!outcome.chat_message.contains("SECRET-CONTENTS"));
        assert!(outcome.chat_message.contains("fs.read_file"));
    }

    #[test]
    fn budgets_scale_with_model_context_window() {
        // Small / unknown model -> keep the cheap gemma4-era defaults.
        let small = brain_budgets_for_context_window(Some(8_192));
        assert_eq!(small.max_planner_tokens, 768);
        assert_eq!(small.max_memory_context_chars, 2_000);
        let unknown = brain_budgets_for_context_window(None);
        assert_eq!(unknown.max_planner_tokens, 768);

        // Capable big-context model -> generous planner budget and unlimited
        // (0 = passthrough) context so promptjuice never clamps essential text.
        let capable = brain_budgets_for_context_window(Some(200_000));
        assert_eq!(capable.max_planner_tokens, 8_000);
        assert_eq!(capable.max_conversation_summary_chars, 0);
        assert_eq!(capable.max_memory_context_chars, 0);
        assert_eq!(capable.max_tool_cards_context_chars, 0);
        assert_eq!(capable.max_loaded_tool_context_chars, 0);
        assert!(capable.max_loaded_tools > small.max_loaded_tools);
    }

    #[test]
    fn normalize_browser_call_manages_tab_for_planner_steps() {
        use super::{
        BROWSER_MANAGED_TARGET,
        normalize_browser_call,
    };
        use local_first_browser_automation::BrowserMethod;

        // navigate {url} with no target -> idempotent open of the managed tab.
        let (method, params) = normalize_browser_call(
            BrowserMethod::Navigate,
            serde_json::json!({"url": "https://www.trenitalia.com"}),
        );
        assert_eq!(method, BrowserMethod::Open);
        assert_eq!(params["url"], "https://www.trenitalia.com");
        assert_eq!(params["label"], BROWSER_MANAGED_TARGET);

        // act with no target -> target injected, payload preserved.
        let (method, params) = normalize_browser_call(
            BrowserMethod::Act,
            serde_json::json!({"actions": [{"type": "click", "selector": "x"}]}),
        );
        assert_eq!(method, BrowserMethod::Act);
        assert_eq!(params["target_id"], BROWSER_MANAGED_TARGET);
        assert!(params["actions"].is_array());

        // an explicit target_id is never overridden.
        let (method, params) = normalize_browser_call(
            BrowserMethod::Snapshot,
            serde_json::json!({"target_id": "t7"}),
        );
        assert_eq!(method, BrowserMethod::Snapshot);
        assert_eq!(params["target_id"], "t7");

        // tabless calls pass through untouched.
        let (method, params) =
            normalize_browser_call(BrowserMethod::Tabs, serde_json::json!({}));
        assert_eq!(method, BrowserMethod::Tabs);
        assert!(params.get("target_id").is_none());
    }

    #[test]
    fn dead_sidecar_errors_trigger_respawn_others_do_not() {
        // Broken pipe / garbled reply -> the single persistent sidecar is gone.
        assert!(browser_error_indicates_dead_sidecar(
            &BrowserAutomationError::Sidecar("broken pipe".into())
        ));
        assert!(browser_error_indicates_dead_sidecar(
            &BrowserAutomationError::InvalidResponse("EOF".into())
        ));
        // Our own bug or legitimate per-call policy errors must NOT drop the
        // shared client (the process is still alive and healthy).
        assert!(!browser_error_indicates_dead_sidecar(
            &BrowserAutomationError::InvalidRequest("bad params".into())
        ));
        assert!(!browser_error_indicates_dead_sidecar(
            &BrowserAutomationError::NavigationBlocked("blocked".into())
        ));
        assert!(!browser_error_indicates_dead_sidecar(
            &BrowserAutomationError::PrivateNetworkBlocked("ssrf".into())
        ));
    }

    #[test]
    fn member_counts_read_real_task_statuses_and_drive_aggregate_state() {
        // A1.2 integration: exercise the actual store-reading path the worker
        // uses — link N member tasks to a thread, persist them with mixed
        // statuses in a real (in-memory) TaskStore, and confirm the aggregate
        // session state matches.
        let user = UserId::new("local-user");
        let workspace = WorkspaceId::new("local-workspace");
        let chat = ChatStore::in_memory().unwrap();
        let thread = chat.create_thread("default").unwrap();
        let tasks = TaskStore::open_in_memory().unwrap();

        // Three Brain-materialized member tasks for this thread.
        let members = ["orch_s1", "orch_s2", "orch_s3"];
        for id in members {
            chat.link_task_to_thread(id, &thread.thread_id).unwrap();
            tasks
                .insert_task(&TaskRecord::new(
                    id,
                    user.clone(),
                    workspace.clone(),
                    "capability.browser.navigate",
                    "step",
                    serde_json::json!({}),
                ))
                .unwrap();
        }

        let member_ids = chat.member_task_ids_for_thread(&thread.thread_id).unwrap();
        assert_eq!(member_ids.len(), 3);

        // All queued -> no terminal members -> session still Running at 0.
        let counts = collect_member_counts(&tasks, &member_ids, &user, &workspace).unwrap();
        assert_eq!(
            aggregate_session_state_from_counts(
                member_ids.len(),
                counts.completed,
                counts.terminal,
                counts.any_failed,
                counts.any_waiting_user,
            ),
            (SessionStatus::Running, 0)
        );

        // One completes -> Running, progress 1.
        tasks
            .update_task_status(&TaskId::new("orch_s1"), &user, &workspace, TaskStatus::Completed, None)
            .unwrap();
        let counts = collect_member_counts(&tasks, &member_ids, &user, &workspace).unwrap();
        assert_eq!(
            aggregate_session_state_from_counts(
                member_ids.len(),
                counts.completed,
                counts.terminal,
                counts.any_failed,
                counts.any_waiting_user,
            ),
            (SessionStatus::Running, 1)
        );

        // Remaining complete + one fails -> all terminal with a failure -> Failed.
        tasks
            .update_task_status(&TaskId::new("orch_s2"), &user, &workspace, TaskStatus::Completed, None)
            .unwrap();
        tasks
            .update_task_status(
                &TaskId::new("orch_s3"),
                &user,
                &workspace,
                TaskStatus::Failed,
                Some("boom"),
            )
            .unwrap();
        let counts = collect_member_counts(&tasks, &member_ids, &user, &workspace).unwrap();
        assert_eq!(
            aggregate_session_state_from_counts(
                member_ids.len(),
                counts.completed,
                counts.terminal,
                counts.any_failed,
                counts.any_waiting_user,
            ),
            (SessionStatus::Failed, 2)
        );
    }

    #[test]
    fn runtime_log_redaction_hides_tokens() {
        assert_eq!(
            redact_sensitive_text("Authorization: Bearer secret-token next"),
            "Authorization:[REDACTED]"
        );
    }

    #[test]
    fn runtime_log_redaction_strips_terminal_control_sequences() {
        assert_eq!(
            redact_sensitive_text("\u{1b}[2m  - navigating\u{1b}[22m\nok"),
            "  - navigating\nok"
        );
    }

    #[test]
    fn task_queue_response_serializes_ui_read_model_for_renderer() {
        let user = UserId::new("local-user");
        let workspace = WorkspaceId::new("local-workspace");
        let mut resource_usage = HashMap::new();
        resource_usage.insert(ResourceClass::LlmInference, 1);
        let response = task_queue_response(TaskQueueSnapshot {
            queued: vec![TaskUiItem {
                task_id: TaskId::new("task-1"),
                kind: "browser_automation".to_string(),
                goal: "Find train options".to_string(),
                status: TaskStatus::Queued,
                priority: TaskPriority::High,
                blocked_reason: None,
            }],
            active: Vec::new(),
            blocked: Vec::new(),
            waiting_approvals: vec![ApprovalRequest::new(
                "approval-1",
                TaskId::new("task-2"),
                user,
                workspace,
                "book train",
                "high",
                "browser",
                "Purchase requires confirmation",
            )],
            recent_failures: Vec::new(),
            resource_usage,
        })
        .unwrap();

        assert_eq!(response.queued[0].task_id, "task-1");
        assert_eq!(response.queued[0].status, "queued");
        assert_eq!(response.queued[0].priority, "high");
        assert_eq!(response.waiting_approvals[0].status, "pending");
        assert_eq!(response.resource_usage[0].resource_class, "llm_inference");
    }

    #[test]
    fn task_goal_summary_redacts_and_compacts_prompt() {
        let summary = task_goal_summary(
            "cerca documenti con token=super-secret e poi mostrami le opzioni principali disponibili",
        );

        assert!(summary.contains("token=[REDACTED]"));
        assert!(!summary.contains("super-secret"));
        assert!(summary.chars().count() <= 44);
    }

    #[test]
    fn local_executor_understands_simple_arithmetic() {
        assert_eq!(
            evaluate_simple_arithmetic("quanto fa 6*3?"),
            Some("18".to_string())
        );
        assert_eq!(evaluate_simple_arithmetic("12 / 4"), Some("3".to_string()));
        assert_eq!(evaluate_simple_arithmetic("ciao"), None);
    }

    #[test]
    fn browser_executor_uses_read_only_search_urls() {
        // De-gemma: the web-search URL is the goal verbatim — no hardcoded
        // "Trenitalia Italo" augmentation biasing every query toward trains.
        let url = browser_url_for_goal("Devo prenotare un treno Napoli Milano il 10 giugno");
        assert!(url.starts_with("https://duckduckgo.com/?q="));
        assert!(url.to_lowercase().contains("treno"));
        assert!(!url.contains("Trenitalia+Italo+orari"));
    }

    #[test]
    fn browser_path_is_general_with_no_train_specialization() {
        // The train path is removed (user directive): EVERY goal — flights,
        // trains, anything — gets ONE generic web-search target, and there is no
        // train-search draft. The model decides where to go; no keyword/site
        // routing hijacks the intent (this is the bug where "voli Milano-Napoli"
        // returned trains).
        for goal in [
            "Cerca voli da Milano a Napoli per il 10 giugno",
            "Devo prenotare un treno Napoli Milano il 10 giugno",
            "trova un ristorante a Roma",
        ] {
            let targets = browser_targets_for_goal(goal);
            assert_eq!(targets.len(), 1, "goal: {goal}");
            assert_eq!(targets[0].label, "Ricerca web", "goal: {goal}");
            assert!(
                targets[0].url.starts_with("https://duckduckgo.com/?q="),
                "goal: {goal}"
            );
        }
    }

    #[test]
    fn capability_browser_tool_names_resolve_to_browser_methods() {
        assert_eq!(
            browser_method_for_capability_tool("browser.open"),
            Some(BrowserMethod::Open)
        );
        assert_eq!(
            browser_method_for_capability_tool("browser.act"),
            Some(BrowserMethod::Act)
        );
        assert_eq!(browser_method_for_capability_tool("github.search"), None);
    }

    #[test]
    fn executor_needs_approval_is_not_treated_as_generic_block() {
        let task = TaskRecord::new(
            "task_approval",
            UserId::new("user"),
            WorkspaceId::new("workspace"),
            "capability.browser.browser.act",
            "Click a protected browser control",
            serde_json::json!({}),
        );

        let outcome = task_execution_outcome_from_executor_result(
            &task,
            "browser-capability-executor",
            "browser.act",
            ExecutorResult::NeedsApproval {
                action: "browser.manual_action".to_string(),
                risk_level: "medium".to_string(),
                data_boundary: "local_browser".to_string(),
                explanation: "Manual confirmation required".to_string(),
            },
        )
        .unwrap();

        let pending = outcome
            .pending_approval
            .as_ref()
            .expect("executor approval should be preserved");
        assert!(!outcome.completed);
        assert_eq!(pending.action, "browser.manual_action");
        assert_eq!(pending.data_boundary, "local_browser");
        assert_eq!(
            outcome.checkpoint_payload["kind"],
            "executor_needs_approval"
        );
    }

    #[test]
    fn task_effective_goal_uses_redacted_prompt_for_execution() {
        let task = TaskRecord::new(
            "task_1",
            UserId::new("user"),
            WorkspaceId::new("workspace"),
            "browser_task",
            "Devo prenotare un treno Napoli Milano il ...",
            serde_json::json!({
                "prompt_redacted": "Cerca voli Napoli Milano il 10 giugno, trova opzioni ma non acquistare nulla"
            }),
        );

        // task_effective_goal prefers the redacted prompt over the truncated goal.
        let effective = task_effective_goal(&task);
        assert!(effective.contains("voli"));
        assert!(effective.contains("10 giugno"));
        assert!(effective.contains("non acquistare"));
    }

    fn model_inputs(backend: &str) -> ActiveModelInputs {
        ActiveModelInputs {
            backend: backend.to_string(),
            model: None,
            cloud_flag: false,
            context_window: None,
            has_api_key: false,
        }
    }

    #[test]
    fn active_model_anthropic_with_key_is_capable_cloud() {
        let info = resolve_active_model(&ActiveModelInputs {
            has_api_key: true,
            ..model_inputs("anthropic")
        });
        assert_eq!(info.backend, "anthropic");
        assert_eq!(info.locality, "cloud");
        assert!(info.capable);
        assert!(!info.missing_api_key);
        assert_eq!(info.model, "claude-sonnet-4-6");
        assert_eq!(info.context_window, 200_000);
    }

    #[test]
    fn active_model_anthropic_without_key_resolves_to_openai_compat() {
        // No MLX fallback any more: anthropic-without-key resolves to the
        // OpenAI-compatible provider, same as build_browser_inference_router.
        let info = resolve_active_model(&model_inputs("anthropic"));
        assert_eq!(info.backend, "openai-compat");
        assert!(info.capable);
    }

    #[test]
    fn active_model_openai_cloud_without_key_is_capable_but_flags_missing() {
        let info = resolve_active_model(&ActiveModelInputs {
            cloud_flag: true,
            model: Some("minimax-m2.7".to_string()),
            ..model_inputs("openai")
        });
        assert_eq!(info.backend, "openai-compat");
        assert_eq!(info.locality, "cloud");
        assert_eq!(info.model, "minimax-m2.7");
        assert!(info.capable);
        // Cloud endpoint + no key → chat silently falls back; surface the warning.
        assert!(info.missing_api_key);
    }

    #[test]
    fn active_model_openai_local_keyless_is_not_flagged() {
        // A local OpenAI-compatible endpoint (e.g. Ollama) needs no key.
        let info = resolve_active_model(&ActiveModelInputs {
            cloud_flag: false,
            ..model_inputs("openai")
        });
        assert_eq!(info.backend, "openai-compat");
        assert_eq!(info.locality, "local");
        assert!(!info.missing_api_key);
    }

    #[test]
    fn active_model_default_and_unknown_backends_resolve_to_openai_compat() {
        // Empty/unknown backend → the OpenAI-compatible provider (local unless
        // flagged cloud). No mistralrs/MLX branch exists in the router.
        for backend in ["", "mistralrs", "mlx", "something-else"] {
            let info = resolve_active_model(&model_inputs(backend));
            assert_eq!(info.backend, "openai-compat", "backend: {backend}");
            assert!(info.capable, "backend: {backend}");
            assert_eq!(info.locality, "local", "backend: {backend}");
            assert_eq!(info.model, "gpt-4o-mini", "backend: {backend}");
        }
    }

    #[test]
    fn mcp_metadata_round_trips_between_connect_and_executor() {
        // The contract: what mcp/connect writes (to_metadata) MUST be exactly
        // what the executor reads (from_metadata). A mismatch here = a connected
        // MCP server the executor can't launch.
        let original = local_first_capabilities::McpStdioConfig {
            command: "npx".to_string(),
            args: vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-filesystem".to_string(),
                "/tmp".to_string(),
            ],
            env: vec![
                ("API_TOKEN".to_string(), "abc123".to_string()),
                ("MODE".to_string(), "ro".to_string()),
            ],
        };

        let metadata = mcp_stdio_config_to_metadata(&original);
        let restored =
            mcp_stdio_config_from_metadata(&metadata).expect("metadata should parse back");

        assert_eq!(restored.command, original.command);
        assert_eq!(restored.args, original.args);
        // env order is not significant (serde object → map); compare as sets.
        let mut a = original.env.clone();
        let mut b = restored.env.clone();
        a.sort();
        b.sort();
        assert_eq!(a, b);
    }

    #[test]
    fn mcp_metadata_round_trips_with_empty_args_and_env() {
        let original = local_first_capabilities::McpStdioConfig {
            command: "my-server".to_string(),
            args: vec![],
            env: vec![],
        };
        let restored = mcp_stdio_config_from_metadata(&mcp_stdio_config_to_metadata(&original))
            .expect("empty config should parse back");
        assert_eq!(restored.command, "my-server");
        assert!(restored.args.is_empty());
        assert!(restored.env.is_empty());
    }

    #[test]
    fn contained_computer_cdp_resolves_from_config() {
        // Off by default → use the on-host browser.
        assert_eq!(resolve_contained_computer_cdp(None, None), None);
        assert_eq!(resolve_contained_computer_cdp(None, Some("0")), None);
        assert_eq!(resolve_contained_computer_cdp(Some("   "), Some("false")), None);
        // Flag enables the default local endpoint.
        assert_eq!(
            resolve_contained_computer_cdp(None, Some("1")),
            Some("http://127.0.0.1:9222".to_string())
        );
        assert_eq!(
            resolve_contained_computer_cdp(None, Some("true")),
            Some("http://127.0.0.1:9222".to_string())
        );
        // Explicit endpoint wins over the flag.
        assert_eq!(
            resolve_contained_computer_cdp(Some("http://10.0.0.5:9333"), Some("0")),
            Some("http://10.0.0.5:9333".to_string())
        );
    }

    #[test]
    fn contained_computer_novnc_resolves_when_enabled() {
        assert_eq!(resolve_contained_computer_novnc(false, None), None);
        assert_eq!(
            resolve_contained_computer_novnc(true, None),
            Some("http://127.0.0.1:6080/vnc.html".to_string())
        );
        assert_eq!(
            resolve_contained_computer_novnc(true, Some("http://10.0.0.5:6080/vnc.html")),
            Some("http://10.0.0.5:6080/vnc.html".to_string())
        );
        // Blank explicit falls back to the default.
        assert_eq!(
            resolve_contained_computer_novnc(true, Some("  ")),
            Some("http://127.0.0.1:6080/vnc.html".to_string())
        );
    }

    #[test]
    fn browser_is_headless_by_default() {
        // Phase 1: the automated browser must not open a focus-stealing OS
        // window by default; visibility comes from the in-chat live view.
        assert_eq!(default_browser_headless_value(), "1");
    }

    #[test]
    fn mcp_provider_slug_sanitizes_names() {
        assert_eq!(mcp_provider_slug("GitHub MCP"), "github-mcp");
        assert_eq!(mcp_provider_slug("  Filesystem!! "), "filesystem");
        assert_eq!(mcp_provider_slug("a/b\\c"), "a-b-c");
        assert_eq!(mcp_provider_slug("Wiki (local)"), "wiki-local");
        // Never empty, even for all-punctuation input.
        assert_eq!(mcp_provider_slug("***"), "server");
        assert_eq!(mcp_provider_slug(""), "server");
    }

    fn catalog_entry(slug: &str, desc: &str) -> (String, String, serde_json::Value) {
        (
            slug.to_string(),
            format!("{slug} {desc}").to_lowercase(),
            serde_json::json!({ "type": "function", "function": { "name": slug, "description": desc } }),
        )
    }

    #[test]
    fn discovery_search_ranks_relevant_tools_first() {
        let index = vec![
            catalog_entry("GMAIL_FETCH_EMAILS", "Fetch a list of email messages from Gmail"),
            catalog_entry("GMAIL_SEND_EMAIL", "Send an email message via Gmail"),
            catalog_entry("GOOGLECALENDAR_EVENTS_LIST", "List calendar events in a time range"),
        ];
        let hits = search_composio_catalog(&index, "unread emails", 5);
        assert_eq!(hits.first().map(|(s, _)| s.as_str()), Some("GMAIL_FETCH_EMAILS"));
        // Calendar tool has no overlap with "email" tokens → excluded.
        assert!(hits.iter().all(|(s, _)| s.starts_with("GMAIL")));

        let cal = search_composio_catalog(&index, "calendar events", 5);
        assert_eq!(cal.first().map(|(s, _)| s.as_str()), Some("GOOGLECALENDAR_EVENTS_LIST"));

        // Empty query is a harmless browse (returns up to k), never panics.
        assert!(!search_composio_catalog(&index, "", 2).is_empty());
    }

    #[test]
    fn rewrite_confirm_marker_to_done() {
        let original = "Ok.\n\nServe la tua conferma per l'azione qui sotto.\n‹‹COMPOSIO_CONFIRM››{\"tool\":\"GMAIL_SEND_EMAIL\",\"arguments\":{}}‹‹/COMPOSIO_CONFIRM››\n";
        let done = rewrite_confirm_to_done(original, "GMAIL_SEND_EMAIL");
        assert!(done.contains("‹‹COMPOSIO_DONE››GMAIL_SEND_EMAIL‹‹/COMPOSIO_DONE››"));
        assert!(!done.contains("COMPOSIO_CONFIRM"));
        assert!(!done.contains("Serve la tua conferma"));
        assert!(done.starts_with("Ok."));
        // Idempotent when there is no confirm marker.
        assert_eq!(rewrite_confirm_to_done("plain", "X"), "plain");
    }

    #[test]
    fn composio_tool_read_write_classification() {
        assert!(composio_tool_is_read("GMAIL_FETCH_EMAILS"));
        assert!(composio_tool_is_read("GOOGLECALENDAR_EVENTS_LIST"));
        assert!(!composio_tool_is_read("GMAIL_SEND_EMAIL"));
        assert!(!composio_tool_is_read("GMAIL_DELETE_MESSAGE"));
        assert!(!composio_tool_is_read("GOOGLECALENDAR_CREATE_EVENT"));
    }
}
