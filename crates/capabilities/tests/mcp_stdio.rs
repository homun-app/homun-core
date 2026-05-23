use local_first_capabilities::{
    CapabilityCall, CapabilityProvider, McpCapabilityProvider, McpStdioConfig, McpStdioTransport,
    ProviderId,
};

#[test]
fn stdio_transport_keeps_process_alive_across_requests() {
    let command = std::env::var("CARGO_BIN_EXE_fake_mcp_stdio").unwrap();
    let transport = McpStdioTransport::spawn(McpStdioConfig {
        command: command.to_string(),
        args: vec![],
        env: vec![],
    })
    .unwrap();
    let provider =
        McpCapabilityProvider::new(ProviderId::new("fixture-mcp"), true, transport, vec![]);

    let initialized = provider.initialize("2025-06-18").unwrap();
    let tools = provider.list_tools().unwrap();
    let result = provider
        .call_tool(&CapabilityCall {
            provider_id: ProviderId::new("fixture-mcp"),
            tool_name: "echo".to_string(),
            arguments: serde_json::json!({"text": "hello"}),
        })
        .unwrap();

    assert_eq!(initialized["protocolVersion"], "2025-06-18");
    assert_eq!(tools[0].name, "echo");
    assert_eq!(result.output["structuredContent"]["text"], "hello");
}
