"""H39 Stdio ACP transport contract tests."""
from __future__ import annotations

import json
import stat
from pathlib import Path

from homun.application.acp_stdio_transport import StdioAcpTransport
from homun.application.copilot_acp_client import CopilotAcpClient


def _fake_acp_cli(tmp_path: Path) -> Path:
    """Minimal ACP server: initialize, session/new, session/prompt + one update chunk."""
    path = tmp_path / "fake-copilot"
    path.write_text(
        r'''#!/usr/bin/env python3
import json, sys
session_id = "sess-test-1"
for line in sys.stdin:
    req = json.loads(line)
    method = req.get("method")
    rid = req.get("id")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {"protocolVersion": 1}}), flush=True)
    elif method == "session/new":
        print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {"sessionId": session_id}}), flush=True)
    elif method == "session/prompt":
        text = ((req.get("params") or {}).get("prompt") or [{}])[0].get("text") or ""
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": f"echo:{text}"},
            }},
        }), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {"stopReason": "end_turn"}}), flush=True)
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": method}}), flush=True)
'''
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_stdio_acp_transport_runs_prompt(tmp_path):
    cli = _fake_acp_cli(tmp_path)
    transport = StdioAcpTransport(str(cli), args=[], cwd=str(tmp_path), timeout_seconds=10)
    out = transport.run("hello")
    assert out == "echo:hello"


def test_copilot_client_uses_stdio_transport_when_binary_present(tmp_path):
    cli = _fake_acp_cli(tmp_path)
    client = CopilotAcpClient(command=str(cli), args=[])
    result = client.run_turn("ping", timeout_seconds=10, cwd=str(tmp_path))
    assert result.is_available is True
    assert result.error is None
    assert result.text == "echo:ping"


def test_copilot_client_reports_failure_when_process_dies(tmp_path):
    bad = tmp_path / "bad-cli"
    bad.write_text("#!/bin/sh\nexit 1\n")
    bad.chmod(bad.stat().st_mode | stat.S_IXUSR)
    client = CopilotAcpClient(command=str(bad), args=[])
    result = client.run_turn("x", timeout_seconds=5, cwd=str(tmp_path))
    assert result.is_available is False
    assert result.error
    assert result.text == ""
