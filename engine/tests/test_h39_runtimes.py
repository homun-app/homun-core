"""Tests for Codex App-Server, Copilot ACP, NeMo Relay proxy, and Managed Tool Gateway (H39)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.codex_runtime import CodexAppServerAdapter, CodexTurnResult
from homun.application.copilot_acp_client import CopilotAcpClient, CopilotAcpResult
from homun.application.managed_tool_gateway import ManagedToolGateway, ManagedToolGatewayConfig
from homun.application.relay_runtime import RelayRuntime, RelayTurnContext


# 1. Codex App-Server Adapter
def test_codex_app_server_adapter_events():
    adapter = CodexAppServerAdapter()
    text_deltas = []
    reasoning_deltas = []
    tools_started = []
    tools_completed = []

    events = [
        {"method": "item/reasoning/delta", "params": {"delta": "Analyzing repository..."}},
        {"method": "item/agentMessage/delta", "params": {"delta": "I will inspect the "}},
        {"method": "item/agentMessage/delta", "params": {"delta": "manifest file."}},
        {
            "method": "item/started",
            "params": {"item": {"type": "commandExecution", "command": "cat package.json", "arguments": {"path": "package.json"}}},
        },
        {
            "method": "item/completed",
            "params": {"item": {"type": "commandExecution", "command": "cat package.json", "result": '{"name": "homun"}'}},
        },
    ]

    for event in events:
        adapter.process_event(
            event,
            on_text_delta=text_deltas.append,
            on_reasoning_delta=reasoning_deltas.append,
            on_tool_started=lambda name, args: tools_started.append((name, args)),
            on_tool_completed=lambda name, res, err: tools_completed.append((name, res, err)),
        )

    assert "".join(text_deltas) == "I will inspect the manifest file."
    assert "".join(reasoning_deltas) == "Analyzing repository..."
    assert len(tools_started) == 1
    assert tools_started[0][0] == "cat package.json"
    assert tools_started[0][1] == {"path": "package.json"}
    assert len(tools_completed) == 1
    assert tools_completed[0][0] == "cat package.json"
    assert '{"name": "homun"}' in tools_completed[0][1]
    assert tools_completed[0][2] is False


def test_codex_app_server_run_turn_and_interruption():
    adapter = CodexAppServerAdapter()

    events = [
        {"method": "item/agentMessage/delta", "params": {"delta": "First part. "}},
        {
            "method": "item/started",
            "params": {"item": {"type": "dynamicToolCall", "tool": "fetch_url", "arguments": {"url": "https://example.com"}}},
        },
        {
            "method": "item/completed",
            "params": {"item": {"type": "dynamicToolCall", "tool": "fetch_url", "result": "OK"}},
        },
        {"method": "item/agentMessage/delta", "params": {"delta": "Second part."}},
    ]

    result = adapter.run_turn(
        messages=[{"role": "user", "content": "Fetch url"}],
        event_feed=events,
    )

    assert result.text == "First part. Second part."
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0]["name"] == "fetch_url"
    assert result.tool_calls[0]["status"] == "completed"
    assert result.tool_calls[0]["result"] == "OK"
    assert result.interrupted is False

    # Test interruption
    adapter.interrupt()
    assert adapter._interrupted is True


# 2. Copilot ACP Client
def test_copilot_acp_client_tool_extraction():
    client = CopilotAcpClient()

    raw = (
        "Let me run this check for you:\n"
        "<tool_call>\n"
        '{"name": "run_shell", "arguments": {"command": "pytest"}}\n'
        "</tool_call>\n"
        "I've initiated the tests."
    )

    cleaned, tool_calls = client.extract_tool_calls(raw)
    assert len(tool_calls) == 1
    assert tool_calls[0]["name"] == "run_shell"
    assert tool_calls[0]["arguments"] == {"command": "pytest"}
    assert "Let me run this check for you:" in cleaned
    assert "I've initiated the tests." in cleaned
    assert "<tool_call>" not in cleaned


def test_copilot_acp_turn_execution_and_availability():
    # Simulated execution
    client = CopilotAcpClient()
    simulated = "Result text <tool_call>{\"tool\": \"view_file\", \"args\": {\"path\": \"README.md\"}}</tool_call>"
    result = client.run_turn("Inspect readme", simulated_response=simulated)

    assert result.is_available is True
    assert result.text == "Result text"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0]["name"] == "view_file"

    # Missing binary behavior without simulation
    missing_client = CopilotAcpClient(command="nonexistent_copilot_binary_xyz123")
    assert missing_client.is_available() is False
    res_missing = missing_client.run_turn("Hello")
    assert res_missing.is_available is False
    assert "not installed or not found on PATH" in (res_missing.error or "")


# 3. NeMo Relay Proxy Runtime
def test_relay_runtime_sessions_and_headers():
    relay = RelayRuntime(endpoint_url="https://relay.enterprise.internal", enabled=True)
    assert relay.is_available() is True

    sess = relay.create_session(session_id="sess_123", parent_session_id="parent_abc")
    headers = relay.build_headers(sess)
    assert headers["x-dynamo-session-id"] == "sess_123"
    assert headers["x-dynamo-parent-session-id"] == "parent_abc"


def test_relay_runtime_execution_and_explicit_gap():
    # Enabled relay with passthrough handler
    relay = RelayRuntime(endpoint_url="https://relay.enterprise.internal", enabled=True)
    captured = {}

    def mock_passthrough(payload, headers):
        captured["headers"] = headers
        captured["payload"] = payload
        return {"relay_ack": True}

    res = relay.execute_operation(
        operation="generate_embeddings",
        payload={"input": "text"},
        session_id="sess_corp_99",
        passthrough_handler=mock_passthrough,
    )
    assert res.success is True
    assert res.output == {"relay_ack": True}
    assert res.headers_injected["x-dynamo-session-id"] == "sess_corp_99"

    # Disabled / unconfigured relay reports explicit gap
    unconfigured_relay = RelayRuntime(enabled=False)
    assert unconfigured_relay.is_available() is False
    res_gap = unconfigured_relay.execute_operation("summarize", {"text": "hello"})
    assert res_gap.success is False
    assert "Relay service is not configured or disabled (explicit gap)" in (res_gap.error or "")


# 4. Managed Tool Gateway
def test_managed_tool_gateway():
    # Configured gateway with token
    config = ManagedToolGatewayConfig(
        vendor="nous",
        gateway_origin="https://gateway.nousresearch.com",
        user_token="token_abc_123",
        managed_mode=True,
    )
    gateway = ManagedToolGateway(config=config)
    assert gateway.is_available() is True

    captured_headers = {}

    def mock_dispatcher(tool, args, headers):
        captured_headers.update(headers)
        return {"executed": tool, "args": args}

    res = gateway.invoke_tool("weather_api", {"city": "Milan"}, http_dispatcher=mock_dispatcher)
    assert res.success is True
    assert res.tool_name == "weather_api"
    assert res.result == {"executed": "weather_api", "args": {"city": "Milan"}}
    assert captured_headers["Authorization"] == "Bearer token_abc_123"
    assert captured_headers["X-Tool-Vendor"] == "nous"

    # Unconfigured gateway reports explicit gap
    unconfigured_gateway = ManagedToolGateway(
        config=ManagedToolGatewayConfig(vendor="nous", gateway_origin="https://api.nousresearch.com", user_token=None, managed_mode=False)
    )
    assert unconfigured_gateway.is_available() is False
    gap_res = unconfigured_gateway.invoke_tool("some_cloud_tool", {})
    assert gap_res.success is False
    assert "TOOL_GATEWAY_USER_TOKEN is not configured (explicit gap)" in (gap_res.error or "")


# 5. REST API Routes
def test_alternate_runtimes_api_routes():
    app = create_app()
    client = TestClient(app)

    # 1. GET /v1/runtimes/status
    resp = client.get("/v1/runtimes/status")
    assert resp.status_code == 200
    status_data = resp.json()
    assert "codex_app_server" in status_data
    assert "copilot_acp" in status_data
    assert "relay_proxy" in status_data
    assert "managed_tool_gateway" in status_data

    # 2. POST /v1/runtimes/codex/turn
    resp = client.post(
        "/v1/runtimes/codex/turn",
        json={
            "messages": [{"role": "user", "content": "Hello Codex"}],
            "events": [
                {"method": "item/agentMessage/delta", "params": {"delta": "Hello from adapter"}},
            ],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["text"] == "Hello from adapter"

    # 3. POST /v1/runtimes/copilot-acp/turn
    resp = client.post(
        "/v1/runtimes/copilot-acp/turn",
        json={
            "prompt": "Test copilot",
            "simulated_response": "Output with <tool_call>{\"name\": \"sh\", \"arguments\": {}}</tool_call>",
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["is_available"] is True
    assert len(data["tool_calls"]) == 1
    assert data["tool_calls"][0]["name"] == "sh"

    # 4. POST /v1/runtimes/relay/dispatch
    resp = client.post(
        "/v1/runtimes/relay/dispatch",
        json={"operation": "ping", "payload": {"foo": "bar"}, "enabled": False},
    )
    assert resp.status_code == 200
    assert resp.json()["success"] is False
    assert "explicit gap" in resp.json()["error"]

    # 5. POST /v1/runtimes/tool-gateway/invoke
    resp = client.post(
        "/v1/runtimes/tool-gateway/invoke",
        json={"tool_name": "cloud_search", "arguments": {"query": "homun"}},
    )
    assert resp.status_code == 200
    # In test environment, unconfigured TOOL_GATEWAY_USER_TOKEN returns explicit gap error cleanly
    assert resp.json()["success"] is False
    assert "explicit gap" in resp.json()["error"]
