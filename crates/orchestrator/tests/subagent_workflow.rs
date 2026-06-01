use local_first_capabilities::{
    CapabilityFacade, CapabilityPolicy, InMemoryCapabilityAudit, PolicyContext, ProviderId, UserId,
    WorkspaceId,
};
use local_first_orchestrator::{
    OrchestratorAuditStore, OrchestratorBrain, OrchestratorBudgets, OrchestratorRequest,
    OrchestratorUiReadModel, StaticMemoryContextProvider, ToolSearchIndexStore,
};
use local_first_subagents::{
    AgentId, GenerateJsonRequest, GenerateJsonResponse, JsonRuntime, RuntimeClientError,
    SubagentTask, TokenMetrics,
};
use local_first_task_runtime::{TaskId, TaskStore};

#[test]
fn brain_materializes_subagent_workflow_as_durable_tasks_with_dependencies() {
    let runtime = StubRuntime::new(vec![serde_json::json!({
        "route": "subagent_workflow",
        "direct_answer": null,
        "steps": [
            {
                "step_id": "plan",
                "kind": "subagent_task",
                "depends_on": [],
                "agent_id": "PlannerAgent",
                "assigned_agent": "ricercatore",
                "goal": "Break down the request into safe local steps",
                "contract": "ExecutionPlan",
                "arguments": {"focus": "local"},
                "execution_policy": "durable_task",
                "risk_level": "low",
                "expected_duration_seconds": 20,
                "allowed_actions": ["read", "draft"],
                "requires_user_approval": false,
                "timeout_seconds": 45,
                "max_tokens": 700
            },
            {
                "step_id": "review",
                "kind": "subagent_task",
                "depends_on": ["plan"],
                "agent_id": "ReviewAgent",
                "goal": "Review the proposed steps before execution",
                "contract": "SubagentReview",
                "arguments": {},
                "execution_policy": "ask_approval",
                "risk_level": "medium",
                "expected_duration_seconds": 15,
                "allowed_actions": ["read"],
                "requires_user_approval": true
            }
        ]
    })]);
    let task_store = TaskStore::open_in_memory().unwrap();
    let audit_store = OrchestratorAuditStore::open_in_memory().unwrap();
    let mut brain = OrchestratorBrain::new(
        runtime,
        StaticMemoryContextProvider::new(vec![]),
        CapabilityFacade::new(CapabilityPolicy::new(), InMemoryCapabilityAudit::new()),
        ToolSearchIndexStore::open_in_memory().unwrap(),
        task_store,
    )
    .with_audit_store(audit_store);

    let outcome = brain.run(request()).unwrap();

    assert!(outcome.enqueued_tasks.is_empty());
    assert_eq!(outcome.enqueued_subagent_tasks.len(), 2);
    assert_eq!(
        outcome.enqueued_subagent_tasks[0].agent_id,
        AgentId::Planner
    );
    assert_eq!(outcome.enqueued_subagent_tasks[1].agent_id, AgentId::Review);

    let plan_task_id = TaskId::new("orchestrator_req_1_plan");
    let review_task_id = TaskId::new("orchestrator_req_1_review");
    let plan_task = brain
        .task_store()
        .get_task(&plan_task_id, &task_user(), &task_workspace())
        .unwrap()
        .unwrap();
    let review_task = brain
        .task_store()
        .get_task(&review_task_id, &task_user(), &task_workspace())
        .unwrap()
        .unwrap();
    assert_eq!(plan_task.kind, "subagent.PlannerAgent");
    assert_eq!(review_task.kind, "subagent.ReviewAgent");
    assert_eq!(review_task.risk_level, "low");
    assert_eq!(
        brain
            .task_store()
            .dependencies_for(&review_task_id, &task_user(), &task_workspace())
            .unwrap(),
        vec![plan_task_id]
    );

    let subagent_task: SubagentTask = serde_json::from_value(plan_task.input_json).unwrap();
    assert_eq!(subagent_task.agent_id, AgentId::Planner);
    assert_eq!(subagent_task.contract, "ExecutionPlan");
    assert_eq!(subagent_task.budgets.timeout_seconds, 45);
    assert_eq!(subagent_task.budgets.max_tokens, 700);
    assert!(subagent_task.input.get("orchestrator").is_some());
    // Phase 3b: the planner's chosen user-agent flows into the task input so the
    // gateway worker runs it on that agent's model + persona.
    assert_eq!(
        subagent_task.input.get("lfpa_agent_id").and_then(|v| v.as_str()),
        Some("ricercatore")
    );

    let read_model = OrchestratorUiReadModel::new(brain.audit_store().unwrap());
    let detail = read_model
        .run_detail("req_1", &task_user(), &task_workspace())
        .unwrap()
        .unwrap();
    assert_eq!(detail.summary.subagent_task_count, 2);
    assert_eq!(detail.subagent_tasks.len(), 2);
    assert!(
        !serde_json::to_string(&detail)
            .unwrap()
            .contains("Break down")
    );
}

fn request() -> OrchestratorRequest {
    OrchestratorRequest {
        request_id: "req_1".to_string(),
        policy_context: PolicyContext {
            user_id: UserId::new("user"),
            workspace_id: WorkspaceId::new("workspace"),
            enabled_providers: vec![ProviderId::new("calendar")],
            privacy_domains: vec!["work".to_string()],
            allowed_actions: vec![
                local_first_capabilities::ActionClass::Read,
                local_first_capabilities::ActionClass::Draft,
            ],
            max_autonomy_level: 2,
            allow_managed_cloud: false,
        },
        user_message: "coordinate a safe local workflow".to_string(),
        conversation_summary: None,
        attachments: vec![],
        budgets: OrchestratorBudgets::default(),
        available_agents: Vec::new(),
    }
}

fn task_user() -> local_first_task_runtime::UserId {
    local_first_task_runtime::UserId::new("user")
}

fn task_workspace() -> local_first_task_runtime::WorkspaceId {
    local_first_task_runtime::WorkspaceId::new("workspace")
}

#[derive(Clone)]
struct StubRuntime {
    responses: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
}

impl StubRuntime {
    fn new(responses: Vec<serde_json::Value>) -> Self {
        Self {
            responses: std::sync::Arc::new(std::sync::Mutex::new(responses)),
        }
    }
}

impl JsonRuntime for StubRuntime {
    fn generate_json(
        &self,
        _request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        Ok(GenerateJsonResponse {
            valid: true,
            errors: vec![],
            json: self.responses.lock().unwrap().remove(0),
            raw_output: String::new(),
            repaired: false,
            metrics: TokenMetrics::zero(),
        })
    }
}
