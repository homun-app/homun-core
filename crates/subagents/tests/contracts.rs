use local_first_subagents::{
    AgentAudit, AgentId, AllowedAction, Finding, FindingSeverity, PermissionEnvelope, RiskLevel,
    SubagentResult, SubagentReview, SubagentStatus, SubagentTask, TaskBudgets, TokenMetrics,
    default_registry, validate_task_permissions,
};

#[test]
fn default_registry_contains_initial_agents() {
    let registry = default_registry();

    assert!(registry.contains(&AgentId::Planner));
    assert!(registry.contains(&AgentId::Memory));
    assert!(registry.contains(&AgentId::Tool));
    assert!(registry.contains(&AgentId::Vision));
    assert!(registry.contains(&AgentId::Risk));
    assert!(registry.contains(&AgentId::Automation));
    assert!(registry.contains(&AgentId::Review));
}

#[test]
fn task_permissions_reject_actions_above_autonomy_level() {
    let task = SubagentTask {
        task_id: "task_1".to_string(),
        parent_task_id: None,
        agent_id: AgentId::Tool,
        goal: "Prepare a Trello update".to_string(),
        input: serde_json::json!({}),
        contract: "ToolPlan".to_string(),
        permission_envelope: PermissionEnvelope {
            connectors: vec!["trello".to_string()],
            max_autonomy_level: 1,
            allowed_actions: vec![AllowedAction::WriteWithConfirmation],
            requires_user_approval: true,
        },
        budgets: TaskBudgets {
            timeout_seconds: 30,
            max_tokens: 512,
        },
    };

    let errors = validate_task_permissions(&task);

    assert_eq!(
        errors,
        vec!["action write_with_confirmation requires autonomy level 3, task allows 1"]
    );
}

#[test]
fn subagent_result_serializes_metrics_and_audit() {
    let result = SubagentResult {
        task_id: "task_1".to_string(),
        agent_id: AgentId::Planner,
        status: SubagentStatus::Succeeded,
        output: serde_json::json!({"routine_name": "Acme"}),
        errors: vec![],
        metrics: TokenMetrics {
            prompt_tokens: 10,
            generation_tokens: 20,
            prompt_tps: 100.0,
            generation_tps: 25.0,
            peak_memory_gb: 5.3,
            elapsed_seconds: 1.2,
        },
        audit: AgentAudit {
            model: "local-model-v1".to_string(),
            contract: "RoutineInference".to_string(),
            started_at: "2026-05-22T20:00:00Z".to_string(),
            finished_at: "2026-05-22T20:00:02Z".to_string(),
        },
    };

    let json = serde_json::to_value(result).unwrap();

    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["metrics"]["generation_tokens"], 20);
    assert_eq!(json["audit"]["contract"], "RoutineInference");
}

#[test]
fn subagent_review_marks_approval_and_risk() {
    let review = SubagentReview {
        task_id: "task_1".to_string(),
        reviewer_agent_id: AgentId::Review,
        approved: false,
        risk_level: RiskLevel::High,
        requires_user_approval: true,
        findings: vec![Finding {
            severity: FindingSeverity::Warning,
            message: "Sending a remote update requires confirmation".to_string(),
        }],
    };

    let json = serde_json::to_value(review).unwrap();

    assert_eq!(json["reviewer_agent_id"], "ReviewAgent");
    assert_eq!(json["risk_level"], "high");
    assert_eq!(json["findings"][0]["severity"], "warning");
}
