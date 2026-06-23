use local_first_capabilities::{
    ActionClass, CapabilityFacade, CapabilityPolicy, CapabilityProviderKind, CapabilityTool,
    FakeCapabilityProvider, InMemoryCapabilityAudit, PolicyContext, ProviderId, UserId,
    WorkspaceId,
};
use local_first_orchestrator::{
    ExecutionPlan, MemoryContextSnippet, OrchestratorBrain, OrchestratorBudgets,
    OrchestratorRequest, OrchestratorRoute, PlanStep, PlanStepKind, StaticMemoryContextProvider,
    StepExecutionPolicy, ToolSearchIndexStore,
};
use local_first_subagents::{
    GenerateJsonRequest, GenerateJsonResponse, JsonRuntime, RuntimeClientError, TokenMetrics,
};
use local_first_task_runtime::TaskStore;

#[test]
fn brain_returns_direct_answer_without_creating_tasks_or_loading_tool_schemas() {
    let runtime = StubRuntime::new(vec![serde_json::json!({
        "route": "direct_answer",
        "direct_answer": {
            "answer": "Puoi rispondere direttamente.",
            "reason": "La richiesta non richiede tool.",
            "confidence": 0.91
        },
        "steps": []
    })]);
    let mut brain = brain(runtime, vec![]);
    let request = request("Che cosa abbiamo deciso finora?");

    let outcome = brain.run(request).unwrap();

    assert_eq!(outcome.plan.route, OrchestratorRoute::DirectAnswer);
    assert_eq!(
        outcome.direct_answer.unwrap().answer,
        "Puoi rispondere direttamente."
    );
    assert!(outcome.loaded_tools.is_empty());
    assert!(outcome.immediate_results.is_empty());
    assert!(outcome.enqueued_tasks.is_empty());
    assert!(
        brain
            .task_store()
            .list_tasks(&task_user(), &task_workspace())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn plan_only_returns_plan_without_materializing_tasks() {
    let runtime = StubRuntime::new(vec![serde_json::json!({
        "route": "direct_answer",
        "direct_answer": {
            "answer": "Risposta diretta.",
            "reason": "Nessun tool necessario.",
            "confidence": 0.9
        },
        "steps": []
    })]);
    let mut brain = brain(runtime, vec![]);

    let plan = brain.plan_only(&request("Che ore sono a Roma?")).unwrap();

    assert_eq!(plan.route, OrchestratorRoute::DirectAnswer);
    // plan_only must have NO side effects: no durable tasks created.
    assert!(
        brain
            .task_store()
            .list_tasks(&task_user(), &task_workspace())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn planner_accepts_plan_without_steps_key() {
    // Regression: reasoning models often omit the empty "steps" array on a
    // direct_answer plan. That must NOT hard-fail (it did: "missing required
    // keys: steps" → Brain fell back to the legacy keyword path). "steps" is
    // optional and defaults to []; only "route" is required.
    let runtime = StubRuntime::new(vec![serde_json::json!({
        "route": "direct_answer",
        "direct_answer": {
            "answer": "Risposta diretta.",
            "reason": "Nessun tool necessario.",
            "confidence": 0.9
        }
        // NOTE: no "steps" key on purpose.
    })]);
    let mut brain = brain(runtime, vec![]);

    let plan = brain.plan_only(&request("Che ore sono a Roma?")).unwrap();

    assert_eq!(plan.route, OrchestratorRoute::DirectAnswer);
    assert!(plan.steps.is_empty());
    // The planner request must not mark "steps" as required.
    let required = brain.runtime().requests()[0].required_keys.clone();
    assert!(required.contains(&"route".to_string()));
    assert!(!required.contains(&"steps".to_string()));
}

#[test]
fn brain_uses_lazy_tool_details_when_tool_catalog_is_large() {
    let runtime = StubRuntime::new(vec![serde_json::json!({
        "route": "direct_answer",
        "direct_answer": {
            "answer": "Uso il calendario.",
            "reason": "Il catalogo e' stato ridotto.",
            "confidence": 0.8
        },
        "steps": []
    })]);
    let mut tools = Vec::new();
    for index in 0..12 {
        tools.push(tool(
            &format!("generic.tool_{index}"),
            "Generic unrelated background tool",
            ActionClass::Read,
            CapabilityProviderKind::Native,
        ));
    }
    tools.push(tool(
        "calendar.search",
        "Search calendar events by title, attendee, date or keyword",
        ActionClass::Read,
        CapabilityProviderKind::Native,
    ));
    let mut brain = brain(runtime, tools);

    let outcome = brain.run(request("Cerca standup nel calendario")).unwrap();

    assert_eq!(outcome.loaded_tools.len(), 5);
    assert!(
        outcome
            .loaded_tools
            .iter()
            .any(|tool| tool.tool_name == "calendar.search")
    );
    let prompt = brain.runtime().requests()[0].prompt.clone();
    assert!(prompt.contains("Tool catalog compact cards"));
    assert!(prompt.contains("Loaded tool details"));
}

#[test]
fn brain_compresses_memory_and_tool_context_before_planner_prompt() {
    let runtime = StubRuntime::new(vec![serde_json::json!({
        "route": "direct_answer",
        "direct_answer": {
            "answer": "Contesto ricevuto in forma compressa.",
            "reason": "Il prompt resta nel budget.",
            "confidence": 0.8
        },
        "steps": []
    })]);
    let mut tools = Vec::new();
    for index in 0..8 {
        tools.push(tool(
            &format!("calendar.long_tool_{index}"),
            &format!(
                "Search calendar records with repeated docs {} access_token=secret-token {}",
                index,
                "very long tool description ".repeat(80)
            ),
            ActionClass::Read,
            CapabilityProviderKind::Native,
        ));
    }
    let long_memory = MemoryContextSnippet {
        reference: "memory:user:workspace:long".to_string(),
        summary: format!(
            "User private recap fabio@example.com {} final useful preference: local-first",
            "older noisy memory ".repeat(260)
        ),
        privacy_domain: "work".to_string(),
        sensitivity: "private".to_string(),
    };
    let mut brain = brain_with_memory(runtime, tools, vec![long_memory]);

    let outcome = brain
        .run(request("Usa il contesto disponibile per rispondere"))
        .unwrap();

    let prompt = brain.runtime().requests()[0].prompt.clone();
    assert!(prompt.contains("context compressed"));
    assert!(prompt.contains("final useful preference"));
    assert!(!prompt.contains("fabio@example.com"));
    assert!(!prompt.contains("secret-token"));
    // Bound = compressed variable context + the fixed OUTPUT FORMAT preamble
    // (an explicit schema example, ~1.2k chars, that makes models emit the
    // correct {route, steps} shape even without server-side schema enforcement).
    assert!(prompt.chars().count() < 10_500);
    assert!(
        outcome
            .audit
            .context_budget
            .iter()
            .any(|item| item.label == "memory_context" && item.compressed)
    );
    assert!(
        outcome
            .audit
            .context_budget
            .iter()
            .any(|item| item.label == "loaded_tool_details" && item.redaction_count > 0)
    );
}

#[test]
fn brain_validates_second_planner_round_against_retry_loaded_tools() {
    let runtime = StubRuntime::new(vec![
        serde_json::json!({
            "route": "needs_more_tools",
            "direct_answer": null,
            "steps": [],
            "needs_more_tools": {"query": "github issue"}
        }),
        serde_json::json!({
            "route": "capability_call",
            "direct_answer": null,
            "steps": [{
                "step_id": "draft_issue",
                "kind": "capability_call",
                "depends_on": [],
                "provider_id": "calendar",
                "tool_name": "github.issue_create",
                "arguments": {"query": "bug"},
                "execution_policy": "immediate",
                "risk_level": "low",
                "expected_duration_seconds": 5
            }]
        }),
    ]);
    let mut tools = Vec::new();
    for index in 0..12 {
        tools.push(tool(
            &format!("alpha.tool_{index}"),
            "Generic unrelated background tool",
            ActionClass::Read,
            CapabilityProviderKind::Native,
        ));
    }
    tools.push(tool(
        "github.issue_create",
        "Create a GitHub issue draft from a local summary",
        ActionClass::Draft,
        CapabilityProviderKind::Native,
    ));
    let mut brain = brain(runtime, tools);

    let outcome = brain.run(request("prepara una bozza")).unwrap();

    assert_eq!(outcome.audit.planner_rounds, 2);
    assert!(
        outcome
            .loaded_tools
            .iter()
            .any(|tool| tool.tool_name == "github.issue_create")
    );
    assert_eq!(
        outcome.immediate_results[0].tool_name,
        "github.issue_create"
    );
}

#[test]
fn brain_executes_read_and_draft_steps_immediately_but_queues_write_steps() {
    let runtime = StubRuntime::new(vec![serde_json::json!({
        "route": "mixed_workflow",
        "direct_answer": null,
        "steps": [
            {
                "step_id": "read_calendar",
                "kind": "capability_call",
                "depends_on": [],
                "provider_id": "calendar",
                "tool_name": "calendar.search",
                "arguments": {"query": "standup"},
                "execution_policy": "immediate",
                "risk_level": "low",
                "expected_duration_seconds": 2
            },
            {
                "step_id": "send_message",
                "kind": "capability_call",
                "depends_on": ["read_calendar"],
                "provider_id": "calendar",
                "tool_name": "calendar.send_update",
                "arguments": {"body": "Confermato"},
                "execution_policy": "immediate",
                "risk_level": "medium",
                "expected_duration_seconds": 2
            }
        ]
    })]);
    let mut brain = brain(
        runtime,
        vec![
            tool(
                "calendar.search",
                "Search calendar events",
                ActionClass::Read,
                CapabilityProviderKind::Native,
            ),
            tool(
                "calendar.send_update",
                "Send a calendar message to attendees",
                ActionClass::WriteWithConfirmation,
                CapabilityProviderKind::Native,
            ),
        ],
    );

    let outcome = brain
        .run(request("Cerca lo standup e avvisa i partecipanti"))
        .unwrap();

    assert_eq!(outcome.immediate_results.len(), 1);
    assert_eq!(outcome.immediate_results[0].tool_name, "calendar.search");
    assert_eq!(outcome.enqueued_tasks.len(), 1);
    assert_eq!(outcome.enqueued_tasks[0].step_id, "send_message");

    let tasks = brain
        .task_store()
        .list_tasks(&task_user(), &task_workspace())
        .unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].kind, "capability.calendar.calendar.send_update");
    assert_eq!(tasks[0].risk_level, "medium");
}

#[test]
fn brain_runs_static_execution_plan_without_planner_roundtrip() {
    let runtime = StubRuntime::new(vec![]);
    let mut brain = brain(
        runtime,
        vec![
            tool(
                "calendar.search",
                "Search calendar events",
                ActionClass::Read,
                CapabilityProviderKind::Native,
            ),
            tool(
                "calendar.send_update",
                "Send a calendar message to attendees",
                ActionClass::WriteWithConfirmation,
                CapabilityProviderKind::Native,
            ),
        ],
    );
    let plan = ExecutionPlan {
        route: OrchestratorRoute::MixedWorkflow,
        direct_answer: None,
        plan_propose: None,
        steps: vec![
            PlanStep {
                step_id: "read_calendar".to_string(),
                kind: PlanStepKind::CapabilityCall,
                depends_on: vec![],
                provider_id: Some("calendar".to_string()),
                tool_name: Some("calendar.search".to_string()),
                arguments: serde_json::json!({"query": "standup"}),
                execution_policy: StepExecutionPolicy::Immediate,
                risk_level: "low".to_string(),
                expected_duration_seconds: 2,
                agent_id: None,
                goal: None,
                contract: None,
                allowed_actions: vec![],
                requires_user_approval: None,
                timeout_seconds: None,
                max_tokens: None,
            },
            PlanStep {
                step_id: "send_message".to_string(),
                kind: PlanStepKind::CapabilityCall,
                depends_on: vec!["read_calendar".to_string()],
                provider_id: Some("calendar".to_string()),
                tool_name: Some("calendar.send_update".to_string()),
                arguments: serde_json::json!({"body": "Confermato"}),
                execution_policy: StepExecutionPolicy::Immediate,
                risk_level: "medium".to_string(),
                expected_duration_seconds: 2,
                agent_id: None,
                goal: None,
                contract: None,
                allowed_actions: vec![],
                requires_user_approval: None,
                timeout_seconds: None,
                max_tokens: None,
            },
        ],
        needs_more_tools: None,
    };

    let outcome = brain
        .run_plan(request("workflow dichiarativo"), plan)
        .unwrap();

    assert!(brain.runtime().requests().is_empty(), "planner must not be called");
    assert_eq!(outcome.audit.planner_rounds, 0);
    assert_eq!(outcome.immediate_results.len(), 1);
    assert_eq!(outcome.enqueued_tasks.len(), 1);
    assert_eq!(outcome.enqueued_tasks[0].step_id, "send_message");
}

#[test]
fn brain_queues_browser_actions_even_when_the_planner_marks_them_immediate() {
    let runtime = StubRuntime::new(vec![serde_json::json!({
        "route": "capability_call",
        "direct_answer": null,
        "steps": [{
            "step_id": "browser_act",
            "kind": "capability_call",
            "depends_on": [],
            "provider_id": "browser",
            "tool_name": "browser.act",
            "arguments": {"ref": "button:submit", "action": "click"},
            "execution_policy": "immediate",
            "risk_level": "medium",
            "expected_duration_seconds": 3
        }]
    })]);
    let mut brain = brain(
        runtime,
        vec![tool(
            "browser.act",
            "Act on a browser snapshot ref",
            ActionClass::WriteWithConfirmation,
            CapabilityProviderKind::Browser,
        )],
    );

    let outcome = brain
        .run(request("Clicca il pulsante submit nel browser"))
        .unwrap();

    assert!(outcome.immediate_results.is_empty());
    assert_eq!(outcome.enqueued_tasks.len(), 1);
    assert_eq!(outcome.enqueued_tasks[0].tool_name, "browser.act");
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
        tools.clone(),
    );
    provider.set_tool_response(
        "calendar.search",
        serde_json::json!({"events": ["standup"]}),
    );
    let mut browser_provider = FakeCapabilityProvider::new(
        ProviderId::new("browser"),
        CapabilityProviderKind::Browser,
        true,
        None,
        tools,
    );
    browser_provider.set_tool_response("browser.snapshot", serde_json::json!({"ok": true}));

    let mut facade = CapabilityFacade::new(CapabilityPolicy::new(), InMemoryCapabilityAudit::new());
    facade.register_provider(provider);
    facade.register_provider(browser_provider);

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
            enabled_providers: vec![ProviderId::new("calendar"), ProviderId::new("browser")],
            privacy_domains: vec!["work".to_string(), "browser".to_string()],
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
        budgets: OrchestratorBudgets {
            max_loaded_tools: 5,
            max_tool_search_rounds: 1,
            max_steps: 8,
            max_planner_tokens: 768,
            max_conversation_summary_chars: 1_200,
            max_memory_context_chars: 2_000,
            max_tool_cards_context_chars: 2_400,
            max_loaded_tool_context_chars: 3_200,
            planner_timeout_seconds: 30,
        },
        language: "en".to_string(),
    }
}

