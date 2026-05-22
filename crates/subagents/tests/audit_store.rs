use local_first_subagents::{
    AgentAudit, AgentId, AuditStore, GenerateJsonRequest, GenerateJsonResponse, JsonRuntime,
    PermissionEnvelope, RuntimeClientError, SubagentOrchestrator, SubagentResult, SubagentRunner,
    SubagentStatus, SubagentTask, TaskBudgets, TokenMetrics,
};
use std::cell::RefCell;
use std::collections::VecDeque;

#[test]
fn audit_store_records_subagent_results() {
    let store = AuditStore::open_in_memory().unwrap();
    let result = result("task_1");

    store.record_result(&result).unwrap();

    assert_eq!(store.result_count().unwrap(), 1);
    assert_eq!(store.result_status("task_1").unwrap(), Some("succeeded".to_string()));
}

#[test]
fn orchestrator_records_results_while_running_until_blocked() {
    let store = AuditStore::open_in_memory().unwrap();
    let runner = SubagentRunner::new(
        FakeRuntime {
            responses: RefCell::new(VecDeque::from([valid_response()])),
        },
        "local-model",
    );
    let mut orchestrator = SubagentOrchestrator::new(runner);
    orchestrator.add_task(task("task_1"), vec![]).unwrap();

    let results = orchestrator.run_until_blocked_recording(&store).unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(store.result_count().unwrap(), 1);
    assert_eq!(store.result_status("task_1").unwrap(), Some("succeeded".to_string()));
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

fn task(task_id: &str) -> SubagentTask {
    SubagentTask {
        task_id: task_id.to_string(),
        parent_task_id: None,
        agent_id: AgentId::Planner,
        goal: "Run task".to_string(),
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

fn result(task_id: &str) -> SubagentResult {
    SubagentResult {
        task_id: task_id.to_string(),
        agent_id: AgentId::Planner,
        status: SubagentStatus::Succeeded,
        output: serde_json::json!({"ok": true}),
        errors: vec![],
        metrics: TokenMetrics {
            ..metrics()
        },
        audit: AgentAudit {
            model: "local-model".to_string(),
            contract: "RoutineInference".to_string(),
            started_at: "unix:1".to_string(),
            finished_at: "unix:2".to_string(),
        },
    }
}

fn metrics() -> TokenMetrics {
    TokenMetrics {
        prompt_tokens: 1,
        generation_tokens: 2,
        prompt_tps: 3.0,
        generation_tps: 4.0,
        peak_memory_gb: 5.0,
        elapsed_seconds: 6.0,
    }
}
