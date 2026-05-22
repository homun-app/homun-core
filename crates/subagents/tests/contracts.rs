use local_first_subagents::{
    default_registry, validate_task_permissions, AllowedAction, AgentId, PermissionEnvelope,
    SubagentTask, TaskBudgets,
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
