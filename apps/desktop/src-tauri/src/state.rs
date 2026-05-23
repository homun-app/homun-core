use crate::local_computer_smoke;
use crate::models::{
    BridgeStatus, CapabilityPolicySummary, CapabilitySnapshot, DesktopTaskDetail,
    DesktopTaskQueueSnapshot, RuntimeHealthSnapshot, RuntimeProcessItem,
    capability_connection_item, capability_tool_item, component, desktop_task_detail,
    desktop_task_queue, runtime_process_item, runtime_process_item_with_snapshot,
};
use crate::prompt_submission::{
    self, PromptBrain, PromptExecutionPlan, PromptSubmissionResult, PromptTaskPlanner,
    RuntimePromptBrain, RuntimePromptTaskPlanner,
};
use crate::seed::{seed_capabilities, seed_memories, seed_tasks};
use local_first_capabilities::{
    CapabilityRegistryStore, ProviderId, UserId as CapabilityUserId,
    WorkspaceId as CapabilityWorkspaceId,
};
use local_first_local_computer_session::{
    ComputerEventCreate, ComputerSessionCreate, ComputerSessionSnapshot,
    LocalComputerSessionManager, LocalComputerSessionStore, SurfaceKind,
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
    ApprovalGate, ResourceClass, ResourceRequirement, TaskRecord, TaskStore, TaskUiReadModel,
    UserId as TaskUserId, WorkspaceId as TaskWorkspaceId,
};
use std::path::PathBuf;
use std::sync::Mutex;

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
    brain_runtime_url: String,
}

impl DesktopCoreState {
    pub fn seeded(workspace_root: PathBuf) -> Result<Self, String> {
        let task_store = TaskStore::open_in_memory().map_err(to_string_error)?;
        seed_tasks(&task_store).map_err(to_string_error)?;

        let memory_facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory()?);
        seed_memories(&memory_facade)?;

        let process_store = ProcessRegistryStore::open_in_memory().map_err(to_string_error)?;
        let sidecar_catalog = SidecarProcessCatalog::new(&workspace_root);
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
        Ok(result)
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
        session_id: "computer_active_prompt".to_string(),
        task_id: "task_prompt_session".to_string(),
        workflow_id: None,
        user_id: DEFAULT_USER_ID.to_string(),
        workspace_id: DEFAULT_WORKSPACE_ID.to_string(),
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
                },
                PromptPlanStep {
                    step_id: "compare_options".to_string(),
                    title: "Confrontare opzioni".to_string(),
                    detail: "Preparare una shortlist redatta con orari e vincoli.".to_string(),
                    surface: "browser".to_string(),
                    action_kind: "compare_options".to_string(),
                    requires_user_approval: false,
                },
                PromptPlanStep {
                    step_id: "approval_before_payment".to_string(),
                    title: "Conferma prima del pagamento".to_string(),
                    detail: "Bloccare login, acquisto o pagamento senza conferma esplicita."
                        .to_string(),
                    surface: "logs".to_string(),
                    action_kind: "approval_gate".to_string(),
                    requires_user_approval: true,
                },
            ],
        }
    }

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
        assert!(snapshot.progress_current >= 2);
        assert!(!serialized.contains("raw_payload"));
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
                .any(|task| task.kind == "prompt_plan.research")
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
}
