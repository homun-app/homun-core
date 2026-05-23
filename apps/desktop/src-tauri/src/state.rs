use crate::models::{
    BridgeStatus, CapabilityPolicySummary, CapabilitySnapshot, DesktopTaskDetail,
    DesktopTaskQueueSnapshot, RuntimeHealthSnapshot, RuntimeProcessItem,
    capability_connection_item, capability_tool_item, component, desktop_task_detail,
    desktop_task_queue, runtime_process_item, runtime_process_item_with_snapshot,
};
use crate::seed::{seed_capabilities, seed_memories, seed_tasks};
use local_first_capabilities::{
    CapabilityRegistryStore, ProviderId, UserId as CapabilityUserId,
    WorkspaceId as CapabilityWorkspaceId,
};
use local_first_local_computer_session::{
    ArtifactCreate, ComputerEventCreate, ComputerSessionCreate, ComputerSessionSnapshot,
    LocalComputerSessionManager, LocalComputerSessionStore, SurfaceKind,
};
use local_first_memory::{
    DataSensitivity, MemoryAccessRequest, MemoryDashboard, MemoryFacade, MemoryUiReadModel,
    PrivacyDomain, SQLiteMemoryStore, UserId as MemoryUserId, WorkspaceId as MemoryWorkspaceId,
};
use local_first_process_manager::{
    LocalProcessSupervisor, ProcessManager, ProcessRegistryStore, SidecarProcessCatalog,
};
use local_first_task_runtime::{
    TaskStore, TaskUiReadModel, UserId as TaskUserId, WorkspaceId as TaskWorkspaceId,
};
use std::path::PathBuf;
use std::sync::Mutex;

pub(crate) const DEFAULT_USER_ID: &str = "local-user";
pub(crate) const DEFAULT_WORKSPACE_ID: &str = "local-workspace";

pub struct DesktopCoreState {
    user_id: String,
    workspace_id: String,
    process_ids: Vec<String>,
    capability_provider_ids: Vec<String>,
    task_store: Mutex<TaskStore>,
    memory_facade: Mutex<MemoryFacade>,
    process_manager: Mutex<ProcessManager<LocalProcessSupervisor>>,
    capability_store: Mutex<CapabilityRegistryStore>,
    local_computer: Mutex<LocalComputerSessionManager>,
}

impl DesktopCoreState {
    pub fn seeded(workspace_root: PathBuf) -> Result<Self, String> {
        let task_store = TaskStore::open_in_memory().map_err(to_string_error)?;
        seed_tasks(&task_store).map_err(to_string_error)?;

        let memory_facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory()?);
        seed_memories(&memory_facade)?;

        let process_store = ProcessRegistryStore::open_in_memory().map_err(to_string_error)?;
        let sidecar_catalog = SidecarProcessCatalog::new(workspace_root);
        let process_manager = ProcessManager::new(process_store, LocalProcessSupervisor::new());
        process_manager
            .register(sidecar_catalog.gemma_runtime())
            .map_err(to_string_error)?;
        process_manager
            .register(sidecar_catalog.browser_sidecar())
            .map_err(to_string_error)?;

        let capability_store =
            CapabilityRegistryStore::open_in_memory().map_err(to_string_error)?;
        let capability_provider_ids = seed_capabilities(&capability_store)?;
        let local_computer =
            LocalComputerSessionManager::new(LocalComputerSessionStore::open_in_memory()?);
        seed_local_computer_session(&local_computer)?;

