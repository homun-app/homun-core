use local_first_subagents::{
    plan_tool_access, AgentDefinition, AgentId, AgentTier, AllowedAction, PermissionEnvelope,
    SubagentTask, TaskBudgets, ToolDefinition, ToolScope,
};

#[test]
fn tool_access_separates_model_visibility_from_runtime_execution() {
    let agent = AgentDefinition {
        id: "ToolAgent".to_string(),
        display_name: "Tool".to_string(),
        when_to_use: "Prepare tool calls".to_string(),
        tier: AgentTier::Worker,
        tool_scope: ToolScope::DraftOnly,
        subagents: vec![],
        max_iterations: 3,
        max_result_chars: Some(4000),
        timeout_seconds: Some(30),
    };
    let task = SubagentTask {
        task_id: "task_1".to_string(),
        parent_task_id: None,
        agent_id: AgentId::Tool,
        goal: "Prepare a calendar update".to_string(),
        input: serde_json::json!({}),
        contract: "ToolPlan".to_string(),
        permission_envelope: PermissionEnvelope {
            connectors: vec!["calendar".to_string()],
            max_autonomy_level: 2,
            allowed_actions: vec![AllowedAction::Read, AllowedAction::Draft],
            requires_user_approval: true,
        },
        budgets: TaskBudgets {
            timeout_seconds: 30,
            max_tokens: 512,
        },
    };
    let tools = vec![
        ToolDefinition::new(
            "calendar.read",
            "calendar",
            AllowedAction::Read,
            "Read local calendar events",
        ),
        ToolDefinition::new(
            "calendar.create",
            "calendar",
            AllowedAction::WriteWithConfirmation,
            "Create a calendar event after user approval",
        ),
        ToolDefinition::new(
            "mail.draft",
            "mail",
            AllowedAction::Draft,
            "Draft a local email",
        ),
    ];

    let access = plan_tool_access(&agent, &task, &tools);

    assert_eq!(
        access.visible_tool_names(),
        vec!["calendar.create", "calendar.read"]
    );
    assert_eq!(access.executable_tool_names(), vec!["calendar.read"]);
}
