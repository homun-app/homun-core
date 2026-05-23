use local_first_capabilities::{
    ActionClass, CapabilityCall, CapabilityProvider, CapabilityProviderKind,
    ComposioCapabilityProvider, ComposioProviderConfig, ComposioToolPolicy, ConnectionStatus,
    DataBoundary, InMemoryComposioTransport, ProviderId, TriggerStatus, UserId, WorkspaceId,
};

#[test]
fn composio_provider_declares_managed_cloud_metadata() {
    let provider = composio_provider(InMemoryComposioTransport::new());

    let metadata = provider.managed_metadata().unwrap();

    assert_eq!(provider.kind(), CapabilityProviderKind::Managed);
    assert_eq!(metadata.provider_name, "Composio");
    assert_eq!(metadata.data_boundary, DataBoundary::ManagedCloud);
    assert_eq!(metadata.auth_mode, "composio_connect_or_api_key");
}

#[test]
fn composio_provider_maps_tools_to_capability_tools() {
    let transport = InMemoryComposioTransport::new().with_response(
        "GET",
        "/tools",
        serde_json::json!({
            "tools": [{
                "slug": "GMAIL_GET_PROFILE",
                "description": "Get Gmail profile",
                "toolkit": "gmail",
                "input_schema": {"type": "object", "properties": {}}
            }]
        }),
    );
    let provider = composio_provider(transport);

    let tools = provider.list_tools().unwrap();

    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "GMAIL_GET_PROFILE");
    assert_eq!(tools[0].provider_id.as_str(), "composio");
    assert_eq!(tools[0].provider_kind, CapabilityProviderKind::Managed);
    assert_eq!(tools[0].action, ActionClass::Read);
    assert_eq!(tools[0].privacy_domains, vec!["work"]);
    assert_eq!(tools[0].input_schema["type"], "object");
}

#[test]
fn composio_provider_executes_tool_with_user_scoped_payload() {
    let transport = InMemoryComposioTransport::new().with_response(
        "POST",
        "/tools/execute/GMAIL_GET_PROFILE",
        serde_json::json!({
            "successful": true,
            "data": {"email": "fabio@example.com"}
        }),
    );
    let provider = composio_provider(transport);

    let result = provider
        .call_tool(&CapabilityCall {
            provider_id: ProviderId::new("composio"),
            tool_name: "GMAIL_GET_PROFILE".to_string(),
            arguments: serde_json::json!({}),
        })
        .unwrap();

    assert_eq!(result.output["data"]["email"], "fabio@example.com");
    assert_eq!(
        provider.transport().requests()[0].body["user_id"],
        "user_1"
    );
    assert_eq!(
        provider.transport().requests()[0].body["arguments"],
        serde_json::json!({})
    );
}

#[test]
fn composio_provider_maps_connected_accounts_to_connections() {
    let transport = InMemoryComposioTransport::new().with_response(
        "GET",
        "/connected_accounts",
        serde_json::json!({
            "accounts": [{
                "id": "ca_1",
                "status": "ACTIVE",
                "toolkit": {"slug": "gmail"},
                "display_name": "Gmail Work"
            }]
        }),
    );
    let provider = composio_provider(transport);

    let connections = provider.list_connections().unwrap();

    assert_eq!(connections.len(), 1);
    assert_eq!(connections[0].id, "ca_1");
    assert_eq!(connections[0].user_id, UserId::new("user_1"));
    assert_eq!(connections[0].workspace_id, WorkspaceId::new("workspace_1"));
    assert_eq!(connections[0].status, ConnectionStatus::Active);
    assert_eq!(connections[0].privacy_domains, vec!["work"]);
}

#[test]
fn composio_provider_maps_and_toggles_triggers() {
    let transport = InMemoryComposioTransport::new()
        .with_response(
            "GET",
            "/triggers",
            serde_json::json!({
                "triggers": [{
                    "id": "tr_1",
                    "slug": "GMAIL_NEW_GMAIL_MESSAGE",
                    "status": "ACTIVE",
                    "config": {"label": "INBOX"}
                }]
            }),
        )
        .with_response("POST", "/triggers/tr_1/enable", serde_json::json!({"ok": true}))
        .with_response("POST", "/triggers/tr_1/disable", serde_json::json!({"ok": true}));
    let mut provider = composio_provider(transport);

    let triggers = provider.list_triggers().unwrap();
    provider.enable_trigger("tr_1").unwrap();
    provider.disable_trigger("tr_1").unwrap();

    assert_eq!(triggers[0].id, "tr_1");
    assert_eq!(triggers[0].name, "GMAIL_NEW_GMAIL_MESSAGE");
    assert_eq!(triggers[0].status, TriggerStatus::Active);
    assert_eq!(provider.transport().requests()[1].path, "/triggers/tr_1/enable");
    assert_eq!(provider.transport().requests()[2].path, "/triggers/tr_1/disable");
}

fn composio_provider(
    transport: InMemoryComposioTransport,
) -> ComposioCapabilityProvider<InMemoryComposioTransport> {
    ComposioCapabilityProvider::new(
        ComposioProviderConfig {
            provider_id: ProviderId::new("composio"),
            user_id: UserId::new("user_1"),
            workspace_id: WorkspaceId::new("workspace_1"),
            enabled: true,
            privacy_domains: vec!["work".to_string()],
            tool_policies: vec![ComposioToolPolicy {
                tool_name: "GMAIL_GET_PROFILE".to_string(),
                action: ActionClass::Read,
                privacy_domains: vec!["work".to_string()],
                sensitivity: "private".to_string(),
            }],
        },
        transport,
    )
}
