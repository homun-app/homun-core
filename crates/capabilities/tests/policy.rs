use local_first_capabilities::{
    ActionClass, CapabilityPolicy, CapabilityProvider, CapabilityProviderKind, CapabilityTool,
    DataBoundary, FakeCapabilityProvider, ManagedProviderMetadata, PolicyContext, ProviderId,
    ToolAccessDecision, UserId, WorkspaceId,
};

#[test]
fn policy_hides_tools_from_disabled_providers() {
    let policy = CapabilityPolicy::new();
    let context = PolicyContext {
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        enabled_providers: vec![ProviderId::new("native")],
        privacy_domains: vec!["work".to_string()],
        allowed_actions: vec![ActionClass::Read],
        max_autonomy_level: 3,
        allow_managed_cloud: false,
    };
    let tool = read_tool("github.search", "github", CapabilityProviderKind::Native);

    let decision = policy.tool_access(&context, &tool);

    assert_eq!(
        decision,
        ToolAccessDecision {
            model_visible: false,
            executable: false,
            reasons: vec!["provider_not_enabled:github".to_string()],
        }
    );
}

#[test]
fn policy_keeps_write_tool_visible_but_not_executable_without_autonomy() {
    let policy = CapabilityPolicy::new();
    let context = PolicyContext {
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        enabled_providers: vec![ProviderId::new("github")],
        privacy_domains: vec!["work".to_string()],
        allowed_actions: vec![ActionClass::Read, ActionClass::WriteWithConfirmation],
        max_autonomy_level: 2,
        allow_managed_cloud: false,
    };
    let mut tool = read_tool("github.create_issue", "github", CapabilityProviderKind::Native);
    tool.action = ActionClass::WriteWithConfirmation;

    let decision = policy.tool_access(&context, &tool);

    assert!(decision.model_visible);
    assert!(!decision.executable);
    assert_eq!(decision.reasons, vec!["autonomy_too_low:3".to_string()]);
}

#[test]
fn policy_requires_explicit_cloud_permission_for_managed_tools() {
    let policy = CapabilityPolicy::new();
    let context = PolicyContext {
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        enabled_providers: vec![ProviderId::new("composio")],
        privacy_domains: vec!["work".to_string()],
        allowed_actions: vec![ActionClass::Read],
        max_autonomy_level: 3,
        allow_managed_cloud: false,
    };
    let tool = read_tool("gmail.search", "composio", CapabilityProviderKind::Managed);

    let decision = policy.tool_access(&context, &tool);

    assert!(!decision.model_visible);
    assert!(!decision.executable);
    assert_eq!(
        decision.reasons,
        vec!["managed_cloud_not_allowed:composio".to_string()]
    );
}

#[test]
fn policy_denies_tools_outside_privacy_domain() {
    let policy = CapabilityPolicy::new();
    let context = PolicyContext {
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        enabled_providers: vec![ProviderId::new("github")],
        privacy_domains: vec!["personal".to_string()],
        allowed_actions: vec![ActionClass::Read],
        max_autonomy_level: 3,
        allow_managed_cloud: false,
    };
    let tool = read_tool("github.search", "github", CapabilityProviderKind::Native);

    let decision = policy.tool_access(&context, &tool);

    assert_eq!(
        decision.reasons,
        vec!["privacy_domain_denied:work".to_string()]
    );
    assert!(!decision.model_visible);
    assert!(!decision.executable);
}

#[test]
fn fake_provider_returns_declared_tools_and_metadata() {
    let provider = FakeCapabilityProvider::new(
        ProviderId::new("composio"),
        CapabilityProviderKind::Managed,
        true,
        Some(ManagedProviderMetadata {
            provider_name: "Composio".to_string(),
            data_boundary: DataBoundary::ManagedCloud,
            auth_mode: "oauth".to_string(),
            data_categories: vec!["email_metadata".to_string()],
            retention_notes: None,
        }),
        vec![read_tool(
            "gmail.search",
            "composio",
            CapabilityProviderKind::Managed,
        )],
    );

    assert_eq!(provider.id().as_str(), "composio");
    assert_eq!(provider.kind(), CapabilityProviderKind::Managed);
    assert!(provider.is_enabled());
    assert_eq!(provider.list_tools().unwrap()[0].name, "gmail.search");
    assert_eq!(
        provider.managed_metadata().unwrap().data_boundary,
        DataBoundary::ManagedCloud
    );
}

fn read_tool(
    name: impl Into<String>,
    provider_id: impl Into<String>,
    provider_kind: CapabilityProviderKind,
) -> CapabilityTool {
    CapabilityTool {
        name: name.into(),
        provider_id: ProviderId::new(provider_id),
        provider_kind,
        action: ActionClass::Read,
        description: "Read data".to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({"type": "object"}),
    }
}
