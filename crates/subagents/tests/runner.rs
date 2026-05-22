use std::cell::RefCell;

use local_first_subagents::{
    AgentId, GenerateJsonRequest, GenerateJsonResponse, JsonRuntime, PermissionEnvelope,
    RuntimeClientError, SubagentRunner, SubagentStatus, SubagentTask, TaskBudgets, TokenMetrics,
};

struct FakeRuntime {
    requests: RefCell<Vec<GenerateJsonRequest>>,
    response: GenerateJsonResponse,
}

impl JsonRuntime for FakeRuntime {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        self.requests.borrow_mut().push(request.clone());
        Ok(self.response.clone())
    }
}

#[test]
fn runner_rejects_invalid_permissions_without_calling_runtime() {
    let runtime = FakeRuntime {
        requests: RefCell::new(vec![]),
        response: valid_response(),
    };
    let runner = SubagentRunner::new(runtime, "local-model");
    let mut task = task();
    task.permission_envelope.max_autonomy_level = 1;

    let result = runner.run_generate_json(&task);

    assert_eq!(result.status, SubagentStatus::Failed);
    assert_eq!(
        result.errors,
        vec!["action write_with_confirmation requires autonomy level 3, task allows 1"]
    );
    assert_eq!(runner.runtime().requests.borrow().len(), 0);
}

#[test]
fn runner_maps_runtime_response_to_subagent_result() {
    let runtime = FakeRuntime {
        requests: RefCell::new(vec![]),
        response: valid_response(),
    };
    let runner = SubagentRunner::new(runtime, "local-model");
    let task = task();

    let result = runner.run_generate_json(&task);

    assert_eq!(result.status, SubagentStatus::Succeeded);
    assert_eq!(result.output["ok"], true);
    assert_eq!(result.metrics.generation_tokens, 2);
    assert_eq!(result.audit.model, "local-model");
    assert_eq!(result.audit.contract, "RoutineInference");

    let requests = runner.runtime().requests.borrow();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].prompt, "Infer routine");
    assert_eq!(requests[0].max_tokens, 128);
    assert_eq!(requests[0].required_keys, vec!["ok"]);
}

fn task() -> SubagentTask {
    SubagentTask {
        task_id: "task_1".to_string(),
        parent_task_id: None,
        agent_id: AgentId::Planner,
        goal: "Infer routine fallback".to_string(),
        input: serde_json::json!({
            "prompt": "Infer routine",
            "required_keys": ["ok"]
        }),
        contract: "RoutineInference".to_string(),
        permission_envelope: PermissionEnvelope {
            connectors: vec![],
            max_autonomy_level: 3,
            allowed_actions: vec![local_first_subagents::AllowedAction::WriteWithConfirmation],
            requires_user_approval: true,
        },
        budgets: TaskBudgets {
            timeout_seconds: 30,
            max_tokens: 128,
        },
    }
}

fn valid_response() -> GenerateJsonResponse {
    GenerateJsonResponse {
        valid: true,
        errors: vec![],
        json: serde_json::json!({"ok": true}),
        raw_output: "{\"ok\": true}".to_string(),
        repaired: false,
        metrics: TokenMetrics {
            prompt_tokens: 1,
            generation_tokens: 2,
            prompt_tps: 3.0,
            generation_tps: 4.0,
            peak_memory_gb: 5.0,
            elapsed_seconds: 6.0,
        },
    }
}
