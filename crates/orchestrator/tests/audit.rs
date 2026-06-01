use local_first_capabilities::{
    ActionClass, CapabilityFacade, CapabilityPolicy, CapabilityProviderKind, CapabilityTool,
    FakeCapabilityProvider, InMemoryCapabilityAudit, PolicyContext, ProviderId, UserId,
    WorkspaceId,
};
use local_first_orchestrator::{
    MemoryContextSnippet, OrchestratorAuditStore, OrchestratorBrain, OrchestratorBudgets,
    OrchestratorRequest, OrchestratorUiReadModel, StaticMemoryContextProvider,
    ToolSearchIndexStore,
};
use local_first_subagents::{
    GenerateJsonRequest, GenerateJsonResponse, JsonRuntime, RuntimeClientError, TokenMetrics,
};
use local_first_task_runtime::TaskStore;

#[test]
fn audit_store_persists_brain_run_without_raw_arguments_or_user_message() {
    let runtime = StubRuntime::new(vec![serde_json::json!({
        "route": "capability_call",
        "direct_answer": null,
        "steps": [{
            "step_id": "send_message",
            "kind": "capability_call",
            "depends_on": [],
            "provider_id": "calendar",
            "tool_name": "calendar.send_update",
            "arguments": {"body": "SECRET_BODY_SHOULD_NOT_REACH_UI"},
            "execution_policy": "durable_task",
            "risk_level": "medium",
            "expected_duration_seconds": 2
        }]
    })]);
    let audit_store = OrchestratorAuditStore::open_in_memory().unwrap();
    let mut brain = brain(
        runtime,
        vec![tool(
            "calendar.send_update",
            "Send a calendar message to attendees",
            ActionClass::WriteWithConfirmation,
            CapabilityProviderKind::Native,
        )],
    )
    .with_audit_store(audit_store);

    let outcome = brain
        .run(request("USER_MESSAGE_SHOULD_NOT_REACH_UI"))
        .unwrap();

    assert_eq!(outcome.enqueued_tasks.len(), 1);
    let read_model = OrchestratorUiReadModel::new(brain.audit_store().unwrap());
    let detail = read_model
        .run_detail("req_1", &task_user(), &task_workspace())
        .unwrap()
        .unwrap();

    assert!(!detail.exposes_raw_input);
    assert_eq!(detail.summary.request_id, "req_1");
    assert_eq!(detail.summary.status, "succeeded");
    assert_eq!(detail.summary.enqueued_task_count, 1);
    assert_eq!(detail.plan.steps[0].argument_keys, vec!["body".to_string()]);
    let ui_json = serde_json::to_string(&detail).unwrap();
    assert!(!ui_json.contains("SECRET_BODY_SHOULD_NOT_REACH_UI"));
    assert!(!ui_json.contains("USER_MESSAGE_SHOULD_NOT_REACH_UI"));
}

#[test]
fn audit_store_records_planner_failures_for_ui_diagnostics() {
    let runtime = StubRuntime::invalid("missing route");
    let audit_store = OrchestratorAuditStore::open_in_memory().unwrap();
    let mut brain = brain(runtime, vec![]).with_audit_store(audit_store);

    let error = brain.run(request("raw failure prompt")).unwrap_err();

    assert!(error.to_string().contains("missing route"));
    let read_model = OrchestratorUiReadModel::new(brain.audit_store().unwrap());
    let detail = read_model
        .run_detail("req_1", &task_user(), &task_workspace())
        .unwrap()
        .unwrap();
    assert_eq!(detail.summary.status, "failed");
    assert_eq!(detail.summary.route, "failed");
    assert!(
        detail
            .error_message
            .as_ref()
            .unwrap()
            .contains("missing route")
    );
    let ui_json = serde_json::to_string(&detail).unwrap();
    assert!(!ui_json.contains("raw failure prompt"));
}

