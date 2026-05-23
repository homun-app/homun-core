use local_first_capabilities::{
    ActionClass, CapabilityProviderKind, CapabilityTool, ProviderId, UserId, WorkspaceId,
};
use local_first_subagents::{
    AgentDefinition, AgentId, AgentTier, AllowedAction, CapabilityBridgeOptions,
    PermissionEnvelope, SubagentTask, TaskBudgets, ToolScope, capability_policy_context_for_task,
    plan_capability_access,
};

#[test]
fn bridge_maps_task_permissions_into_capability_policy_context() {
    let task = task_with_permissions(PermissionEnvelope {
        connectors: vec!["github".to_string(), "composio".to_string()],
        max_autonomy_level: 3,
        allowed_actions: vec![AllowedAction::Read, AllowedAction::Draft],
        requires_user_approval: true,
    });

    let context = capability_policy_context_for_task(
        &task,
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        CapabilityBridgeOptions {
            privacy_domains: vec!["work".to_string()],
            allow_managed_cloud: true,
        },
    );

    assert_eq!(context.user_id.as_str(), "user_1");
    assert_eq!(context.workspace_id.as_str(), "workspace_1");
    assert_eq!(
        context.enabled_providers,
        vec![ProviderId::new("github"), ProviderId::new("composio")]
    );
    assert_eq!(
        context.allowed_actions,
        vec![ActionClass::Read, ActionClass::Draft]
    );
    assert_eq!(context.max_autonomy_level, 3);
    assert!(context.allow_managed_cloud);
}

#[test]
fn bridge_separates_visible_and_executable_capability_tools() {
    let agent = tool_agent(ToolScope::DraftOnly);
    let task = task_with_permissions(PermissionEnvelope {
        connectors: vec!["calendar".to_string()],
        max_autonomy_level: 2,
        allowed_actions: vec![AllowedAction::Read, AllowedAction::Draft],
        requires_user_approval: true,
    });
    let tools = vec![
        capability_tool(
            "calendar.read",
            "calendar",
            CapabilityProviderKind::Native,
            ActionClass::Read,
        ),
        capability_tool(
            "calendar.create",
            "calendar",
            CapabilityProviderKind::Native,
            ActionClass::WriteWithConfirmation,
        ),
        capability_tool(
            "mail.draft",
            "mail",
            CapabilityProviderKind::Native,
            ActionClass::Draft,
        ),
    ];

    let access = plan_capability_access(
        &agent,
        &task,
        &tools,
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        CapabilityBridgeOptions {
            privacy_domains: vec!["work".to_string()],
            allow_managed_cloud: false,
        },
    );

    assert_eq!(
        access.visible_tool_names(),
        vec!["calendar.create", "calendar.read"]
    );
    assert_eq!(access.executable_tool_names(), vec!["calendar.read"]);
}

#[test]
fn bridge_blocks_managed_provider_without_cloud_opt_in() {
    let agent = tool_agent(ToolScope::ReadOnly);
    let task = task_with_permissions(PermissionEnvelope {
        connectors: vec!["composio".to_string()],
        max_autonomy_level: 2,
        allowed_actions: vec![AllowedAction::Read],
        requires_user_approval: true,
    });
    let tools = vec![capability_tool(
        "gmail.search",
        "composio",
        CapabilityProviderKind::Managed,
        ActionClass::Read,
    )];

    let access = plan_capability_access(
        &agent,
        &task,
        &tools,
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        CapabilityBridgeOptions {
            privacy_domains: vec!["work".to_string()],
            allow_managed_cloud: false,
        },
    );

    assert!(access.visible_tools.is_empty());
    assert!(access.executable_tools.is_empty());
}

fn tool_agent(tool_scope: ToolScope) -> AgentDefinition {
    AgentDefinition {
        id: "ToolAgent".to_string(),
        display_name: "Tool".to_string(),
        when_to_use: "Prepare tool calls".to_string(),
        tier: AgentTier::Worker,
        tool_scope,
        subagents: vec![],
        max_iterations: 3,
        max_result_chars: Some(4000),
        timeout_seconds: Some(30),
    }
}

fn task_with_permissions(permission_envelope: PermissionEnvelope) -> SubagentTask {
    SubagentTask {
        task_id: "task_1".to_string(),
        parent_task_id: None,
        agent_id: AgentId::Tool,
        goal: "Use a capability".to_string(),
        input: serde_json::json!({}),
        contract: "ToolPlan".to_string(),
        permission_envelope,
        budgets: TaskBudgets {
            timeout_seconds: 30,
            max_tokens: 512,
        },
    }
}

fn capability_tool(
    name: impl Into<String>,
    provider_id: impl Into<String>,
    provider_kind: CapabilityProviderKind,
    action: ActionClass,
) -> CapabilityTool {
    CapabilityTool {
        name: name.into(),
        provider_id: ProviderId::new(provider_id),
        provider_kind,
        action,
        description: "Capability tool".to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({"type": "object"}),
    }
}
