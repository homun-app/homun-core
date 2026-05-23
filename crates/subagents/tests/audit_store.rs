use local_first_subagents::{
    AgentAudit, AgentId, AuditStore, GenerateJsonRequest, GenerateJsonResponse, JsonRuntime,
    PermissionEnvelope, RiskLevel, RuntimeClientError, SubagentOrchestrator, SubagentResult,
    SubagentReview, SubagentRunner, SubagentStatus, SubagentTask, TaskBudgets, TokenMetrics,
};
use std::cell::RefCell;
use std::collections::VecDeque;

#[test]
fn audit_store_records_subagent_results() {
    let store = AuditStore::open_in_memory().unwrap();
    let result = result("task_1");

    store.record_result(&result).unwrap();

    assert_eq!(store.result_count().unwrap(), 1);
    assert_eq!(
        store.result_status("task_1").unwrap(),
        Some("succeeded".to_string())
    );
}

#[test]
fn audit_store_returns_latest_result_for_task() {
    let store = AuditStore::open_in_memory().unwrap();
    store.record_result(&result("task_1")).unwrap();
    store
        .record_result(&failed_result("task_1", "schema mismatch"))
        .unwrap();

    let latest = store.latest_result("task_1").unwrap().unwrap();

    assert_eq!(latest.task_id, "task_1");
    assert_eq!(latest.status, SubagentStatus::Failed);
    assert_eq!(latest.errors, vec!["schema mismatch"]);
}

#[test]
fn audit_store_filters_recent_results_by_status() {
    let store = AuditStore::open_in_memory().unwrap();
    store
        .record_result(&failed_result("task_1", "first failure"))
        .unwrap();
    store.record_result(&result("task_2")).unwrap();
    store
        .record_result(&failed_result("task_3", "second failure"))
        .unwrap();

    let failed = store
        .recent_results_by_status(SubagentStatus::Failed, 10)
        .unwrap();

    assert_eq!(failed.len(), 2);
    assert_eq!(failed[0].task_id, "task_3");
    assert_eq!(failed[1].task_id, "task_1");
}

#[test]
fn audit_store_records_and_returns_latest_subagent_review() {
    let store = AuditStore::open_in_memory().unwrap();
    store.record_review(&review("task_1", true)).unwrap();
    store.record_review(&review("task_1", false)).unwrap();

    let latest = store.latest_review("task_1").unwrap().unwrap();

    assert_eq!(store.review_count().unwrap(), 2);
    assert_eq!(latest.task_id, "task_1");
    assert_eq!(latest.reviewer_agent_id, AgentId::Review);
    assert!(!latest.approved);
    assert_eq!(latest.risk_level, RiskLevel::High);
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
    assert_eq!(
        store.result_status("task_1").unwrap(),
        Some("succeeded".to_string())
    );
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
        metrics: TokenMetrics { ..metrics() },
        audit: AgentAudit {
            model: "local-model".to_string(),
            contract: "RoutineInference".to_string(),
            started_at: "unix:1".to_string(),
            finished_at: "unix:2".to_string(),
        },
    }
}

fn failed_result(task_id: &str, error: &str) -> SubagentResult {
    SubagentResult {
        task_id: task_id.to_string(),
        agent_id: AgentId::Planner,
        status: SubagentStatus::Failed,
        output: serde_json::Value::Null,
        errors: vec![error.to_string()],
        metrics: TokenMetrics { ..metrics() },
        audit: AgentAudit {
            model: "local-model".to_string(),
            contract: "RoutineInference".to_string(),
            started_at: "unix:1".to_string(),
            finished_at: "unix:2".to_string(),
        },
    }
}

fn review(task_id: &str, approved: bool) -> SubagentReview {
    SubagentReview {
        task_id: task_id.to_string(),
        reviewer_agent_id: AgentId::Review,
        approved,
        risk_level: if approved {
            RiskLevel::Low
        } else {
            RiskLevel::High
        },
        requires_user_approval: !approved,
        findings: vec![],
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