#[test]
fn audit_store_exposes_context_budget_without_raw_context() {
    let runtime = StubRuntime::new(vec![serde_json::json!({
        "route": "direct_answer",
        "direct_answer": {
            "answer": "Budget registrato.",
            "reason": "Il contesto e' stato compresso.",
            "confidence": 0.9
        },
        "steps": []
    })]);
    let audit_store = OrchestratorAuditStore::open_in_memory().unwrap();
    let long_memory = MemoryContextSnippet {
        reference: "memory:user:workspace:long".to_string(),
        summary: format!(
            "private recap fabio@example.com {} final useful preference",
            "older context ".repeat(260)
        ),
        privacy_domain: "work".to_string(),
        sensitivity: "private".to_string(),
    };
    let mut brain = brain_with_memory(
        runtime,
        vec![tool(
            "calendar.search",
            &format!(
                "Search calendar access_token=secret-token {}",
                "docs ".repeat(400)
            ),
            ActionClass::Read,
            CapabilityProviderKind::Native,
        )],
        vec![long_memory],
    )
    .with_audit_store(audit_store);

    brain.run(request("usa la memoria")).unwrap();

    let read_model = OrchestratorUiReadModel::new(brain.audit_store().unwrap());
    let detail = read_model
        .run_detail("req_1", &task_user(), &task_workspace())
        .unwrap()
        .unwrap();
    let budget = &detail.context_budget;
    let ui_json = serde_json::to_string(&detail).unwrap();

    assert!(budget.iter().any(|item| item.label == "memory_context"));
    assert!(
        budget
            .iter()
            .any(|item| item.label == "loaded_tool_details" && item.compressed)
    );
    assert!(!ui_json.contains("fabio@example.com"));
    assert!(!ui_json.contains("secret-token"));
}

fn brain(
    runtime: StubRuntime,
    tools: Vec<CapabilityTool>,
) -> OrchestratorBrain<StubRuntime, StaticMemoryContextProvider> {
    brain_with_memory(
        runtime,
        tools,
        vec![MemoryContextSnippet {
            reference: "memory:user:workspace:project".to_string(),
            summary: "User prefers local-first execution.".to_string(),
            privacy_domain: "work".to_string(),
            sensitivity: "private".to_string(),
        }],
    )
}

fn brain_with_memory(
    runtime: StubRuntime,
    tools: Vec<CapabilityTool>,
    memory: Vec<MemoryContextSnippet>,
) -> OrchestratorBrain<StubRuntime, StaticMemoryContextProvider> {
    let mut provider = FakeCapabilityProvider::new(
        ProviderId::new("calendar"),
        CapabilityProviderKind::Native,
        true,
        None,
        tools,
    );
    provider.set_tool_response(
        "calendar.send_update",
        serde_json::json!({"draft_id": "message-1"}),
    );

    let mut facade = CapabilityFacade::new(CapabilityPolicy::new(), InMemoryCapabilityAudit::new());
    facade.register_provider(provider);

    OrchestratorBrain::new(
        runtime,
        StaticMemoryContextProvider::new(memory),
        facade,
        ToolSearchIndexStore::open_in_memory().unwrap(),
        TaskStore::open_in_memory().unwrap(),
    )
}

fn request(message: &str) -> OrchestratorRequest {
    OrchestratorRequest {
        request_id: "req_1".to_string(),
        policy_context: PolicyContext {
            user_id: UserId::new("user"),
            workspace_id: WorkspaceId::new("workspace"),
            enabled_providers: vec![ProviderId::new("calendar")],
            privacy_domains: vec!["work".to_string()],
            allowed_actions: vec![
                ActionClass::Read,
                ActionClass::Draft,
                ActionClass::WriteWithConfirmation,
            ],
            max_autonomy_level: 3,
            allow_managed_cloud: false,
        },
        user_message: message.to_string(),
        conversation_summary: None,
        attachments: vec![],
        budgets: OrchestratorBudgets::default(),
    }
}

fn tool(
    name: &str,
    description: &str,
    action: ActionClass,
    provider_kind: CapabilityProviderKind,
) -> CapabilityTool {
    CapabilityTool {
        name: name.to_string(),
        provider_id: ProviderId::new("calendar"),
        provider_kind,
        action,
        description: description.to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {"body": {"type": "string"}},
            "additionalProperties": true
        }),
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
    valid: bool,
    errors: Vec<String>,
}

impl StubRuntime {
    fn new(responses: Vec<serde_json::Value>) -> Self {
        Self {
            responses: std::sync::Arc::new(std::sync::Mutex::new(responses)),
            valid: true,
            errors: vec![],
        }
    }

    fn invalid(error: &str) -> Self {
        Self {
            responses: std::sync::Arc::new(std::sync::Mutex::new(vec![serde_json::json!({})])),
            valid: false,
            errors: vec![error.to_string()],
        }
    }
}

impl JsonRuntime for StubRuntime {
    fn generate_json(
        &self,
        _request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        Ok(GenerateJsonResponse {
            valid: self.valid,
            errors: self.errors.clone(),
            json: self.responses.lock().unwrap().remove(0),
            raw_output: String::new(),
            repaired: false,
            metrics: TokenMetrics::zero(),
        })
    }
}