        Ok(Self {
            user_id: DEFAULT_USER_ID.to_string(),
            workspace_id: DEFAULT_WORKSPACE_ID.to_string(),
            process_ids: vec![
                "llm-gemma4-mlx".to_string(),
                "browser-automation".to_string(),
            ],
            capability_provider_ids,
            task_store: Mutex::new(task_store),
            memory_facade: Mutex::new(memory_facade),
            process_manager: Mutex::new(process_manager),
            capability_store: Mutex::new(capability_store),
            local_computer: Mutex::new(local_computer),
        })
    }

    pub fn bridge_status(&self) -> BridgeStatus {
        BridgeStatus {
            user_id: self.user_id.clone(),
            workspace_id: self.workspace_id.clone(),
            local_first: true,
            cloud_api_enabled: false,
            components: vec![
                component("memory", "Memory Core", "ready"),
                component("task-runtime", "Task Runtime", "ready"),
                component("process-manager", "Local Process Manager", "ready"),
                component("capabilities", "Capability Registry", "ready"),
                component(
                    "learning",
                    "Learning cablato dopo i componenti base",
                    "deferred",
                ),
            ],
        }
    }

    pub fn runtime_health_snapshot(&self) -> Result<RuntimeHealthSnapshot, String> {
        let manager = self
            .process_manager
            .lock()
            .map_err(|_| "process manager lock poisoned".to_string())?;
        let mut processes = Vec::new();
        for id in &self.process_ids {
            if let Some(detail) = manager.detail(id).map_err(to_string_error)? {
                processes.push(runtime_process_item(&detail)?);
            }
        }
        Ok(RuntimeHealthSnapshot { processes })
    }

    pub fn check_process_health(&self, process_id: &str) -> Result<RuntimeProcessItem, String> {
        let mut manager = self
            .process_manager
            .lock()
            .map_err(|_| "process manager lock poisoned".to_string())?;
        let snapshot = manager.check_health(process_id).map_err(to_string_error)?;
        let detail = manager
            .detail(process_id)
            .map_err(to_string_error)?
            .ok_or_else(|| format!("process not found: {process_id}"))?;
        runtime_process_item_with_snapshot(&detail, snapshot)
    }

    pub fn start_process(&self, process_id: &str) -> Result<RuntimeProcessItem, String> {
        let mut manager = self
            .process_manager
            .lock()
            .map_err(|_| "process manager lock poisoned".to_string())?;
        let snapshot = manager.start(process_id).map_err(to_string_error)?;
        let detail = manager
            .detail(process_id)
            .map_err(to_string_error)?
            .ok_or_else(|| format!("process not found: {process_id}"))?;
        runtime_process_item_with_snapshot(&detail, snapshot)
    }

    pub fn stop_process(&self, process_id: &str) -> Result<RuntimeProcessItem, String> {
        let mut manager = self
            .process_manager
            .lock()
            .map_err(|_| "process manager lock poisoned".to_string())?;
        let snapshot = manager.stop(process_id).map_err(to_string_error)?;
        let detail = manager
            .detail(process_id)
            .map_err(to_string_error)?
            .ok_or_else(|| format!("process not found: {process_id}"))?;
        runtime_process_item_with_snapshot(&detail, snapshot)
    }

    pub fn task_queue_snapshot(&self) -> Result<DesktopTaskQueueSnapshot, String> {
        let store = self
            .task_store
            .lock()
            .map_err(|_| "task store lock poisoned".to_string())?;
        let user_id = TaskUserId::new(&self.user_id);
        let workspace_id = TaskWorkspaceId::new(&self.workspace_id);
        let snapshot = TaskUiReadModel::new(&store)
            .queue_snapshot(&user_id, &workspace_id)
            .map_err(to_string_error)?;
        desktop_task_queue(snapshot)
    }

    pub fn task_detail(&self, task_id: &str) -> Result<Option<DesktopTaskDetail>, String> {
        let store = self
            .task_store
            .lock()
            .map_err(|_| "task store lock poisoned".to_string())?;
        let user_id = TaskUserId::new(&self.user_id);
        let workspace_id = TaskWorkspaceId::new(&self.workspace_id);
        let task_id = local_first_task_runtime::TaskId::new(task_id);
        TaskUiReadModel::new(&store)
            .task_detail(&task_id, &user_id, &workspace_id)
            .map_err(to_string_error)
            .map(|detail| detail.map(desktop_task_detail))
    }

    pub fn memory_dashboard_snapshot(&self) -> Result<MemoryDashboard, String> {
        let facade = self
            .memory_facade
            .lock()
            .map_err(|_| "memory facade lock poisoned".to_string())?;
        MemoryUiReadModel::new(&facade)
            .dashboard(&memory_access_request(&self.user_id, &self.workspace_id))
    }

    pub fn capability_snapshot(&self) -> Result<CapabilitySnapshot, String> {
        let store = self
            .capability_store
            .lock()
            .map_err(|_| "capability store lock poisoned".to_string())?;
        let user_id = CapabilityUserId::new(&self.user_id);
        let workspace_id = CapabilityWorkspaceId::new(&self.workspace_id);
        let connections = store
            .connection_configs(&user_id, &workspace_id)
            .map_err(to_string_error)?
            .into_iter()
            .map(capability_connection_item)
            .collect();
        let mut tools = Vec::new();
        for provider_id in &self.capability_provider_ids {
            tools.extend(
                store
                    .cached_tools(&ProviderId::new(provider_id))
                    .map_err(to_string_error)?
                    .into_iter()
                    .map(capability_tool_item),
            );
        }
        let policy_context = store
            .policy_context(&user_id, &workspace_id)
            .map_err(to_string_error)?;
        Ok(CapabilitySnapshot {
            connections,
            tools,
            policy: CapabilityPolicySummary {
                enabled_providers: policy_context
                    .enabled_providers
                    .iter()
                    .map(|provider| provider.as_str().to_string())
                    .collect(),
                allow_managed_cloud: policy_context.allow_managed_cloud,
                privacy_domains: policy_context.privacy_domains,
                max_autonomy_level: policy_context.max_autonomy_level,
            },
        })
    }

    pub fn local_computer_session_snapshot(
        &self,
        session_id: &str,
    ) -> Result<Option<ComputerSessionSnapshot>, String> {
        let manager = self
            .local_computer
            .lock()
            .map_err(|_| "local computer lock poisoned".to_string())?;
        manager
            .read_model()
            .snapshot(session_id, &self.user_id, &self.workspace_id)
    }
}