fn tool(
    name: &str,
    description: &str,
    action: ActionClass,
    provider_kind: CapabilityProviderKind,
) -> CapabilityTool {
    let provider_id = if provider_kind == CapabilityProviderKind::Browser {
        ProviderId::new("browser")
    } else {
        ProviderId::new("calendar")
    };
    CapabilityTool {
        name: name.to_string(),
        provider_id,
        provider_kind,
        action,
        description: description.to_string(),
        privacy_domains: vec![if provider_kind == CapabilityProviderKind::Browser {
            "browser".to_string()
        } else {
            "work".to_string()
        }],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {"query": {"type": "string"}, "body": {"type": "string"}},
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
    requests: std::sync::Arc<std::sync::Mutex<Vec<GenerateJsonRequest>>>,
}

impl StubRuntime {
    fn new(responses: Vec<serde_json::Value>) -> Self {
        Self {
            responses: std::sync::Arc::new(std::sync::Mutex::new(responses)),
            requests: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    fn requests(&self) -> Vec<GenerateJsonRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl JsonRuntime for StubRuntime {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        self.requests.lock().unwrap().push(request.clone());
        let json = self.responses.lock().unwrap().remove(0);
        Ok(GenerateJsonResponse {
            valid: true,
            errors: vec![],
            json,
            raw_output: String::new(),
            repaired: false,
            metrics: TokenMetrics::zero(),
        })
    }
}
