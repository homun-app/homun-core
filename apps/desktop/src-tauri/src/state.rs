use crate::local_computer_smoke;
use crate::models::{
    BridgeStatus, CapabilityPolicySummary, CapabilitySnapshot, ComputerArtifactPreview,
    DesktopChatMessage, DesktopChatMessagesSnapshot, DesktopChatThread, DesktopChatThreadSnapshot,
    DesktopTaskDetail, DesktopTaskQueueSnapshot, PromptPlanBatchRunResult, PromptPlanStepRunResult,
    RuntimeHealthSnapshot, RuntimeProcessItem, capability_connection_item, capability_tool_item,
    component, desktop_task_detail, desktop_task_queue, runtime_process_item,
    runtime_process_item_with_snapshot,
};
use crate::prompt_plan_executor;
use crate::prompt_submission::{
    self, PromptBrain, PromptExecutionPlan, PromptMessage, PromptSubmissionResult,
    PromptTaskPlanner, RuntimePromptBrain, RuntimePromptTaskPlanner,
};
use crate::seed::{seed_capabilities, seed_memories, seed_tasks};
use local_first_browser_automation::{BrowserMethod, BrowserTaskRuntimeBridge};
use local_first_capabilities::{
    CapabilityRegistryStore, ProviderId, UserId as CapabilityUserId,
    WorkspaceId as CapabilityWorkspaceId,
};
use local_first_local_computer_session::{
    ComputerEventCreate, ComputerSessionCreate, ComputerSessionSnapshot,
    LocalComputerSessionManager, LocalComputerSessionStore, SurfaceKind, redact_text,
};
use local_first_memory::{
    DataSensitivity, MemoryAccessRequest, MemoryDashboard, MemoryFacade, MemoryUiReadModel,
    PrivacyDomain, SQLiteMemoryStore, UserId as MemoryUserId, WorkspaceId as MemoryWorkspaceId,
};
use local_first_process_manager::{
    LocalProcessSupervisor, ProcessManager, ProcessRegistryStore, SidecarProcessCatalog,
};
use local_first_subagents::RuntimeClient;
use local_first_task_runtime::{
    ApprovalGate, ResourceClass, ResourceRequirement, TaskId, TaskRecord, TaskStatus, TaskStore,
    TaskUiReadModel, UserId as TaskUserId, WorkspaceId as TaskWorkspaceId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) const DEFAULT_USER_ID: &str = "local-user";
pub(crate) const DEFAULT_WORKSPACE_ID: &str = "local-workspace";

pub struct DesktopCoreState {
    user_id: String,
    workspace_id: String,
    workspace_root: PathBuf,
    process_ids: Vec<String>,
    capability_provider_ids: Vec<String>,
    task_store: Mutex<TaskStore>,
    memory_facade: Mutex<MemoryFacade>,
    process_manager: Mutex<ProcessManager<LocalProcessSupervisor>>,
    capability_store: Mutex<CapabilityRegistryStore>,
    local_computer: Mutex<LocalComputerSessionManager>,
    chat_threads: Mutex<ChatThreadStore>,
    brain_runtime_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatThreadStore {
    active_thread_id: String,
    threads: Vec<DesktopChatThread>,
    #[serde(default)]
    messages: BTreeMap<String, Vec<DesktopChatMessage>>,
    #[serde(skip)]
    path: Option<PathBuf>,
}

enum DesktopStorageMode {
    InMemory,
    Persistent,
}

impl ChatThreadStore {
    fn load_or_default(path: Option<PathBuf>) -> Result<Self, String> {
        let Some(path_ref) = path.as_ref() else {
            return Ok(Self::default_with_path(None));
        };
        if path_ref.exists() {
            let json = std::fs::read_to_string(path_ref).map_err(to_string_error)?;
            let mut store: Self = serde_json::from_str(&json).map_err(to_string_error)?;
            store.path = path;
            if store.threads.is_empty() {
                store = Self::default_with_path(store.path.clone());
                store.persist()?;
            }
            store.ensure_thread_messages();
            return Ok(store);
        }

        let store = Self::default_with_path(path);
        store.persist()?;
        Ok(store)
    }

    fn default_with_path(path: Option<PathBuf>) -> Self {
        let default_thread = DesktopChatThread {
            thread_id: "thread_active_prompt".to_string(),
            title: "Nuovo compito".to_string(),
            subtitle: "Sessione locale pronta".to_string(),
            status: "active".to_string(),
            computer_session_id: "computer_active_prompt".to_string(),
            task_id: "task_prompt_session".to_string(),
            updated_at: now_timestamp(),
            message_count: 1,
        };
        let mut messages = BTreeMap::new();
        messages.insert(
            default_thread.thread_id.clone(),
            starter_chat_messages(&default_thread),
        );
        Self {
            active_thread_id: "thread_active_prompt".to_string(),
            threads: vec![default_thread],
            messages,
            path,
        }
    }

    fn ensure_thread_messages(&mut self) {
        for thread in self.threads.iter_mut() {
            let messages = self
                .messages
                .entry(thread.thread_id.clone())
                .or_insert_with(|| starter_chat_messages(thread));
            thread.message_count = messages.len() as u32;
        }
    }

    fn persist(&self) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(to_string_error)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(to_string_error)?;
        std::fs::write(path, json).map_err(to_string_error)
    }
}

impl DesktopCoreState {
    pub fn seeded(workspace_root: PathBuf) -> Result<Self, String> {
        Self::seeded_with_storage(workspace_root, DesktopStorageMode::Persistent)
    }

    #[cfg(test)]
    pub fn seeded_in_memory(workspace_root: PathBuf) -> Result<Self, String> {
        Self::seeded_with_storage(workspace_root, DesktopStorageMode::InMemory)
    }

