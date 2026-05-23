use local_first_capabilities::{
    ActionClass, CapabilityCall, CapabilityConnection, CapabilityError, CapabilityFacade,
    CapabilityPolicy, CapabilityProviderKind, CapabilityTool, ConnectionStatus,
    FakeCapabilityProvider, InMemoryCapabilityAudit, PolicyContext, ProviderId, UserId,
    WorkspaceId,
};

#[test]
fn facade_lists_policy_filtered_visible_and_executable_tools() {
    let mut facade = test_facade();
    facade.register_provider(FakeCapabilityProvider::new(
        ProviderId::new("github"),
        CapabilityProviderKind::Native,
        true,
        None,
        vec![
            tool("github.search", ActionClass::Read),
            tool("github.create_issue", ActionClass::WriteWithConfirmation),
        ],
    ));

    let access = facade.list_tools(&policy_context(false)).unwrap();

    assert_eq!(
        access.visible_tool_names(),
        vec!["github.create_issue", "github.search"]
    );
    assert_eq!(access.executable_tool_names(), vec!["github.search"]);
}

#[test]
fn facade_executes_allowed_tool_and_records_redacted_audit() {
    let mut provider = FakeCapabilityProvider::new(
        ProviderId::new("github"),
        CapabilityProviderKind::Native,
        true,
        None,
        vec![tool("github.search", ActionClass::Read)],
    );
    provider.set_tool_response(
        "github.search",
        serde_json::json!({
            "items": [{"title": "Bug"}],
            "access_token": "secret-token"
        }),
    );
    let mut facade = test_facade();
    facade.register_provider(provider);

    let result = facade
        .call_tool(
            &policy_context(false),
            CapabilityCall {
                provider_id: ProviderId::new("github"),
                tool_name: "github.search".to_string(),
                arguments: serde_json::json!({"query": "bug", "api_key": "secret-key"}),
            },
        )
        .unwrap();

    assert_eq!(result.output["items"][0]["title"], "Bug");
    let events = facade.audit().events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].operation, "call_tool");
    assert_eq!(events[0].payload["arguments"]["api_key"], "[redacted]");
    assert_eq!(events[0].payload["result"]["access_token"], "[redacted]");
}

#[test]
fn facade_denies_managed_tool_without_cloud_permission() {
    let mut facade = test_facade();
    facade.register_provider(FakeCapabilityProvider::new(
        ProviderId::new("composio"),
        CapabilityProviderKind::Managed,
        true,
        None,
        vec![managed_tool("gmail.search")],
    ));

    let error = facade
        .call_tool(
            &policy_context(false),
            CapabilityCall {
                provider_id: ProviderId::new("composio"),
                tool_name: "gmail.search".to_string(),
                arguments: serde_json::json!({"query": "from:alice"}),
            },
        )
        .unwrap_err();

    assert_eq!(
        error,
        CapabilityError::ManagedProviderBoundary("managed_cloud_not_allowed:composio".to_string())
    );
    assert_eq!(facade.audit().events()[0].decision, "denied");
}

#[test]
fn facade_rejects_tool_arguments_that_do_not_match_schema() {
    let mut facade = test_facade();
    facade.register_provider(FakeCapabilityProvider::new(
        ProviderId::new("github"),
        CapabilityProviderKind::Native,
        true,
        None,
        vec![search_tool_with_schema()],
    ));

    let error = facade
        .call_tool(
            &policy_context(false),
            CapabilityCall {
                provider_id: ProviderId::new("github"),
                tool_name: "github.search".to_string(),
                arguments: serde_json::json!({"query": 42}),
            },
        )
        .unwrap_err();

    assert_eq!(
        error,
        CapabilityError::SchemaValidationFailed("query must be string".to_string())
    );
}

#[test]
fn facade_filters_connections_by_user_and_workspace() {
    let mut provider = FakeCapabilityProvider::new(
        ProviderId::new("github"),
        CapabilityProviderKind::Native,
        true,
        None,
        vec![tool("github.search", ActionClass::Read)],
    );
    provider.add_connection(connection("conn_1", "user_1", "workspace_1"));
    provider.add_connection(connection("conn_2", "user_2", "workspace_1"));
    provider.add_connection(connection("conn_3", "user_1", "workspace_2"));
    let mut facade = test_facade();
    facade.register_provider(provider);

    let connections = facade
        .list_connections(&UserId::new("user_1"), &WorkspaceId::new("workspace_1"))
        .unwrap();

    assert_eq!(connections.len(), 1);
    assert_eq!(connections[0].id, "conn_1");
}

fn test_facade() -> CapabilityFacade {
    CapabilityFacade::new(CapabilityPolicy::new(), InMemoryCapabilityAudit::new())
}

fn policy_context(allow_managed_cloud: bool) -> PolicyContext {
    PolicyContext {
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        enabled_providers: vec![ProviderId::new("github"), ProviderId::new("composio")],
        privacy_domains: vec!["work".to_string()],
        allowed_actions: vec![ActionClass::Read],
        max_autonomy_level: 2,
        allow_managed_cloud,
    }
}

fn tool(name: impl Into<String>, action: ActionClass) -> CapabilityTool {
    CapabilityTool {
        name: name.into(),
        provider_id: ProviderId::new("github"),
        provider_kind: CapabilityProviderKind::Native,
        action,
        description: "GitHub tool".to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({"type": "object"}),
    }
}

fn search_tool_with_schema() -> CapabilityTool {
    CapabilityTool {
        name: "github.search".to_string(),
        provider_id: ProviderId::new("github"),
        provider_kind: CapabilityProviderKind::Native,
        action: ActionClass::Read,
        description: "Search GitHub".to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"}
            },
            "required": ["query"]
        }),
    }
}

fn managed_tool(name: impl Into<String>) -> CapabilityTool {
    CapabilityTool {
        name: name.into(),
        provider_id: ProviderId::new("composio"),
        provider_kind: CapabilityProviderKind::Managed,
        action: ActionClass::Read,
        description: "Managed Gmail tool".to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({"type": "object"}),
    }
}

fn connection(id: &str, user_id: &str, workspace_id: &str) -> CapabilityConnection {
    CapabilityConnection {
        id: id.to_string(),
        provider_id: ProviderId::new("github"),
        user_id: UserId::new(user_id),
        workspace_id: WorkspaceId::new(workspace_id),
        status: ConnectionStatus::Active,
        display_name: "GitHub".to_string(),
        privacy_domains: vec!["work".to_string()],
    }
}
