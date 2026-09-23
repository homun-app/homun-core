"""Minimal MCP client: JSON-RPC 2.0 over stdio subprocess or HTTP POST.

No external SDK: initialize + tools/list with strict timeouts. The subprocess
environment carries ONLY the declared variables plus a safe baseline — never
the caller's shell environment (Hermes rule, adopted).
"""
from __future__ import annotations
import json
import os
import subprocess
from typing import Any

from homun.domain.models import ExternalServer

PROBE_TIMEOUT_SECONDS = 10.0
_SAFE_BASELINE_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "")}
MCP_PROTOCOL_VERSION = "2025-06-18"


def _request(method: str, params: dict[str, Any], message_id: int) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "method": method, "params": params}


def _match(tool_name: str, patterns: list[str]) -> bool:
    import fnmatch
    return any(fnmatch.fnmatch(tool_name, pattern) for pattern in patterns)


def filtered_tools(server: ExternalServer, tools: list[dict[str, Any]]) -> list[str]:
    """The declared surface: include wins over exclude (Hermes semantics)."""
    names = []
    for tool in tools:
        name = str(tool.get("name") or "")
        if not name:
            continue
        if server.tools_include:
            if _match(name, server.tools_include):
                names.append(name)
        elif not _match(name, server.tools_exclude):
            names.append(name)
    return names


def _stdio_roundtrip(server: ExternalServer, messages: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    env = dict(_SAFE_BASELINE_ENV)
    env.update(server.env)
    payload = "".join(json.dumps(message) + "\n" for message in messages)
    process = subprocess.run(
        [server.command, *server.args],
        input=payload,
        capture_output=True,
        text=True,
        timeout=PROBE_TIMEOUT_SECONDS,
        env=env,
        check=False,
    )
    replies: dict[int, dict[str, Any]] = {}
    for line in process.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            reply = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(reply, dict) and isinstance(reply.get("id"), int):
            replies[reply["id"]] = reply
    if not replies:
        raise RuntimeError(
            f"MCP server produced no JSON-RPC reply (exit {process.returncode}): "
            f"{process.stderr.strip()[:200] or 'no stderr'}")
    return replies


def _http_roundtrip(server: ExternalServer, messages: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    from urllib.request import Request, urlopen
    from urllib.error import URLError

    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    headers.update(server.headers)
    replies: dict[int, dict[str, Any]] = {}
    for message in messages:
        request = Request(server.url, data=json.dumps(message).encode("utf-8"),
                          headers=headers, method="POST")
        try:
            with urlopen(request, timeout=PROBE_TIMEOUT_SECONDS) as response:
                reply = json.loads(response.read().decode("utf-8"))
        except (URLError, json.JSONDecodeError, OSError) as exc:
            raise RuntimeError(f"MCP HTTP call failed: {exc}") from exc
        if isinstance(reply, dict) and isinstance(reply.get("id"), int):
            replies[reply["id"]] = reply
    return replies


def probe_server(server: ExternalServer) -> dict[str, Any]:
    """Initialize + tools/list. Discovers; never executes a tool."""
    if server.status != "enabled":
        raise RuntimeError("Server is disabled")
    init = _request("initialize", {
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "homun-engine", "version": "0.1.0"},
    }, 1)
    tools = _request("tools/list", {}, 2)
    roundtrip = _stdio_roundtrip if server.transport == "stdio" else _http_roundtrip
    replies = roundtrip(server, [init, tools])
    init_reply = replies.get(1) or {}
    if "error" in init_reply:
        raise RuntimeError(f"initialize failed: {init_reply['error']}")
    tools_reply = replies.get(2) or {}
    if "error" in tools_reply:
        raise RuntimeError(f"tools/list failed: {tools_reply['error']}")
    discovered = tools_reply.get("result", {}).get("tools") or []
    if not isinstance(discovered, list):
        discovered = []
    return {
        "ok": True,
        "server_info": (init_reply.get("result") or {}).get("serverInfo") or {},
        "tools": filtered_tools(server, discovered),
        "tool_count_total": len(discovered),
    }