    fn seeded_with_storage(
        workspace_root: PathBuf,
        storage_mode: DesktopStorageMode,
    ) -> Result<Self, String> {
        let persistent_dir = match storage_mode {
            DesktopStorageMode::InMemory => None,
            DesktopStorageMode::Persistent => {
                let dir = workspace_root.join(".local-first").join("desktop-state");
                std::fs::create_dir_all(&dir).map_err(to_string_error)?;
                Some(dir)
            }
        };

        let task_store = match &persistent_dir {
            Some(dir) => {
                TaskStore::open(dir.join("task-runtime.sqlite")).map_err(to_string_error)?
            }
            None => TaskStore::open_in_memory().map_err(to_string_error)?,
        };
        seed_tasks_if_empty(&task_store).map_err(to_string_error)?;
        recover_desktop_runtime_state(&task_store).map_err(to_string_error)?;

        let memory_facade = MemoryFacade::new(match &persistent_dir {
            Some(dir) => SQLiteMemoryStore::open(dir.join("memory.sqlite"))?,
            None => SQLiteMemoryStore::open_in_memory()?,
        });
        seed_memories_if_empty(&memory_facade)?;

        let process_store = match &persistent_dir {
            Some(dir) => ProcessRegistryStore::open(dir.join("process-registry.sqlite"))
                .map_err(to_string_error)?,
            None => ProcessRegistryStore::open_in_memory().map_err(to_string_error)?,
        };
        let sidecar_catalog = SidecarProcessCatalog::new(&workspace_root);
        let process_manager = ProcessManager::new(process_store, LocalProcessSupervisor::new());
        process_manager
            .register(sidecar_catalog.gemma_runtime())
            .map_err(to_string_error)?;
        process_manager
            .register(sidecar_catalog.browser_sidecar())
            .map_err(to_string_error)?;

        let capability_store = match &persistent_dir {
            Some(dir) => CapabilityRegistryStore::open(dir.join("capability-registry.sqlite"))
                .map_err(to_string_error)?,
            None => CapabilityRegistryStore::open_in_memory().map_err(to_string_error)?,
        };
        let capability_provider_ids = seed_capabilities(&capability_store)?;
        let local_computer = LocalComputerSessionManager::new(match &persistent_dir {
            Some(dir) => LocalComputerSessionStore::open(dir.join("local-computer.sqlite"))?,
            None => LocalComputerSessionStore::open_in_memory()?,
        });
        ensure_seed_local_computer_session(&local_computer)?;
        let chat_threads = match &persistent_dir {
            Some(dir) => ChatThreadStore::load_or_default(Some(dir.join("chat-threads.json")))?,
            None => ChatThreadStore::load_or_default(None)?,
        };

        Ok(Self {
            user_id: DEFAULT_USER_ID.to_string(),
            workspace_id: DEFAULT_WORKSPACE_ID.to_string(),
            workspace_root,
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
            chat_threads: Mutex::new(chat_threads),
            brain_runtime_url: "http://127.0.0.1:8765".to_string(),
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

    pub fn chat_thread_snapshot(&self) -> Result<DesktopChatThreadSnapshot, String> {
        let store = self
            .chat_threads
            .lock()
            .map_err(|_| "chat thread lock poisoned".to_string())?;
        Ok(DesktopChatThreadSnapshot {
            active_thread_id: store.active_thread_id.clone(),
            threads: store.threads.clone(),
        })
    }

    pub fn chat_messages_snapshot(
        &self,
        thread_id: &str,
    ) -> Result<DesktopChatMessagesSnapshot, String> {
        let store = self
            .chat_threads
            .lock()
            .map_err(|_| "chat thread lock poisoned".to_string())?;
        if !store
            .threads
            .iter()
            .any(|thread| thread.thread_id == thread_id)
        {
            return Err(format!("chat thread not found: {thread_id}"));
        }
        Ok(DesktopChatMessagesSnapshot {
            thread_id: thread_id.to_string(),
            messages: store.messages.get(thread_id).cloned().unwrap_or_default(),
        })
    }

    pub fn select_chat_thread(&self, thread_id: &str) -> Result<DesktopChatThreadSnapshot, String> {
        let mut store = self
            .chat_threads
            .lock()
            .map_err(|_| "chat thread lock poisoned".to_string())?;
        if !store
            .threads
            .iter()
            .any(|thread| thread.thread_id == thread_id)
        {
            return Err(format!("chat thread not found: {thread_id}"));
        }
        store.active_thread_id = thread_id.to_string();
        store.persist()?;
        Ok(DesktopChatThreadSnapshot {
            active_thread_id: store.active_thread_id.clone(),
            threads: store.threads.clone(),
        })
    }

    pub fn create_chat_thread(&self) -> Result<DesktopChatThread, String> {
        let suffix = Uuid::new_v4().simple().to_string();
        let short_suffix = &suffix[..12];
        let thread_id = format!("thread_{short_suffix}");
        let task_id = format!("task_prompt_{short_suffix}");
        let computer_session_id = format!("computer_{short_suffix}");

        {
            let manager = self
                .local_computer
                .lock()
                .map_err(|_| "local computer lock poisoned".to_string())?;
            create_local_computer_session(
                &manager,
                &computer_session_id,
                &task_id,
                &self.user_id,
                &self.workspace_id,
            )?;
        }

        let thread = DesktopChatThread {
            thread_id,
            title: "Nuovo compito".to_string(),
            subtitle: "Chat pulita, pronta per un nuovo task".to_string(),
            status: "active".to_string(),
            computer_session_id,
            task_id,
            updated_at: now_timestamp(),
            message_count: 1,
        };
        let mut store = self
            .chat_threads
            .lock()
            .map_err(|_| "chat thread lock poisoned".to_string())?;
        store.active_thread_id = thread.thread_id.clone();
        store.threads.insert(0, thread.clone());
        store
            .messages
            .insert(thread.thread_id.clone(), starter_chat_messages(&thread));
        store.persist()?;
        Ok(thread)
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

    pub fn approve_task_approval(
        &self,
        approval_id: &str,
    ) -> Result<DesktopTaskQueueSnapshot, String> {
        let store = self
            .task_store
            .lock()
            .map_err(|_| "task store lock poisoned".to_string())?;
        let approval = store
            .approval_by_id(approval_id)
            .map_err(to_string_error)?
            .ok_or_else(|| format!("approval not found: {approval_id}"))?;
        self.ensure_approval_scope(&approval)?;
        ApprovalGate::new()
            .approve(&store, approval_id, &self.user_id)
            .map_err(to_string_error)?;
        store
            .append_checkpoint(
                &approval.task_id,
                &approval.user_id,
                &approval.workspace_id,
                serde_json::json!({
                    "approval_id": approval.approval_id,
                    "decision": "approved",
                    "payload": "redacted"
                }),
                serde_json::json!({
                    "approval": {
                        "decision": "approved",
                        "action": approval.action,
                        "data_boundary": approval.data_boundary
                    }
                }),
            )
            .map_err(to_string_error)?;
        self.task_queue_snapshot_from_store(&store)
    }

    pub fn reject_task_approval(
        &self,
        approval_id: &str,
        reason: &str,
    ) -> Result<DesktopTaskQueueSnapshot, String> {
        let store = self
            .task_store
            .lock()
            .map_err(|_| "task store lock poisoned".to_string())?;
        let approval = store
            .approval_by_id(approval_id)
            .map_err(to_string_error)?
            .ok_or_else(|| format!("approval not found: {approval_id}"))?;
        self.ensure_approval_scope(&approval)?;
        let reason = if reason.trim().is_empty() {
            "Rifiutato dall'utente"
        } else {
            reason.trim()
        };
        ApprovalGate::new()
            .reject(&store, approval_id, &self.user_id, reason)
            .map_err(to_string_error)?;
        store
            .append_checkpoint(
                &approval.task_id,
                &approval.user_id,
                &approval.workspace_id,
                serde_json::json!({
                    "approval_id": approval.approval_id,
                    "decision": "rejected",
                    "payload": "redacted"
                }),
                serde_json::json!({
                    "approval": {
                        "decision": "rejected",
                        "action": approval.action,
                        "reason": reason
                    }
                }),
            )
            .map_err(to_string_error)?;
        self.task_queue_snapshot_from_store(&store)
    }

    pub fn run_prompt_plan_next_step(
        &self,
        session_id: &str,
    ) -> Result<PromptPlanStepRunResult, String> {
        let store = self
            .task_store
            .lock()
            .map_err(|_| "task store lock poisoned".to_string())?;
        let manager = self
            .local_computer
            .lock()
            .map_err(|_| "local computer lock poisoned".to_string())?;
        prompt_plan_executor::run_next_prompt_plan_step(
            &store,
            &manager,
            &self.workspace_root,
            &self.user_id,
            &self.workspace_id,
            session_id,
        )
    }

    pub fn run_prompt_plan_ready_steps(
        &self,
        session_id: &str,
        max_steps: usize,
    ) -> Result<PromptPlanBatchRunResult, String> {
        let max_steps = max_steps.clamp(1, 8);
        let mut results = Vec::new();
        let mut completed = 0;
        let mut stopped_reason = None;
        for _ in 0..max_steps {
            let result = self.run_prompt_plan_next_step(session_id)?;
            if result.status == "completed" {
                completed += 1;
                results.push(result);
                continue;
            }
            stopped_reason = Some(result.status.clone());
            results.push(result);
            break;
        }
        let status = if stopped_reason.is_some() {
            "stopped"
        } else if completed == max_steps {
            "limit_reached"
        } else {
            "completed"
        };
        let batch = PromptPlanBatchRunResult {
            status: status.to_string(),
            completed,
            stopped_reason,
            results,
        };
        let last_message = batch
            .results
            .last()
            .map(|result| result.message.as_str())
            .unwrap_or("Nessuno step pronto.");
        let system_text = if batch.completed > 0 {
            format!("Eseguiti {} step locali. {last_message}", batch.completed)
        } else {
            last_message.to_string()
        };
        self.append_chat_system_message_for_session(
            session_id,
            &system_text,
            Some(batch.stopped_reason.as_deref().unwrap_or(&batch.status)),
        )?;
        Ok(batch)
    }

    fn ensure_approval_scope(
        &self,
        approval: &local_first_task_runtime::ApprovalRequest,
    ) -> Result<(), String> {
        if approval.user_id.as_str() != self.user_id
            || approval.workspace_id.as_str() != self.workspace_id
        {
            return Err("approval outside current user/workspace".to_string());
        }
        Ok(())
    }

    fn task_queue_snapshot_from_store(
        &self,
        store: &TaskStore,
    ) -> Result<DesktopTaskQueueSnapshot, String> {
        let user_id = TaskUserId::new(&self.user_id);
        let workspace_id = TaskWorkspaceId::new(&self.workspace_id);
        let snapshot = TaskUiReadModel::new(store)
            .queue_snapshot(&user_id, &workspace_id)
            .map_err(to_string_error)?;
        desktop_task_queue(snapshot)
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

    pub fn local_computer_artifact_preview(
        &self,
        session_id: &str,
        artifact_id: &str,
    ) -> Result<Option<ComputerArtifactPreview>, String> {
        const MAX_PREVIEW_BYTES: u64 = 5 * 1024 * 1024;

        let manager = self
            .local_computer
            .lock()
            .map_err(|_| "local computer lock poisoned".to_string())?;
        let artifacts =
            manager
                .store()
                .artifacts_for_session(session_id, &self.user_id, &self.workspace_id)?;
        let Some(artifact) = artifacts
            .into_iter()
            .find(|artifact| artifact.artifact_id == artifact_id)
        else {
            return Ok(None);
        };
        let Some(preview_ref) = artifact.preview_ref.clone() else {
            return Ok(None);
        };
        if artifact.size_bytes > MAX_PREVIEW_BYTES {
            return Err("artifact preview exceeds local UI size limit".to_string());
        }

        let preview_path = PathBuf::from(&preview_ref);
        let mime_type = preview_mime_type(&preview_path)?;
        let bytes = std::fs::read(&preview_path).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_PREVIEW_BYTES {
            return Err("artifact preview exceeds local UI size limit".to_string());
        }

        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(Some(ComputerArtifactPreview {
            artifact_id: artifact.artifact_id,
            title_redacted: redact_text(&artifact.title),
            kind: artifact.kind,
            size_bytes: artifact.size_bytes,
            data_url: format!("data:{mime_type};base64,{encoded}"),
        }))
    }

    pub fn run_local_computer_smoke_test(
        &self,
        session_id: &str,
    ) -> Result<ComputerSessionSnapshot, String> {
        let manager = self
            .local_computer
            .lock()
            .map_err(|_| "local computer lock poisoned".to_string())?;
        local_computer_smoke::run_local_computer_smoke_test(
            &manager,
            &self.workspace_root,
            &self.user_id,
            &self.workspace_id,
            session_id,
        )
    }

    pub fn request_local_computer_takeover(
        &self,
        session_id: &str,
    ) -> Result<ComputerSessionSnapshot, String> {
        let manager = self
            .local_computer
            .lock()
            .map_err(|_| "local computer lock poisoned".to_string())?;
        manager.request_takeover(
            session_id,
            &self.user_id,
            &self.workspace_id,
            "Richiesta controllo manuale dalla UI desktop",
        )?;
        manager
            .read_model()
            .snapshot(session_id, &self.user_id, &self.workspace_id)?
            .ok_or_else(|| format!("session not found: {session_id}"))
    }

    pub fn pause_local_computer_session(
        &self,
        session_id: &str,
    ) -> Result<ComputerSessionSnapshot, String> {
        let manager = self
            .local_computer
            .lock()
            .map_err(|_| "local computer lock poisoned".to_string())?;
        manager.pause_session(
            session_id,
            &self.user_id,
            &self.workspace_id,
            "Pausa richiesta dalla UI desktop",
        )?;
        manager
            .read_model()
            .snapshot(session_id, &self.user_id, &self.workspace_id)?
            .ok_or_else(|| format!("session not found: {session_id}"))
    }

    pub fn resume_local_computer_session(
        &self,
        session_id: &str,
    ) -> Result<ComputerSessionSnapshot, String> {
        let manager = self
            .local_computer
            .lock()
            .map_err(|_| "local computer lock poisoned".to_string())?;
        manager.resume_session(session_id, &self.user_id, &self.workspace_id)?;
        manager
            .read_model()
            .snapshot(session_id, &self.user_id, &self.workspace_id)?
            .ok_or_else(|| format!("session not found: {session_id}"))
    }

    pub fn submit_user_prompt(
        &self,
        session_id: &str,
        prompt: &str,
    ) -> Result<PromptSubmissionResult, String> {
        let mut brain = RuntimePromptBrain::new(RuntimeClient::new(&self.brain_runtime_url));
        let mut planner =
            RuntimePromptTaskPlanner::new(RuntimeClient::new(&self.brain_runtime_url));
        self.submit_user_prompt_with_brain_and_planner(session_id, prompt, &mut brain, &mut planner)
    }

    fn submit_user_prompt_with_brain_and_planner(
        &self,
        session_id: &str,
        prompt: &str,
        brain: &mut impl PromptBrain,
        planner: &mut impl PromptTaskPlanner,
    ) -> Result<PromptSubmissionResult, String> {
        let manager = self
            .local_computer
            .lock()
            .map_err(|_| "local computer lock poisoned".to_string())?;
        let result = prompt_submission::submit_user_prompt(
            &manager,
            brain,
            planner,
            &self.user_id,
            &self.workspace_id,
            session_id,
            prompt,
        )?;
        drop(manager);
        if let Some(plan) = &result.plan {
            self.enqueue_prompt_plan(session_id, plan)?;
        }
        self.record_prompt_messages_for_session(session_id, prompt, &result.assistant_message)?;
        Ok(result)
    }

    fn record_prompt_messages_for_session(
        &self,
        session_id: &str,
        prompt: &str,
        assistant_message: &PromptMessage,
    ) -> Result<(), String> {
        let mut store = self
            .chat_threads
            .lock()
            .map_err(|_| "chat thread lock poisoned".to_string())?;
        let Some(index) = store
            .threads
            .iter()
            .position(|thread| thread.computer_session_id == session_id)
        else {
            return Ok(());
        };
        let thread_id = store.threads[index].thread_id.clone();
        if !store.messages.contains_key(&thread_id) {
            let starter = starter_chat_messages(&store.threads[index]);
            store.messages.insert(thread_id.clone(), starter);
        }
        let messages = store
            .messages
            .get_mut(&thread_id)
            .ok_or_else(|| format!("chat messages not found: {thread_id}"))?;
        messages.push(DesktopChatMessage {
            id: format!("user_{}", Uuid::new_v4().simple()),
            role: "user".to_string(),
            text: prompt.trim().to_string(),
            timestamp: "ora".to_string(),
            metadata: Some("Inviato al core locale".to_string()),
        });
        messages.push(DesktopChatMessage {
            id: assistant_message.id.clone(),
            role: assistant_message.role.clone(),
            text: assistant_message.text.clone(),
            timestamp: assistant_message.timestamp.clone(),
            metadata: assistant_message.metadata.clone(),
        });
        let message_count = messages.len() as u32;
        let prompt_title = truncate_chars(prompt.trim(), 44);
        let assistant_subtitle = truncate_chars(&assistant_message.text, 72);
        let thread = &mut store.threads[index];
        thread.updated_at = now_timestamp();
        thread.message_count = message_count;
        if thread.title == "Nuovo compito" && !prompt_title.is_empty() {
            thread.title = prompt_title;
        }
        thread.subtitle = if assistant_subtitle.is_empty() {
            "Risposta locale disponibile".to_string()
        } else {
            assistant_subtitle
        };
        store.active_thread_id = thread.thread_id.clone();
        store.persist()?;
        Ok(())
    }

    fn append_chat_system_message_for_session(
        &self,
        session_id: &str,
        text: &str,
        metadata: Option<&str>,
    ) -> Result<(), String> {
        let mut store = self
            .chat_threads
            .lock()
            .map_err(|_| "chat thread lock poisoned".to_string())?;
        let Some(index) = store
            .threads
            .iter()
            .position(|thread| thread.computer_session_id == session_id)
        else {
            return Ok(());
        };
        let thread_id = store.threads[index].thread_id.clone();
        if !store.messages.contains_key(&thread_id) {
            let starter = starter_chat_messages(&store.threads[index]);
            store.messages.insert(thread_id.clone(), starter);
        }
        let messages = store
            .messages
            .get_mut(&thread_id)
            .ok_or_else(|| format!("chat messages not found: {thread_id}"))?;
        messages.push(DesktopChatMessage {
            id: format!("system_{}", Uuid::new_v4().simple()),
            role: "system".to_string(),
            text: text.to_string(),
            timestamp: "ora".to_string(),
            metadata: metadata.map(ToString::to_string),
        });
        let message_count = messages.len() as u32;
        let subtitle = truncate_chars(text, 72);
        let thread = &mut store.threads[index];
        thread.updated_at = now_timestamp();
        thread.message_count = message_count;
        thread.subtitle = subtitle;
        store.active_thread_id = thread.thread_id.clone();
        store.persist()?;
        Ok(())
    }

    fn enqueue_prompt_plan(
        &self,
        session_id: &str,
        plan: &PromptExecutionPlan,
    ) -> Result<(), String> {
        let store = self
            .task_store
            .lock()
            .map_err(|_| "task store lock poisoned".to_string())?;
        let user_id = TaskUserId::new(&self.user_id);
        let workspace_id = TaskWorkspaceId::new(&self.workspace_id);
        let approval_gate = ApprovalGate::new();
        for step in &plan.steps {
            if step.surface == "browser" && step.target_url.is_some() {
                self.enqueue_browser_plan_step(
                    &store,
                    &user_id,
                    &workspace_id,
                    session_id,
                    plan,
                    step,
                )?;
                continue;
            }
            let task_id = format!(
                "prompt_{}_{}",
                sanitize_task_id(session_id),
                sanitize_task_id(&step.step_id)
            );
            let task = TaskRecord::new(
                task_id.clone(),
                user_id.clone(),
                workspace_id.clone(),
                format!("prompt_plan.{}", step.action_kind),
                step.title.clone(),
                serde_json::json!({
                    "source": "prompt_plan",
                    "session_id": session_id,
                    "plan_title": plan.title,
                    "step_id": step.step_id,
                    "surface": step.surface,
                    "action_kind": step.action_kind,
                    "target_url": step.target_url,
                    "payload_redacted": true
                }),
            )
            .with_resource(ResourceRequirement::new(
                resource_for_plan_surface(&step.surface),
                1,
            ));
            store.insert_task(&task).map_err(to_string_error)?;
            store
                .append_checkpoint(
                    &task.task_id,
                    &user_id,
                    &workspace_id,
                    serde_json::json!({"raw_prompt_stored": false, "plan_step": step}),
                    serde_json::json!({
                        "plan": {
                            "title": plan.title,
                            "risk_level": plan.risk_level
                        },
                        "step": {
                            "step_id": step.step_id,
                            "title": step.title,
                            "detail": step.detail,
                            "surface": step.surface,
                            "action_kind": step.action_kind,
                            "target_url_origin": step.target_url.as_deref().map(redacted_url_origin),
                            "requires_user_approval": step.requires_user_approval
                        },
                        "payload_redacted": true
                    }),
                )
                .map_err(to_string_error)?;
            if step.requires_user_approval {
                approval_gate
                    .request_approval(
                        &store,
                        &task.task_id,
                        &user_id,
                        &workspace_id,
                        "prompt_plan.approve_step",
                        &plan.risk_level,
                        "local_first",
                        "Conferma esplicita richiesta prima di login, acquisto, invio o pagamento.",
                    )
                    .map_err(to_string_error)?;
            }
        }
        Ok(())
    }

    fn enqueue_browser_plan_step(
        &self,
        store: &TaskStore,
        user_id: &TaskUserId,
        workspace_id: &TaskWorkspaceId,
        session_id: &str,
        plan: &PromptExecutionPlan,
        step: &crate::prompt_submission::PromptPlanStep,
    ) -> Result<(), String> {
        self.ensure_cached_browser_tool("browser.open")?;
        let target_url = step
            .target_url
            .as_deref()
            .ok_or_else(|| "browser step missing target_url".to_string())?;
        let task_id = format!(
            "browser_{}_{}",
            sanitize_task_id(session_id),
            sanitize_task_id(&step.step_id)
        );
        let target_id = format!("task-{}", sanitize_task_id(&task_id));
        let mut task = BrowserTaskRuntimeBridge::new().enqueue_browser_call(
            task_id,
            user_id.clone(),
            workspace_id.clone(),
            BrowserMethod::Open,
            serde_json::json!({
                "url": target_url,
                "label": target_id,
                "source": "prompt_plan"
            }),
        );
        task.goal = step.title.clone();
        task.risk_level = plan.risk_level.clone();
        task.input_json["source"] = serde_json::json!("prompt_plan");
        task.input_json["session_id"] = serde_json::json!(session_id);
        task.input_json["plan_title"] = serde_json::json!(plan.title);
        task.input_json["step_id"] = serde_json::json!(step.step_id);
        task.input_json["surface"] = serde_json::json!(step.surface);
        task.input_json["action_kind"] = serde_json::json!(step.action_kind);
        task.input_json["target_url_origin"] = serde_json::json!(redacted_url_origin(target_url));
        task.input_json["read_after_open"] = serde_json::json!(true);
        store.insert_task(&task).map_err(to_string_error)?;
        store
            .append_checkpoint(
                &task.task_id,
                user_id,
                workspace_id,
                serde_json::json!({
                    "raw_prompt_stored": false,
                    "plan_step": step,
                    "browser_method": "browser.open"
                }),
                serde_json::json!({
                    "plan": {
                        "title": plan.title,
                        "risk_level": plan.risk_level
                    },
                    "step": {
                        "step_id": step.step_id,
                        "title": step.title,
                        "detail": step.detail,
                        "surface": step.surface,
                        "action_kind": step.action_kind,
                        "target_url_origin": redacted_url_origin(target_url),
                        "requires_user_approval": step.requires_user_approval
                    },
                    "browser": {
                        "method": "browser.open",
                        "read_after_open": true,
                        "target_id": target_id,
                        "target_url_origin": redacted_url_origin(target_url)
                    },
                    "payload_redacted": true
                }),
            )
            .map_err(to_string_error)?;
        Ok(())
    }

    fn ensure_cached_browser_tool(&self, tool_name: &str) -> Result<(), String> {
        let store = self
            .capability_store
            .lock()
            .map_err(|_| "capability store lock poisoned".to_string())?;
        let tools = store
            .cached_tools(&ProviderId::new("browser"))
            .map_err(to_string_error)?;
        tools
            .iter()
            .any(|tool| tool.tool.name == tool_name)
            .then_some(())
            .ok_or_else(|| format!("capability tool not cached: browser:{tool_name}"))
    }
}

fn sanitize_task_id(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect()
}

fn resource_for_plan_surface(surface: &str) -> ResourceClass {
    match surface {
        "browser" => ResourceClass::BrowserSession,
        "shell" => ResourceClass::ShellProcess,
        "files" => ResourceClass::FilesystemIo,
        _ => ResourceClass::BackgroundMaintenance,
    }
}

fn redacted_url_origin(target_url: &str) -> String {
    if target_url == "about:blank" {
        return target_url.to_string();
    }
    let Some((scheme, rest)) = target_url.split_once("://") else {
        return "redacted".to_string();
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("redacted");
    format!("{scheme}://{host}")
}

fn preview_mime_type(path: &std::path::Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Ok("image/png"),
        Some("jpg") | Some("jpeg") => Ok("image/jpeg"),
        Some("webp") => Ok("image/webp"),
        _ => Err("unsupported artifact preview type".to_string()),
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

fn seed_tasks_if_empty(store: &TaskStore) -> Result<(), String> {
    let tasks = store
        .list_tasks(
            &TaskUserId::new(DEFAULT_USER_ID),
            &TaskWorkspaceId::new(DEFAULT_WORKSPACE_ID),
        )
        .map_err(to_string_error)?;
    if tasks.is_empty() {
        seed_tasks(store).map_err(to_string_error)?;
    }
    Ok(())
}

fn seed_memories_if_empty(facade: &MemoryFacade) -> Result<(), String> {
    let memories = facade
        .list_memories_for_ui(
            &MemoryUserId::new(DEFAULT_USER_ID),
            &MemoryWorkspaceId::new(DEFAULT_WORKSPACE_ID),
        )
        .map_err(to_string_error)?;
    if memories.is_empty() {
        seed_memories(facade)?;
    }
    Ok(())
}

fn recover_desktop_runtime_state(store: &TaskStore) -> Result<Vec<TaskId>, String> {
    let user_id = TaskUserId::new(DEFAULT_USER_ID);
    let workspace_id = TaskWorkspaceId::new(DEFAULT_WORKSPACE_ID);
    let now = OffsetDateTime::now_utc();
    let mut recovered = Vec::new();

    for mut task in store
        .list_tasks(&user_id, &workspace_id)
        .map_err(to_string_error)?
    {
        if task.kind == "local_prompt" {
            continue;
        }

        if matches!(
            task.status,
            TaskStatus::Completed
                | TaskStatus::Failed
                | TaskStatus::Cancelled
                | TaskStatus::Expired
        ) {
            store.release_resources(&task).map_err(to_string_error)?;
            continue;
        }

        if !matches!(
            task.status,
            TaskStatus::Running | TaskStatus::WaitingResource
        ) {
            continue;
        }

        store.release_resources(&task).map_err(to_string_error)?;
        task.status = TaskStatus::Queued;
        task.lease_owner = None;
        task.lease_expires_at = None;
        task.last_heartbeat_at = None;
        task.blocked_reason = Some("recovered after desktop restart".to_string());
        task.updated_at = now;
        let task_id = task.task_id.clone();
        store.insert_task(&task).map_err(to_string_error)?;
        store
            .append_checkpoint(
                &task_id,
                &user_id,
                &workspace_id,
                serde_json::json!({
                    "desktop_recovery": {
                        "state": "requeued_after_restart",
                        "raw_payload_stored": false
                    }
                }),
                serde_json::json!({
                    "desktop_recovery": {
                        "state": "requeued_after_restart",
                        "resource_reservations_released": true,
                        "payload_redacted": true
                    }
                }),
            )
            .map_err(to_string_error)?;
        recovered.push(task_id);
    }

    Ok(recovered)
}

fn ensure_seed_local_computer_session(manager: &LocalComputerSessionManager) -> Result<(), String> {
    if manager
        .read_model()
        .snapshot(
            "computer_active_prompt",
            DEFAULT_USER_ID,
            DEFAULT_WORKSPACE_ID,
        )?
        .is_some()
    {
        return Ok(());
    }
    seed_local_computer_session(manager)
}

fn seed_local_computer_session(manager: &LocalComputerSessionManager) -> Result<(), String> {
    create_local_computer_session(
        manager,
        "computer_active_prompt",
        "task_prompt_session",
        DEFAULT_USER_ID,
        DEFAULT_WORKSPACE_ID,
    )
}

fn create_local_computer_session(
    manager: &LocalComputerSessionManager,
    session_id: &str,
    task_id: &str,
    user_id: &str,
    workspace_id: &str,
) -> Result<(), String> {
    let session = manager.create_session(ComputerSessionCreate {
        session_id: session_id.to_string(),
        task_id: task_id.to_string(),
        workflow_id: None,
        user_id: user_id.to_string(),
        workspace_id: workspace_id.to_string(),
        title: "Computer locale".to_string(),
        subtitle: "Sessione locale pronta per prompt, shell e browser controllato".to_string(),
        risk_level: "low".to_string(),
        progress_total: 3,
    })?;
    manager.append_event(ComputerEventCreate {
        session_id: session.session_id.clone(),
        surface: SurfaceKind::Logs,
        kind: "computer_session_ready".to_string(),
        status: "done".to_string(),
        title: "Sessione locale pronta".to_string(),
        subtitle: "In attesa di prompt utente".to_string(),
        payload: serde_json::json!({
            "raw_payload": "redacted"
        }),
        artifact_refs: vec![],
        approval_required: false,
    })?;
    Ok(())
}

fn starter_chat_messages(thread: &DesktopChatThread) -> Vec<DesktopChatMessage> {
    vec![DesktopChatMessage {
        id: format!("{}_ready", thread.thread_id),
        role: "assistant".to_string(),
        text: "Sono pronto. Questa chat ha una sessione Computer locale separata: puoi scrivere una richiesta senza sporcare i thread precedenti.".to_string(),
        timestamp: "ora".to_string(),
        metadata: Some("Thread locale isolato".to_string()),
    }]
}

fn truncate_chars(text: &str, limit: usize) -> String {
    let mut truncated = text.chars().take(limit).collect::<String>();
    if text.chars().count() > limit {
        truncated.push_str("...");
    }
    truncated
}

fn now_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt_submission::{BrainUnderstanding, PromptPlanStep, PromptTaskPlanner};

    struct StaticBrain {
        understanding: BrainUnderstanding,
    }

    struct StaticPlanner {
        plan: PromptExecutionPlan,
    }

    impl PromptBrain for StaticBrain {
        fn understand(&mut self, _prompt: &str) -> Result<BrainUnderstanding, String> {
            Ok(self.understanding.clone())
        }
    }

    impl PromptTaskPlanner for StaticPlanner {
        fn plan(&mut self, _prompt: &str, _summary: &str) -> Result<PromptExecutionPlan, String> {
            Ok(self.plan.clone())
        }
    }

    fn inert_planner() -> StaticPlanner {
        StaticPlanner {
            plan: PromptExecutionPlan {
                title: "Non usato".to_string(),
                summary: "Non usato".to_string(),
                risk_level: "low".to_string(),
                steps: vec![PromptPlanStep {
                    step_id: "noop".to_string(),
                    title: "Non usato".to_string(),
                    detail: "Non usato".to_string(),
                    surface: "logs".to_string(),
                    action_kind: "final_response".to_string(),
                    requires_user_approval: false,
                    target_url: None,
                }],
            },
        }
    }

    fn train_plan() -> PromptExecutionPlan {
        PromptExecutionPlan {
            title: "Prenotazione treno Napoli-Milano".to_string(),
            summary: "Cercare opzioni alta velocita e preparare conferma utente.".to_string(),
            risk_level: "medium".to_string(),
            steps: vec![
                PromptPlanStep {
                    step_id: "search_trains".to_string(),
                    title: "Cercare treni disponibili".to_string(),
                    detail: "Usare il browser locale per cercare tratte compatibili.".to_string(),
                    surface: "browser".to_string(),
                    action_kind: "research".to_string(),
                    requires_user_approval: false,
                    target_url: Some("about:blank".to_string()),
                },
                PromptPlanStep {
                    step_id: "compare_options".to_string(),
                    title: "Confrontare opzioni".to_string(),
                    detail: "Preparare una shortlist redatta con orari e vincoli.".to_string(),
                    surface: "browser".to_string(),
                    action_kind: "compare_options".to_string(),
                    requires_user_approval: false,
                    target_url: None,
                },
                PromptPlanStep {
                    step_id: "approval_before_payment".to_string(),
                    title: "Conferma prima del pagamento".to_string(),
                    detail: "Bloccare login, acquisto o pagamento senza conferma esplicita."
                        .to_string(),
                    surface: "logs".to_string(),
                    action_kind: "approval_gate".to_string(),
                    requires_user_approval: true,
                    target_url: None,
                },
            ],
        }
    }

    fn approval_only_plan() -> PromptExecutionPlan {
        PromptExecutionPlan {
            title: "Operazione rischiosa".to_string(),
            summary: "Attendere conferma prima di procedere.".to_string(),
            risk_level: "high".to_string(),
            steps: vec![PromptPlanStep {
                step_id: "confirm_send".to_string(),
                title: "Conferma invio".to_string(),
                detail: "Non inviare nulla senza approvazione esplicita.".to_string(),
                surface: "logs".to_string(),
                action_kind: "approval_gate".to_string(),
                requires_user_approval: true,
                target_url: None,
            }],
        }
    }

    fn state() -> DesktopCoreState {
        DesktopCoreState::seeded_in_memory(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."),
        )
        .unwrap()
    }

    #[test]
    fn chat_threads_start_with_default_thread_bound_to_computer_session() {
        let state = state();

        let snapshot = state.chat_thread_snapshot().unwrap();
        let default_thread = snapshot
            .threads
            .iter()
            .find(|thread| thread.thread_id == snapshot.active_thread_id)
            .unwrap();
        let computer = state
            .local_computer_session_snapshot(&default_thread.computer_session_id)
            .unwrap()
            .unwrap();

        assert_eq!(default_thread.thread_id, "thread_active_prompt");
        assert_eq!(default_thread.computer_session_id, "computer_active_prompt");
        assert_eq!(computer.task_id, default_thread.task_id);
        assert_eq!(default_thread.message_count, 1);
    }

    #[test]
    fn create_chat_thread_creates_isolated_computer_session() {
        let state = state();

        let new_thread = state.create_chat_thread().unwrap();
        let snapshot = state.chat_thread_snapshot().unwrap();
        let computer = state
            .local_computer_session_snapshot(&new_thread.computer_session_id)
            .unwrap()
            .unwrap();

        assert_eq!(snapshot.active_thread_id, new_thread.thread_id);
        assert!(snapshot.threads.iter().any(|thread| {
            thread.thread_id == new_thread.thread_id
                && thread.computer_session_id == new_thread.computer_session_id
        }));
        assert_ne!(new_thread.computer_session_id, "computer_active_prompt");
        assert_eq!(computer.computer_session_id, new_thread.computer_session_id);
        assert!(computer.terminal_excerpt_redacted.is_empty());
        assert!(
            computer
                .timeline
                .iter()
                .any(|item| { item.kind == "computer_session_ready" && item.payload_redacted })
        );
        assert!(!computer.timeline.iter().any(|item| {
            item.kind == "user_prompt_received" || item.kind == "local_calculation_completed"
        }));
    }

    #[test]
    fn select_chat_thread_switches_active_thread_without_merging_messages() {
        let state = state();

        let created_thread = state.create_chat_thread().unwrap();
        let selected = state.select_chat_thread("thread_active_prompt").unwrap();
        let default_messages = state
            .chat_messages_snapshot("thread_active_prompt")
            .unwrap();
        let created_messages = state
            .chat_messages_snapshot(&created_thread.thread_id)
            .unwrap();

        assert_eq!(selected.active_thread_id, "thread_active_prompt");
        assert_eq!(default_messages.thread_id, "thread_active_prompt");
        assert_eq!(created_messages.thread_id, created_thread.thread_id);
        assert_eq!(default_messages.messages.len(), 1);
        assert_eq!(created_messages.messages.len(), 1);
        assert_ne!(
            default_messages.messages[0].id,
            created_messages.messages[0].id
        );
    }

    #[test]
    fn submit_user_prompt_persists_chat_messages_and_updates_thread_preview() {
        let state = state();
        let thread = state.create_chat_thread().unwrap();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::LocalCalculation {
                calculation_left: 6,
                calculation_operator: "*".to_string(),
                calculation_right: 3,
                reason: Some("calcolo locale".to_string()),
            },
        };
        let mut planner = inert_planner();

        let result = state
            .submit_user_prompt_with_brain_and_planner(
                &thread.computer_session_id,
                "quanto fa 6*3",
                &mut brain,
                &mut planner,
            )
            .unwrap();
        let result_serialized = serde_json::to_string(&result).unwrap();
        let messages = state.chat_messages_snapshot(&thread.thread_id).unwrap();
        let threads = state.chat_thread_snapshot().unwrap();
        let updated_thread = threads
            .threads
            .iter()
            .find(|item| item.thread_id == thread.thread_id)
            .unwrap();

        assert_eq!(result.assistant_message.text, "6 * 3 fa 18.");
        assert!(!result_serialized.contains("quanto fa 6*3"));
        assert_eq!(threads.active_thread_id, thread.thread_id);
        assert_eq!(messages.messages.len(), 3);
        assert_eq!(messages.messages[1].role, "user");
        assert_eq!(messages.messages[1].text, "quanto fa 6*3");
        assert_eq!(messages.messages[2].role, "assistant");
        assert_eq!(messages.messages[2].text, "6 * 3 fa 18.");
        assert_eq!(updated_thread.title, "quanto fa 6*3");
        assert_eq!(updated_thread.subtitle, "6 * 3 fa 18.");
        assert_eq!(updated_thread.message_count, messages.messages.len() as u32);
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
        let detail = state.task_detail("task_prompt_session").unwrap().unwrap();

        assert_eq!(snapshot.active.len(), 1);
        assert_eq!(snapshot.waiting_approvals.len(), 1);
        assert!(!detail.exposes_raw_input);
        assert_eq!(
            detail.latest_checkpoint.unwrap()["prompt"]["state"],
            "ready"
        );
    }

    #[test]
    fn approval_approve_requeues_task_and_removes_waiting_approval() {
        let state = state();
        let approval_id = state.task_queue_snapshot().unwrap().waiting_approvals[0]
            .approval_id
            .clone();

        let snapshot = state.approve_task_approval(&approval_id).unwrap();
        let detail = state.task_detail("task_acme_summary").unwrap().unwrap();

        assert!(snapshot.waiting_approvals.is_empty());
        assert!(
            snapshot
                .queued
                .iter()
                .any(|task| task.task_id == "task_acme_summary")
        );
        assert_eq!(detail.status, "queued");
        assert!(!detail.exposes_raw_input);
        assert_eq!(
            detail.latest_checkpoint.unwrap()["approval"]["decision"],
            "approved"
        );
    }

    #[test]
    fn approval_reject_cancels_task_with_redacted_checkpoint() {
        let state = state();
        let approval_id = state.task_queue_snapshot().unwrap().waiting_approvals[0]
            .approval_id
            .clone();

        let snapshot = state
            .reject_task_approval(&approval_id, "Non inviare questo riepilogo")
            .unwrap();
        let detail = state.task_detail("task_acme_summary").unwrap().unwrap();

        assert!(snapshot.waiting_approvals.is_empty());
        assert_eq!(detail.status, "cancelled");
        assert_eq!(
            detail.latest_checkpoint.unwrap()["approval"]["decision"],
            "rejected"
        );
        assert!(detail.blocked_reason.unwrap().contains("approval rejected"));
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
            .local_computer_session_snapshot("computer_active_prompt")
            .unwrap()
            .unwrap();
        let serialized = serde_json::to_string(&snapshot).unwrap();

        assert_eq!(snapshot.task_id, "task_prompt_session");
        assert!(snapshot.current_url_redacted.is_none());
        assert!(snapshot.preview_frame_ref.is_none());
        assert!(!serialized.to_lowercase().contains("treni"));
        assert!(!serialized.to_lowercase().contains("napoli"));
        assert!(!serialized.to_lowercase().contains("milano"));
    }

    #[test]
    fn local_computer_smoke_test_records_real_shell_output() {
        let state = state();

        let snapshot = state
            .run_local_computer_smoke_test("computer_active_prompt")
            .unwrap();
        let serialized = serde_json::to_string(&snapshot).unwrap();

        assert_eq!(snapshot.computer_session_id, "computer_active_prompt");
        assert!(
            snapshot
                .timeline
                .iter()
                .any(|item| item.kind == "computer_action_completed")
        );
        assert!(
            snapshot
                .terminal_excerpt_redacted
                .iter()
                .any(|line| line.contains("local-smoke % date"))
        );
        assert!(
            snapshot
                .timeline
                .iter()
                .any(|item| item.kind == "browser_form_draft_completed")
        );
        assert!(!serialized.contains("Submitted"));
        assert!(!serialized.contains("Draft redatto"));
        assert!(snapshot.progress_current >= 2);
        assert!(!serialized.contains("raw_payload"));
    }

    #[test]
    fn local_computer_controls_are_persisted_in_read_model() {
        let state = state();

        let paused = state
            .pause_local_computer_session("computer_active_prompt")
            .unwrap();
        let resumed = state
            .resume_local_computer_session("computer_active_prompt")
            .unwrap();
        let takeover = state
            .request_local_computer_takeover("computer_active_prompt")
            .unwrap();

        assert_eq!(
            paused.status,
            local_first_local_computer_session::SessionStatus::Paused
        );
        assert_eq!(
            resumed.status,
            local_first_local_computer_session::SessionStatus::Running
        );
        assert_eq!(
            takeover.takeover_state,
            local_first_local_computer_session::TakeoverState::Requested
        );
        assert!(
            takeover
                .timeline
                .iter()
                .any(|item| item.kind == "computer_takeover_requested")
        );
        assert!(
            takeover
                .timeline
                .iter()
                .any(|item| item.kind == "computer_session_paused")
        );
        assert!(
            takeover
                .timeline
                .iter()
                .any(|item| item.kind == "computer_session_resumed")
        );
    }

    #[test]
    fn submit_user_prompt_runs_local_time_request_without_storing_raw_prompt() {
        let state = state();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::LocalTime {
                reason: Some("richiesta ora locale".to_string()),
            },
        };
        let mut planner = inert_planner();

        let result = state
            .submit_user_prompt_with_brain_and_planner(
                "computer_active_prompt",
                "che ore sono?",
                &mut brain,
                &mut planner,
            )
            .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();

        assert_eq!(result.user_message.role, "user");
        assert_eq!(result.assistant_message.role, "assistant");
        assert!(result.assistant_message.text.contains("localmente"));
        assert!(
            result
                .computer_session
                .terminal_excerpt_redacted
                .iter()
                .any(|line| line.contains("prompt % date"))
        );
        assert!(!serialized.contains("che ore sono?"));
        assert!(
            result
                .computer_session
                .timeline
                .iter()
                .any(|item| { item.kind == "user_prompt_received" && item.payload_redacted })
        );
    }

    #[test]
    fn submit_user_prompt_answers_simple_arithmetic_locally() {
        let state = state();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::LocalCalculation {
                calculation_left: 6,
                calculation_operator: "*".to_string(),
                calculation_right: 3,
                reason: Some("calcolo locale".to_string()),
            },
        };
        let mut planner = inert_planner();

        let result = state
            .submit_user_prompt_with_brain_and_planner(
                "computer_active_prompt",
                "quanto fa 6*3",
                &mut brain,
                &mut planner,
            )
            .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();

        assert_eq!(result.assistant_message.text, "6 * 3 fa 18.");
        assert!(
            result.computer_session.timeline.iter().any(|item| {
                item.kind == "local_calculation_completed" && item.payload_redacted
            })
        );
        assert!(!serialized.contains("quanto fa 6*3"));
        assert!(!serialized.contains("prompt_pending_brain"));
    }

    #[test]
    fn planning_prompt_enqueues_tasks_and_approval_gate() {
        let state = state();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::NeedsPlanning {
                summary: "Prenotare un treno con conferma prima del pagamento".to_string(),
                reason: Some("Richiede browser e approval".to_string()),
            },
        };
        let mut planner = StaticPlanner { plan: train_plan() };

        let result = state
            .submit_user_prompt_with_brain_and_planner(
                "computer_active_prompt",
                "prenota un treno",
                &mut brain,
                &mut planner,
            )
            .unwrap();
        let serialized = serde_json::to_string(&result).unwrap();
        let snapshot = state.task_queue_snapshot().unwrap();

        assert!(result.plan.is_some());
        assert!(result.assistant_message.text.contains("piano operativo"));
        assert!(
            result
                .computer_session
                .timeline
                .iter()
                .any(|item| item.kind == "operational_plan_created")
        );
        assert!(
            snapshot
                .queued
                .iter()
                .any(|task| task.kind == "browser_automation")
        );
        let detail = state
            .task_detail("browser_computer_active_prompt_search_trains")
            .unwrap()
            .unwrap();
        assert_eq!(
            detail.latest_checkpoint.unwrap()["step"]["target_url_origin"],
            "about:blank"
        );
        assert!(
            snapshot
                .waiting_approvals
                .iter()
                .any(|approval| approval.action == "prompt_plan.approve_step")
        );
        assert!(!serialized.contains("prenota un treno"));
        assert!(!serialized.contains("prompt_pending_brain"));
    }

    #[test]
    fn prompt_plan_executor_runs_first_research_step_and_records_checkpoint() {
        let state = state();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::NeedsPlanning {
                summary: "Prenotare un treno con conferma prima del pagamento".to_string(),
                reason: Some("Richiede browser e approval".to_string()),
            },
        };
        let mut planner = StaticPlanner { plan: train_plan() };
        state
            .submit_user_prompt_with_brain_and_planner(
                "computer_active_prompt",
                "prenota un treno",
                &mut brain,
                &mut planner,
            )
            .unwrap();

        let run = state
            .run_prompt_plan_next_step("computer_active_prompt")
            .unwrap();
        let task_id = "browser_computer_active_prompt_search_trains";
        let detail = state.task_detail(task_id).unwrap().unwrap();
        let computer = state
            .local_computer_session_snapshot("computer_active_prompt")
            .unwrap()
            .unwrap();
        let queue = state.task_queue_snapshot().unwrap();
        let browser_usage = queue
            .resource_usage
            .iter()
            .find(|usage| usage.resource_class == "browser_session")
            .map(|usage| usage.units)
            .unwrap_or_default();
        let serialized = serde_json::to_string(&detail).unwrap();

        assert_eq!(run.status, "completed");
        assert_eq!(run.task_id.as_deref(), Some(task_id));
        assert_eq!(detail.status, "completed");
        let checkpoint = detail.latest_checkpoint.unwrap();
        assert_eq!(checkpoint["browser_task_executor"]["state"], "completed");
        assert_eq!(
            checkpoint["browser_task_executor"]["method"],
            "browser.open"
        );
        assert!(
            checkpoint["browser_task_executor"]["output_keys"]
                .as_array()
                .unwrap()
                .iter()
                .any(|key| key.as_str() == Some("snapshot"))
        );
        assert!(
            checkpoint["browser_task_executor"]["output_keys"]
                .as_array()
                .unwrap()
                .iter()
                .any(|key| key.as_str() == Some("screenshot"))
        );
        assert_eq!(browser_usage, 0);
        assert!(computer.timeline.iter().any(|item| {
            item.kind == "browser_automation_task_completed" && item.payload_redacted
        }));
        assert!(
            computer
                .timeline
                .iter()
                .any(|item| item.kind == "browser_automation_preview_ready")
        );
        assert!(
            computer
                .artifact_refs
                .iter()
                .any(|artifact| artifact.kind == "screenshot" && artifact.preview_ref.is_some())
        );
        assert!(!serialized.contains("prenota un treno"));
    }

    #[test]
    fn prompt_plan_executor_marks_step_waiting_resource_when_browser_is_busy() {
        let state = state();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::NeedsPlanning {
                summary: "Prenotare un treno con conferma prima del pagamento".to_string(),
                reason: Some("Richiede browser e approval".to_string()),
            },
        };
        let mut planner = StaticPlanner { plan: train_plan() };
        state
            .submit_user_prompt_with_brain_and_planner(
                "computer_active_prompt",
                "prenota un treno",
                &mut brain,
                &mut planner,
            )
            .unwrap();
        {
            let store = state.task_store.lock().unwrap();
            let user_id = TaskUserId::new(DEFAULT_USER_ID);
            let workspace_id = TaskWorkspaceId::new(DEFAULT_WORKSPACE_ID);
            let blocker = TaskRecord::new(
                "browser_resource_blocker",
                user_id,
                workspace_id,
                "test.browser_blocker",
                "Occupare browser session",
                serde_json::json!({"payload_redacted": true}),
            )
            .with_resource(ResourceRequirement::new(ResourceClass::BrowserSession, 1));
            store.insert_task(&blocker).unwrap();
            store.reserve_resources(&blocker, "test").unwrap();
        }

        let run = state
            .run_prompt_plan_next_step("computer_active_prompt")
            .unwrap();
        let detail = state
            .task_detail("browser_computer_active_prompt_search_trains")
            .unwrap()
            .unwrap();
        let computer = state
            .local_computer_session_snapshot("computer_active_prompt")
            .unwrap()
            .unwrap();

        assert_eq!(run.status, "waiting_resource");
        assert_eq!(detail.status, "waiting_resource");
        assert!(
            detail
                .blocked_reason
                .unwrap()
                .contains("resource browser_session")
        );
        assert!(computer.timeline.iter().any(|item| {
            item.kind == "browser_automation_waiting_resource" && item.payload_redacted
        }));
    }