fn memory_access_request(user_id: &str, workspace_id: &str) -> MemoryAccessRequest {
    MemoryAccessRequest {
        actor_id: "desktop-ui".to_string(),
        user_id: MemoryUserId::new(user_id),
        workspace_id: MemoryWorkspaceId::new(workspace_id),
        purpose: "desktop memory dashboard".to_string(),
        allowed_domains: vec![
            PrivacyDomain::new("work"),
            PrivacyDomain::new("browser"),
            PrivacyDomain::new("personal"),
        ],
        max_sensitivity: DataSensitivity::Private,
        allow_raw_payload: false,
        allow_export: false,
        broad_query: false,
    }
}

fn to_string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn seed_local_computer_session(manager: &LocalComputerSessionManager) -> Result<(), String> {
    let session = manager.create_session(ComputerSessionCreate {
        session_id: "computer_train_search".to_string(),
        task_id: "task_browser_quote".to_string(),
        workflow_id: Some("workflow_trip_search".to_string()),
        user_id: DEFAULT_USER_ID.to_string(),
        workspace_id: DEFAULT_WORKSPACE_ID.to_string(),
        title: "Computer locale".to_string(),
        subtitle: "Ricerca treni con browser e verifica finale in shell".to_string(),
        risk_level: "medium".to_string(),
        progress_total: 4,
    })?;
    manager.start_surface(&session.session_id, SurfaceKind::Browser, "Browser locale")?;
    manager.append_event(ComputerEventCreate {
        session_id: session.session_id.clone(),
        surface: SurfaceKind::Browser,
        kind: "computer_action_started".to_string(),
        status: "running".to_string(),
        title: "Cercare tratte Napoli-Milano".to_string(),
        subtitle: "Compilazione form senza login e senza pagamento".to_string(),
        payload: serde_json::json!({
            "url": "https://trainline.example/search?token=redacted",
            "snapshot": "redacted"
        }),
        artifact_refs: vec![],
        approval_required: false,
    })?;
    manager.append_terminal_output(
        &session.session_id,
        DEFAULT_USER_ID,
        DEFAULT_WORKSPACE_ID,
        "local-task % date '+%Y-%m-%d %H:%M %Z'\n2026-05-23 16:31 CEST",
    )?;
    manager.create_artifact(ArtifactCreate {
        session_id: session.session_id,
        artifact_id: "shot_results".to_string(),
        title: "risultati-treni-redatto.png".to_string(),
        kind: "screenshot".to_string(),
        path_ref: "artifact://shot_results".to_string(),
        size_bytes: 104_448,
        preview_ref: Some("preview://shot_results".to_string()),
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> DesktopCoreState {
        DesktopCoreState::seeded(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            .unwrap()
    }

    #[test]
    fn bridge_status_keeps_learning_deferred() {
        let status = state().bridge_status();

        assert!(status.local_first);
        assert!(!status.cloud_api_enabled);
        assert!(
            status
                .components
                .iter()
                .any(|component| component.id == "learning" && component.status == "deferred")
        );
    }

    #[test]
    fn task_snapshot_uses_redacted_read_model() {
        let state = state();
        let snapshot = state.task_queue_snapshot().unwrap();
        let detail = state.task_detail("task_browser_quote").unwrap().unwrap();

        assert_eq!(snapshot.active.len(), 1);
        assert_eq!(snapshot.waiting_approvals.len(), 1);
        assert!(!detail.exposes_raw_input);
        assert_eq!(
            detail.latest_checkpoint.unwrap()["browser"]["snapshot"],
            "redacted"
        );
    }

    #[test]
    fn memory_dashboard_exposes_policy_filtered_counts() {
        let dashboard = state().memory_dashboard_snapshot().unwrap();

        assert_eq!(dashboard.total_memories, 2);
        assert!(
            dashboard
                .by_status
                .iter()
                .any(|item| item.key == "candidate")
        );
        assert!(
            dashboard
                .by_status
                .iter()
                .any(|item| item.key == "confirmed")
        );
    }

    #[test]
    fn runtime_snapshot_lists_default_sidecars_without_env() {
        let snapshot = state().runtime_health_snapshot().unwrap();

        assert_eq!(snapshot.processes.len(), 2);
        assert!(snapshot.processes.iter().any(|process| {
            process.id == "llm-gemma4-mlx" && process.command_label == "python"
        }));
        assert!(
            snapshot
                .processes
                .iter()
                .all(|process| process.pid.is_none())
        );
    }

    #[test]
    fn capability_snapshot_omits_secret_refs() {
        let snapshot = state().capability_snapshot().unwrap();
        let serialized = serde_json::to_string(&snapshot).unwrap();

        assert!(snapshot.connections.iter().any(|connection| {
            connection.provider_id == "browser" && connection.status == "active"
        }));
        assert!(!serialized.contains("oauth:not-configured"));
        assert!(!serialized.contains("local-profile"));
    }

    #[test]
    fn local_computer_snapshot_is_redacted_for_ui() {
        let snapshot = state()
            .local_computer_session_snapshot("computer_train_search")
            .unwrap()
            .unwrap();
        let serialized = serde_json::to_string(&snapshot).unwrap();

        assert_eq!(snapshot.task_id, "task_browser_quote");
        assert_eq!(
            snapshot.current_url_redacted.as_deref(),
            Some("https://trainline.example/search")
        );
        assert!(snapshot.preview_frame_ref.is_some());
        assert!(!serialized.contains("token="));
    }
}
