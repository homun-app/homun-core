"""Tests for OpenAI-compatible API, idempotency, ACP IDE adapter, and hosted MCP agent (H35).

Verifies:
1. /v1/models lists available and virtual models in OpenAI format.
2. /v1/chat/completions non-streaming response format and usage.
3. /v1/chat/completions streaming SSE chunks and [DONE] termination.
4. /v1/chat/completions tool calls generation and finish_reason='tool_calls'.
5. Idempotent requests via Idempotency-Key / body hash.
6. Hosted MCP Agent server tools (homun_task, homun_ask, homun_status) and JSON-RPC dispatch.
7. ACP IDE adapter session lifecycle, prompt streaming, and edit approval callbacks.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.acp_adapter import AcpApprovalStatus, AcpServerAdapter
from homun.application.api_server_contracts import GLOBAL_IDEMPOTENCY_STORE, IdempotencyStore
from homun.application.hosted_mcp_agent import HostedMcpAgentServer
from homun.context import create_context, reset_context_for_tests
from homun.models.native_turn import NativeMessage, ToolCall
from homun.models.types import UsageEntry


@pytest.fixture
def api_client():
    reset_context_for_tests(None)
    ctx = create_context()
    reset_context_for_tests(ctx)
    app = create_app()
    client = TestClient(app)
    GLOBAL_IDEMPOTENCY_STORE.clear()
    yield client
    reset_context_for_tests(None)


# ---------------------------------------------------------------------------
# 1. Models List
# ---------------------------------------------------------------------------

def test_openai_models_endpoint(api_client):
    res = api_client.get("/v1/models")
    assert res.status_code == 200
    data = res.json()
    assert data["object"] == "list"
    ids = [m["id"] for m in data["data"]]
    assert "homun-agent" in ids
    assert "moa:default" in ids


# ---------------------------------------------------------------------------
# 2. Chat Completions Non-Streaming & Tool Calls
# ---------------------------------------------------------------------------

def test_openai_chat_completions_non_streaming(api_client, monkeypatch):
    from homun.context import get_context
    ctx = get_context()

    # Mock model completion
    def mock_complete(msgs, tools=None, model_id=None, **kwargs):
        msg = NativeMessage(role="assistant", content="Hello from Homun!")
        usage = UsageEntry(id="u1", provider_id="test", model_id="test", input_tokens=15, output_tokens=8)
        return SimpleNamespace(message=msg, usage=usage)

    monkeypatch.setattr(ctx.models, "complete_tools", mock_complete)

    payload = {
        "model": "homun-agent",
        "messages": [{"role": "user", "content": "Hello"}],
        "stream": False,
    }
    res = api_client.post("/v1/chat/completions", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["object"] == "chat.completion"
    assert data["model"] == "homun-agent"
    assert len(data["choices"]) == 1
    assert data["choices"][0]["message"]["role"] == "assistant"
    assert data["choices"][0]["message"]["content"] == "Hello from Homun!"
    assert data["choices"][0]["finish_reason"] == "stop"
    assert data["usage"]["prompt_tokens"] == 15
    assert data["usage"]["completion_tokens"] == 8
    assert data["usage"]["total_tokens"] == 23


def test_openai_chat_completions_with_tool_calls(api_client, monkeypatch):
    from homun.context import get_context
    ctx = get_context()

    def mock_complete(msgs, tools=None, model_id=None, **kwargs):
        msg = NativeMessage(
            role="assistant",
            content="",
            tool_calls=[ToolCall(id="call_123", name="test_tool", arguments={"arg": "val"})],
        )
        usage = UsageEntry(id="u1", provider_id="test", model_id="test", input_tokens=20, output_tokens=12)
        return SimpleNamespace(message=msg, usage=usage)

    monkeypatch.setattr(ctx.models, "complete_tools", mock_complete)

    payload = {
        "model": "homun-agent",
        "messages": [{"role": "user", "content": "Run tool"}],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "test_tool",
                    "description": "A test tool",
                    "parameters": {"type": "object", "properties": {"arg": {"type": "string"}}},
                },
            }
        ],
        "stream": False,
    }
    res = api_client.post("/v1/chat/completions", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["choices"][0]["finish_reason"] == "tool_calls"
    tool_calls = data["choices"][0]["message"]["tool_calls"]
    assert len(tool_calls) == 1
    assert tool_calls[0]["id"] == "call_123"
    assert tool_calls[0]["function"]["name"] == "test_tool"
    assert json.loads(tool_calls[0]["function"]["arguments"]) == {"arg": "val"}


# ---------------------------------------------------------------------------
# 3. Streaming SSE Completions
# ---------------------------------------------------------------------------

def test_openai_chat_completions_streaming_sse(api_client, monkeypatch):
    from homun.context import get_context
    ctx = get_context()

    def mock_complete(msgs, tools=None, model_id=None, **kwargs):
        msg = NativeMessage(
            role="assistant",
            content="Streaming token response",
            tool_calls=[ToolCall(id="c1", name="call_fn", arguments={"x": 1})],
        )
        return SimpleNamespace(message=msg, usage=None)

    monkeypatch.setattr(ctx.models, "complete_tools", mock_complete)

    payload = {
        "model": "homun-agent",
        "messages": [{"role": "user", "content": "Stream please"}],
        "stream": True,
    }
    res = api_client.post("/v1/chat/completions", json=payload)
    assert res.status_code == 200
    assert "text/event-stream" in res.headers["content-type"]

    lines = res.text.strip().split("\n\n")
    # Must end with [DONE]
    assert lines[-1] == "data: [DONE]"

    # Verify chunks parse into chat.completion.chunk objects
    chunks = [json.loads(line.replace("data: ", "")) for line in lines[:-1]]
    assert all(c["object"] == "chat.completion.chunk" for c in chunks)
    # Check that content delta was streamed
    assert any("Streaming token response" in (c["choices"][0]["delta"].get("content") or "") for c in chunks)
    # Check that tool call delta was streamed
    assert any(c["choices"][0]["delta"].get("tool_calls") for c in chunks)


# ---------------------------------------------------------------------------
# 4. Idempotency Key Handling
# ---------------------------------------------------------------------------

def test_openai_chat_completions_idempotency(api_client, monkeypatch):
    from homun.context import get_context
    ctx = get_context()

    call_count = 0

    def mock_complete(msgs, tools=None, model_id=None, **kwargs):
        nonlocal call_count
        call_count += 1
        msg = NativeMessage(role="assistant", content=f"Execution #{call_count}")
        return SimpleNamespace(message=msg, usage=None)

    monkeypatch.setattr(ctx.models, "complete_tools", mock_complete)

    payload = {
        "model": "homun-agent",
        "messages": [{"role": "user", "content": "Idempotent action"}],
        "stream": False,
    }
    headers = {"Idempotency-Key": "test-key-abc-123"}

    # First request: computes and caches
    res1 = api_client.post("/v1/chat/completions", json=payload, headers=headers)
    assert res1.status_code == 200
    assert call_count == 1
    assert res1.json()["choices"][0]["message"]["content"] == "Execution #1"

    # Second request with same idempotency key: served from cache without re-executing
    res2 = api_client.post("/v1/chat/completions", json=payload, headers=headers)
    assert res2.status_code == 200
    assert call_count == 1  # Unchanged!
    assert res2.headers.get("X-Cache-Lookup") == "HIT"
    assert res2.json()["choices"][0]["message"]["content"] == "Execution #1"


# ---------------------------------------------------------------------------
# 5. Hosted MCP Agent Server
# ---------------------------------------------------------------------------

def test_hosted_mcp_agent_server():
    server = HostedMcpAgentServer()

    init_res = server.handle_jsonrpc({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert init_res["result"]["serverInfo"]["name"] == "homun-agent"

    ping_res = server.handle_jsonrpc({"jsonrpc": "2.0", "id": 2, "method": "ping"})
    assert ping_res["result"] == {}

    tools_res = server.handle_jsonrpc({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})
    tools = tools_res["result"]["tools"]
    tool_names = [t["name"] for t in tools]
    assert "homun_task" in tool_names
    assert "homun_ask" in tool_names
    assert "homun_status" in tool_names

    # Without a runner: honest unavailability (no invented completion)
    ask_call = server.handle_jsonrpc({
        "jsonrpc": "2.0",
        "id": 4,
        "method": "tools/call",
        "params": {
            "name": "homun_ask",
            "arguments": {"question": "How does parity work?", "context": "H35 matrix row"},
        },
    })
    assert ask_call["result"]["isError"] is True
    assert "not configured" in ask_call["result"]["content"][0]["text"].lower()

    task_call = server.handle_jsonrpc({
        "jsonrpc": "2.0",
        "id": 5,
        "method": "tools/call",
        "params": {
            "name": "homun_task",
            "arguments": {"objective": "Refactor codebase", "files": ["app.py"]},
        },
    })
    assert task_call["result"]["isError"] is True
    assert "completed" not in task_call["result"]["content"][0]["text"].lower()

    class Runner:
        def ask(self, question, context=""):
            return f"Real answer to {question}"

        def run_task(self, objective, files=None, allow_tools=None):
            return {
                "task_id": "task_real",
                "status": "running",
                "objective": objective,
                "files": files or [],
            }

        def get_status(self, work_id):
            return {"work_id": work_id, "status": "ready", "active_runs": 0}

    wired = HostedMcpAgentServer(runner=Runner())
    ask_ok = wired.call_tool("homun_ask", {"question": "parity?"})
    assert ask_ok["isError"] is False
    assert "Real answer" in ask_ok["content"][0]["text"]

    task_ok = wired.call_tool("homun_task", {"objective": "Refactor codebase", "files": ["app.py"]})
    assert task_ok["isError"] is False
    task_data = json.loads(task_ok["content"][0]["text"])
    assert task_data["status"] == "running"
    assert task_data["objective"] == "Refactor codebase"


# ---------------------------------------------------------------------------
# 6. ACP (Agent Client Protocol) IDE Adapter
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_acp_adapter_lifecycle_and_edit_approval():
    adapter = AcpServerAdapter()

    # 1. Initialize
    init_info = adapter.initialize({"editor": "Zed"})
    assert init_info["protocolVersion"] == "1.0"
    assert init_info["capabilities"]["editApproval"] is True

    # 2. New session
    session = adapter.new_session(model="homun-agent")
    assert session.session_id.startswith("acp_sess_")

    # 3. Prompt with streaming callbacks
    events = []
    def on_event(event_type: str, data: Any):
        events.append((event_type, data))

    prompt_res = await adapter.prompt(session.session_id, "Analyze file", event_callback=on_event)
    assert prompt_res["status"] == "completed"
    assert len(events) >= 2
    assert any(e[0] == "message_chunk" for e in events)

    # 4. Propose edit and resolve approval
    proposals_captured = []
    def on_proposal(prop):
        proposals_captured.append(prop)
        # Simulate user clicking approve in IDE modal
        adapter.resolve_edit_approval(prop.proposal_id, approved=True)

    approved = await adapter.propose_edit(
        session_id=session.session_id,
        file_path="src/main.rs",
        diff="--- a\n+++ b\n+fn new_fn() {}",
        on_proposal=on_proposal,
    )
    assert approved is True
    assert len(proposals_captured) == 1
    assert proposals_captured[0].status == AcpApprovalStatus.APPROVED

    # 5. Propose edit and resolve rejection
    def on_rejection_proposal(prop):
        adapter.resolve_edit_approval(prop.proposal_id, approved=False)

    rejected = await adapter.propose_edit(
        session_id=session.session_id,
        file_path="src/bad.rs",
        diff="-bad\n+worse",
        on_proposal=on_rejection_proposal,
    )
    assert rejected is False


def test_hosted_mcp_engine_runner_stages_real_agent_run(tmp_path):
    from homun.application.hosted_mcp_agent import HostedMcpAgentServer
    from homun.application.hosted_mcp_runner import HostedMcpEngineRunner
    from homun.context import create_context
    from homun.domain.models import Actor

    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    actor = Actor(id="person_a", workspace_id=ctx.workspace_id, display_name="A")
    runner = HostedMcpEngineRunner(default_actor_id=actor.id)
    server = HostedMcpAgentServer(runner=runner)

    out = server.call_tool(
        "homun_task",
        {"objective": "Prepare a short Italian note about delivery"},
        ctx=ctx,
    )
    assert out.get("isError") is False
    payload = json.loads(out["content"][0]["text"])
    assert payload["status"] == "pending_approval"
    assert payload["work_id"]
    assert payload["run_id"]
    assert payload["digest"]

    status = server.call_tool("homun_status", {"work_id": payload["work_id"]}, ctx=ctx)
    assert status.get("isError") is False
    status_body = json.loads(status["content"][0]["text"])
    assert status_body["work_id"] == payload["work_id"]
    assert any(r["id"] == payload["run_id"] for r in status_body["runs"])
    ctx.close()
