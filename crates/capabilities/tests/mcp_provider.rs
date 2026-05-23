use local_first_capabilities::{
    ActionClass, CapabilityCall, CapabilityProvider, CapabilityProviderKind, InMemoryMcpTransport,
    McpCapabilityProvider, McpToolPolicy, ProviderId,
};

#[test]
fn mcp_provider_maps_tools_list_to_capability_tools() {
    let transport = InMemoryMcpTransport::new()
        .with_response(
            "tools/list",
            serde_json::json!({
                "tools": [{
                    "name": "filesystem.read_file",
                    "description": "Read a local file",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"]
                    }
                }]
            }),
        );
    let provider = McpCapabilityProvider::new(
        ProviderId::new("local-filesystem-mcp"),
        true,
        transport,
        vec![McpToolPolicy {
            tool_name: "filesystem.read_file".to_string(),
            action: ActionClass::Read,
            privacy_domains: vec!["work".to_string()],
            sensitivity: "private".to_string(),
        }],
    );

    let tools = provider.list_tools().unwrap();

    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "filesystem.read_file");
    assert_eq!(tools[0].provider_kind, CapabilityProviderKind::Mcp);
    assert_eq!(tools[0].action, ActionClass::Read);
    assert_eq!(tools[0].privacy_domains, vec!["work"]);
    assert_eq!(tools[0].input_schema["required"][0], "path");
}

#[test]
fn mcp_provider_calls_tool_through_transport() {
    let transport = InMemoryMcpTransport::new().with_response(
        "tools/call",
        serde_json::json!({
            "content": [{"type": "text", "text": "hello"}],
            "structuredContent": {"text": "hello"}
        }),
    );
    let provider = McpCapabilityProvider::new(
        ProviderId::new("echo-mcp"),
        true,
        transport,
        vec![McpToolPolicy {
            tool_name: "echo".to_string(),
            action: ActionClass::Read,
            privacy_domains: vec!["work".to_string()],
            sensitivity: "internal".to_string(),
        }],
    );

    let result = provider
        .call_tool(&CapabilityCall {
            provider_id: ProviderId::new("echo-mcp"),
            tool_name: "echo".to_string(),
            arguments: serde_json::json!({"text": "hello"}),
        })
        .unwrap();

    assert_eq!(result.provider_id.as_str(), "echo-mcp");
    assert_eq!(result.tool_name, "echo");
    assert_eq!(result.output["structuredContent"]["text"], "hello");
}

#[test]
fn mcp_provider_sends_initialized_notification_after_initialize() {
    let transport = InMemoryMcpTransport::new().with_response(
        "initialize",
        serde_json::json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {"listChanged": true}},
            "serverInfo": {"name": "fake", "version": "0.1.0"}
        }),
    );
    let provider = McpCapabilityProvider::new(
        ProviderId::new("fake-mcp"),
        true,
        transport,
        vec![],
    );

    let initialized = provider.initialize("2025-06-18").unwrap();

    assert_eq!(initialized["protocolVersion"], "2025-06-18");
    assert_eq!(
        provider.transport().notifications(),
        vec!["notifications/initialized"]
    );
}