    #[test]
    fn prompt_plan_batch_runner_executes_ready_steps_until_idle() {
        let state = state();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::NeedsPlanning {
                summary: "Prenotare un treno con conferma prima del pagamento".to_string(),
                reason: Some("Richiede browser e approval".to_string()),
            },
        };
        let mut planner = StaticPlanner { plan: train_plan() };
        state
            .submit_user_prompt_with_brain_and_planner(
                "computer_active_prompt",
                "prenota un treno",
                &mut brain,
                &mut planner,
            )
            .unwrap();

        let run = state
            .run_prompt_plan_ready_steps("computer_active_prompt", 4)
            .unwrap();
        let queue = state.task_queue_snapshot().unwrap();
        let computer = state
            .local_computer_session_snapshot("computer_active_prompt")
            .unwrap()
            .unwrap();
        let messages = state
            .chat_messages_snapshot("thread_active_prompt")
            .unwrap();

        assert_eq!(run.status, "stopped");
        assert_eq!(run.completed, 2);
        assert_eq!(run.stopped_reason.as_deref(), Some("idle"));
        assert_eq!(run.results.len(), 3);
        assert!(run.results.iter().any(|result| {
            result.task_id.as_deref() == Some("browser_computer_active_prompt_search_trains")
        }));
        assert!(run.results.iter().any(|result| {
            result.task_id.as_deref() == Some("prompt_computer_active_prompt_compare_options")
        }));
        assert!(queue.waiting_approvals.iter().any(|approval| {
            approval.task_id == "prompt_computer_active_prompt_approval_before_payment"
        }));
        assert!(
            computer
                .timeline
                .iter()
                .any(|item| item.kind == "browser_automation_preview_ready")
        );
        assert!(messages.messages.iter().any(|message| {
            message.role == "system" && message.text.contains("Eseguiti 2 step locali")
        }));
    }

    #[test]
    fn local_computer_artifact_preview_returns_redacted_data_url_for_session_artifact() {
        let state = state();
        let preview_path =
            std::env::temp_dir().join(format!("lfpa-preview-{}.png", Uuid::new_v4()));
        std::fs::write(&preview_path, b"\x89PNG\r\n\x1a\n").unwrap();

        {
            let manager = state.local_computer.lock().unwrap();
            manager
                .create_artifact(local_first_local_computer_session::ArtifactCreate {
                    session_id: "computer_active_prompt".to_string(),
                    artifact_id: "preview_test".to_string(),
                    title: "risultati-treni-redatto.png".to_string(),
                    kind: "screenshot".to_string(),
                    path_ref: preview_path.to_string_lossy().to_string(),
                    size_bytes: 8,
                    preview_ref: Some(preview_path.to_string_lossy().to_string()),
                })
                .unwrap();
        }

        let preview = state
            .local_computer_artifact_preview("computer_active_prompt", "preview_test")
            .unwrap()
            .unwrap();

        assert_eq!(preview.artifact_id, "preview_test");
        assert_eq!(preview.kind, "screenshot");
        assert_eq!(preview.size_bytes, 8);
        assert_eq!(preview.title_redacted, "risultati-treni-redatto.png");
        assert!(preview.data_url.starts_with("data:image/png;base64,"));
        assert!(
            !preview
                .data_url
                .contains(preview_path.to_string_lossy().as_ref())
        );

        std::fs::remove_file(preview_path).unwrap();
    }

    #[test]
    fn persistent_desktop_state_restores_threads_tasks_and_computer_sessions() {
        let workspace_root = std::env::temp_dir().join(format!("lfpa-state-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&workspace_root).unwrap();

        let created_thread = {
            let state = DesktopCoreState::seeded(workspace_root.clone()).unwrap();
            let thread = state.create_chat_thread().unwrap();
            let mut brain = StaticBrain {
                understanding: BrainUnderstanding::LocalCalculation {
                    calculation_left: 6,
                    calculation_operator: "*".to_string(),
                    calculation_right: 3,
                    reason: Some("calcolo locale".to_string()),
                },
            };
            let mut planner = inert_planner();
            state
                .submit_user_prompt_with_brain_and_planner(
                    &thread.computer_session_id,
                    "quanto fa 6*3",
                    &mut brain,
                    &mut planner,
                )
                .unwrap();
            thread
        };

        let restored = DesktopCoreState::seeded(workspace_root.clone()).unwrap();
        let threads = restored.chat_thread_snapshot().unwrap();
        let messages = restored
            .chat_messages_snapshot(&created_thread.thread_id)
            .unwrap();
        let queue = restored.task_queue_snapshot().unwrap();
        let computer = restored
            .local_computer_session_snapshot(&created_thread.computer_session_id)
            .unwrap();

        assert_eq!(threads.active_thread_id, created_thread.thread_id);
        assert!(threads.threads.iter().any(|thread| {
            thread.thread_id == created_thread.thread_id
                && thread.computer_session_id == created_thread.computer_session_id
        }));
        assert!(
            messages
                .messages
                .iter()
                .any(|message| message.role == "user" && message.text == "quanto fa 6*3")
        );
        assert!(
            messages
                .messages
                .iter()
                .any(|message| message.role == "assistant" && message.text == "6 * 3 fa 18.")
        );
        assert!(computer.is_some());
        assert!(
            queue
                .active
                .iter()
                .any(|task| task.task_id == "task_prompt_session")
        );

        std::fs::remove_dir_all(workspace_root).unwrap();
    }

    #[test]
    fn persistent_desktop_state_recovers_running_tasks_and_releases_stale_resources() {
        let workspace_root = std::env::temp_dir().join(format!("lfpa-recovery-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&workspace_root).unwrap();
        let task_id = TaskId::new("task_stale_browser");
        let user = TaskUserId::new(DEFAULT_USER_ID);
        let workspace = TaskWorkspaceId::new(DEFAULT_WORKSPACE_ID);

        {
            let state = DesktopCoreState::seeded(workspace_root.clone()).unwrap();
            let store = state.task_store.lock().unwrap();
            let mut task = TaskRecord::new(
                task_id.as_str(),
                user.clone(),
                workspace.clone(),
                "browser_automation",
                "Riprendere task browser dopo riavvio",
                serde_json::json!({ "raw_payload": "redacted" }),
            )
            .with_resource(ResourceRequirement::new(ResourceClass::BrowserSession, 1));
            task.status = TaskStatus::Running;
            task.lease_owner = Some("dead-desktop".to_string());
            store.insert_task(&task).unwrap();
            store.reserve_resources(&task, "dead-desktop").unwrap();
            assert_eq!(
                store
                    .resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                    .unwrap(),
                1
            );
        }

        let restored = DesktopCoreState::seeded(workspace_root.clone()).unwrap();
        let store = restored.task_store.lock().unwrap();
        let recovered = store
            .get_task(&task_id, &user, &workspace)
            .unwrap()
            .unwrap();
        let checkpoint = store
            .latest_checkpoint(&task_id, &user, &workspace)
            .unwrap()
            .unwrap();

        assert_eq!(recovered.status, TaskStatus::Queued);
        assert_eq!(recovered.lease_owner, None);
        assert_eq!(recovered.lease_expires_at, None);
        assert_eq!(recovered.last_heartbeat_at, None);
        assert_eq!(
            recovered.blocked_reason.as_deref(),
            Some("recovered after desktop restart")
        );
        assert_eq!(
            store
                .resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            0
        );
        assert_eq!(
            checkpoint.redacted_payload["desktop_recovery"]["state"],
            "requeued_after_restart"
        );
        assert!(checkpoint.payload["raw_payload"].is_null());

        std::fs::remove_dir_all(workspace_root).unwrap();
    }

    #[test]
    fn persistent_desktop_state_restores_pending_approval_and_allows_approval() {
        let workspace_root = std::env::temp_dir().join(format!("lfpa-approval-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&workspace_root).unwrap();

        let approval_id = {
            let state = DesktopCoreState::seeded(workspace_root.clone()).unwrap();
            state.task_queue_snapshot().unwrap().waiting_approvals[0]
                .approval_id
                .clone()
        };

        let restored = DesktopCoreState::seeded(workspace_root.clone()).unwrap();
        let snapshot = restored.task_queue_snapshot().unwrap();
        assert!(
            snapshot
                .waiting_approvals
                .iter()
                .any(|approval| approval.approval_id == approval_id)
        );

        let approved = restored.approve_task_approval(&approval_id).unwrap();
        assert!(approved.waiting_approvals.is_empty());
        let detail = restored.task_detail("task_acme_summary").unwrap().unwrap();
        assert_eq!(detail.status, "queued");
        assert_eq!(
            detail.latest_checkpoint.unwrap()["approval"]["decision"],
            "approved"
        );

        std::fs::remove_dir_all(workspace_root).unwrap();
    }

    #[test]
    fn prompt_plan_executor_does_not_execute_approval_only_step() {
        let state = state();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::NeedsPlanning {
                summary: "Inviare un messaggio solo dopo conferma".to_string(),
                reason: Some("Richiede approval".to_string()),
            },
        };
        let mut planner = StaticPlanner {
            plan: approval_only_plan(),
        };
        state
            .submit_user_prompt_with_brain_and_planner(
                "computer_active_prompt",
                "invia il messaggio",
                &mut brain,
                &mut planner,
            )
            .unwrap();

        let run = state
            .run_prompt_plan_next_step("computer_active_prompt")
            .unwrap();
        let queue = state.task_queue_snapshot().unwrap();
        let computer = state
            .local_computer_session_snapshot("computer_active_prompt")
            .unwrap()
            .unwrap();

        assert_eq!(run.status, "idle");
        assert!(
            queue.waiting_approvals.iter().any(|approval| {
                approval.task_id == "prompt_computer_active_prompt_confirm_send"
            })
        );
        assert!(
            !computer
                .timeline
                .iter()
                .any(|item| item.kind == "prompt_plan_step_started")
        );
    }

    #[test]
    fn approved_prompt_plan_gate_resumes_and_persists_progress_message() {
        let state = state();
        let mut brain = StaticBrain {
            understanding: BrainUnderstanding::NeedsPlanning {
                summary: "Inviare un messaggio solo dopo conferma".to_string(),
                reason: Some("Richiede approval".to_string()),
            },
        };
        let mut planner = StaticPlanner {
            plan: approval_only_plan(),
        };
        state
            .submit_user_prompt_with_brain_and_planner(
                "computer_active_prompt",
                "invia il messaggio",
                &mut brain,
                &mut planner,
            )
            .unwrap();
        let approval_id = state.task_queue_snapshot().unwrap().waiting_approvals[0]
            .approval_id
            .clone();

        state.approve_task_approval(&approval_id).unwrap();
        let run = state
            .run_prompt_plan_ready_steps("computer_active_prompt", 4)
            .unwrap();
        let queue = state.task_queue_snapshot().unwrap();
        let messages = state
            .chat_messages_snapshot("thread_active_prompt")
            .unwrap();

        assert_eq!(run.completed, 1);
        assert!(
            !queue.waiting_approvals.iter().any(|approval| {
                approval.task_id == "prompt_computer_active_prompt_confirm_send"
            })
        );
        assert!(
            queue
                .active
                .iter()
                .chain(queue.queued.iter())
                .chain(queue.blocked.iter())
                .chain(queue.recent_failures.iter())
                .all(|task| task.task_id != "prompt_computer_active_prompt_confirm_send")
        );
        assert!(queue.recent_failures.is_empty());
        assert!(messages.messages.iter().any(|message| {
            message.role == "system" && message.text.contains("Eseguiti 1 step locali")
        }));
    }
}
