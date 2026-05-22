use local_first_subagents::{
    AgentAudit, AgentId, AuditStore, SubagentResult, SubagentStatus, TokenMetrics,
};

#[test]
fn audit_store_records_subagent_results() {
    let store = AuditStore::open_in_memory().unwrap();
    let result = result("task_1");

    store.record_result(&result).unwrap();

    assert_eq!(store.result_count().unwrap(), 1);
    assert_eq!(store.result_status("task_1").unwrap(), Some("succeeded".to_string()));
}

fn result(task_id: &str) -> SubagentResult {
    SubagentResult {
        task_id: task_id.to_string(),
        agent_id: AgentId::Planner,
        status: SubagentStatus::Succeeded,
        output: serde_json::json!({"ok": true}),
        errors: vec![],
        metrics: TokenMetrics {
            prompt_tokens: 1,
            generation_tokens: 2,
            prompt_tps: 3.0,
            generation_tps: 4.0,
            peak_memory_gb: 5.0,
            elapsed_seconds: 6.0,
        },
        audit: AgentAudit {
            model: "local-model".to_string(),
            contract: "RoutineInference".to_string(),
            started_at: "unix:1".to_string(),
            finished_at: "unix:2".to_string(),
        },
    }
}
