use std::cell::RefCell;
use std::collections::VecDeque;

use local_first_subagents::{
    AgentId, AllowedAction, GenerateJsonRequest, GenerateJsonResponse, JsonRuntime,
    PermissionEnvelope, RuntimeClientError, SubagentTaskExecutor, SubagentTaskRuntimeBridge,
    TaskBudgets, TokenMetrics, WorkflowTaskSpec,
};
use local_first_task_runtime::{
    ResourceClass, ResourceLimits, TaskId, TaskRuntime, TaskStatus, TaskStore, UserId, WorkflowId,
    WorkspaceId,
};
use serde_json::json;

#[test]
fn bridge_enqueues_workflow_tasks_with_dependencies_and_llm_resource() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let workflow = WorkflowId::new("workflow_1");
    let specs = vec![
        WorkflowTaskSpec {
            task: subagent_task("plan", AgentId::Planner),
            depends_on: vec![],
        },
        WorkflowTaskSpec {
            task: subagent_task("risk", AgentId::Risk),
            depends_on: vec!["plan".to_string()],
        },
    ];

    let enqueued = SubagentTaskRuntimeBridge::new()
        .enqueue_workflow(&store, &user, &workspace, &workflow, &specs)
        .unwrap();

    assert_eq!(
        enqueued.task_ids,
        vec![TaskId::new("plan"), TaskId::new("risk")]
    );
    let plan = store
        .get_task(&TaskId::new("plan"), &user, &workspace)
        .unwrap()
        .unwrap();
    let risk = store
        .get_task(&TaskId::new("risk"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(plan.workflow_id, Some(workflow.clone()));
    assert_eq!(plan.kind, "subagent.PlannerAgent");
    assert_eq!(plan.status, TaskStatus::Queued);
    assert_eq!(
        plan.resource_requirements[0].class,
        ResourceClass::LlmInference
    );
    assert_eq!(plan.resource_requirements[0].units, 1);
    assert_eq!(plan.permission_context["max_autonomy_level"], 2);
    assert_eq!(plan.input_json["task_id"], "plan");
    assert_eq!(risk.workflow_id, Some(workflow));
    assert_eq!(
        store
            .dependencies_for(&TaskId::new("risk"), &user, &workspace)
            .unwrap(),
        vec![TaskId::new("plan")]
    );
}

#[test]
fn subagent_task_executor_completes_successful_durable_task() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let workflow = WorkflowId::new("workflow_1");
    let specs = vec![WorkflowTaskSpec {
        task: subagent_task("plan", AgentId::Planner),
        depends_on: vec![],
    }];
    SubagentTaskRuntimeBridge::new()
        .enqueue_workflow(&store, &user, &workspace, &workflow, &specs)
        .unwrap();
    let executor = SubagentTaskExecutor::new(FakeRuntime {
        responses: RefCell::new(VecDeque::from([valid_response()])),
    });
    let mut runtime = TaskRuntime::new(
        store,
        Box::new(executor),
        ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1),
        "worker_a",
    );

    let summary = runtime
        .run_ready_once(&user, &workspace, time::OffsetDateTime::now_utc())
        .unwrap();
    let task = runtime
        .store()
        .get_task(&TaskId::new("plan"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(summary.completed, 1);
    assert_eq!(task.status, TaskStatus::Completed);
}

#[test]
fn subagent_task_executor_maps_failed_result_to_retryable_task_failure() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let workflow = WorkflowId::new("workflow_1");
    let specs = vec![WorkflowTaskSpec {
        task: subagent_task("plan", AgentId::Planner),
        depends_on: vec![],
    }];
    SubagentTaskRuntimeBridge::new()
        .enqueue_workflow(&store, &user, &workspace, &workflow, &specs)
        .unwrap();
    let executor = SubagentTaskExecutor::new(FakeRuntime {
        responses: RefCell::new(VecDeque::from([invalid_response()])),
    });
    let mut runtime = TaskRuntime::new(
        store,
        Box::new(executor),
        ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1),
        "worker_a",
    );

    let summary = runtime
        .run_ready_once(&user, &workspace, time::OffsetDateTime::now_utc())
        .unwrap();
    let task = runtime
        .store()
        .get_task(&TaskId::new("plan"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(summary.failed_retryable, 1);
    assert_eq!(task.status, TaskStatus::WaitingTime);
    assert_eq!(task.attempt_count, 1);
    assert_eq!(
        task.blocked_reason.as_deref(),
        Some("missing required key: ok")
    );
}

fn subagent_task(task_id: &str, agent_id: AgentId) -> local_first_subagents::SubagentTask {
    local_first_subagents::SubagentTask {
        task_id: task_id.to_string(),
        parent_task_id: None,
        agent_id,
        goal: format!("Run {task_id}"),
        input: json!({"prompt": "Return JSON", "required_keys": ["ok"]}),
        contract: "TestContract".to_string(),
        permission_envelope: PermissionEnvelope {
            connectors: vec!["local".to_string()],
            max_autonomy_level: 2,
            allowed_actions: vec![AllowedAction::Draft],
            requires_user_approval: false,
        },
        budgets: TaskBudgets {
            timeout_seconds: 30,
            max_tokens: 64,
        },
    }
}

struct FakeRuntime {
    responses: RefCell<VecDeque<GenerateJsonResponse>>,
}

impl JsonRuntime for FakeRuntime {
    fn generate_json(
        &self,
        _request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        Ok(self.responses.borrow_mut().pop_front().unwrap())
    }
}

fn valid_response() -> GenerateJsonResponse {
    GenerateJsonResponse {
        valid: true,
        errors: vec![],
        json: json!({"ok": true}),
        raw_output: "{\"ok\": true}".to_string(),
        repaired: false,
        metrics: metrics(),
    }
}

fn invalid_response() -> GenerateJsonResponse {
    GenerateJsonResponse {
        valid: false,
        errors: vec!["missing required key: ok".to_string()],
        json: serde_json::Value::Null,
        raw_output: "{}".to_string(),
        repaired: false,
        metrics: metrics(),
    }
}

fn metrics() -> TokenMetrics {
    TokenMetrics {
        prompt_tokens: 1,
        generation_tokens: 1,
        prompt_tps: 1.0,
        generation_tps: 1.0,
        peak_memory_gb: 1.0,
        elapsed_seconds: 1.0,
    }
}
