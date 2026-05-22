use std::cell::RefCell;
use std::collections::VecDeque;

use local_first_subagents::{
    AgentId, GenerateJsonRequest, GenerateJsonResponse, JsonRuntime, PermissionEnvelope,
    RuntimeClientError, SubagentOrchestrator, SubagentRunner, SubagentStatus, SubagentTask,
    TaskBudgets, TaskState, TokenMetrics,
};

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

#[test]
fn orchestrator_runs_ready_tasks_and_unblocks_dependents() {
    let runner = SubagentRunner::new(
        FakeRuntime {
            responses: RefCell::new(VecDeque::from([valid_response(), valid_response()])),
        },
        "local-model",
    );
    let mut orchestrator = SubagentOrchestrator::new(runner);

    orchestrator.add_task(task("plan", AgentId::Planner), vec![]).unwrap();
    orchestrator
        .add_task(task("risk", AgentId::Risk), vec!["plan".to_string()])
        .unwrap();

    let first = orchestrator.run_ready_once();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].task_id, "plan");
    assert_eq!(orchestrator.state("plan"), Some(&TaskState::Succeeded));
    assert_eq!(orchestrator.state("risk"), Some(&TaskState::Pending));

    let second = orchestrator.run_ready_once();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].task_id, "risk");
    assert_eq!(orchestrator.state("risk"), Some(&TaskState::Succeeded));
}

#[test]
fn orchestrator_marks_failed_tasks_and_leaves_dependents_blocked() {
    let runner = SubagentRunner::new(
        FakeRuntime {
            responses: RefCell::new(VecDeque::from([invalid_response()])),
        },
        "local-model",
    );
    let mut orchestrator = SubagentOrchestrator::new(runner);

    orchestrator.add_task(task("plan", AgentId::Planner), vec![]).unwrap();
    orchestrator
        .add_task(task("risk", AgentId::Risk), vec!["plan".to_string()])
        .unwrap();

    let results = orchestrator.run_ready_once();

    assert_eq!(results[0].status, SubagentStatus::Failed);
    assert_eq!(orchestrator.state("plan"), Some(&TaskState::Failed));
    assert_eq!(orchestrator.blocked_task_ids(), vec!["risk"]);
}

fn task(task_id: &str, agent_id: AgentId) -> SubagentTask {
    SubagentTask {
        task_id: task_id.to_string(),
        parent_task_id: None,
        agent_id,
        goal: format!("Run {task_id}"),
        input: serde_json::json!({"prompt": "Return JSON", "required_keys": ["ok"]}),
        contract: "TestContract".to_string(),
        permission_envelope: PermissionEnvelope {
            connectors: vec![],
            max_autonomy_level: 2,
            allowed_actions: vec![local_first_subagents::AllowedAction::Draft],
            requires_user_approval: true,
        },
        budgets: TaskBudgets {
            timeout_seconds: 30,
            max_tokens: 64,
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
