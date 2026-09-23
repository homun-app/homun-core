"""Bounded MCP sessions; transport correctness belongs to the pinned MCP SDK.

Discovery never grants execution authority. Calls do not retry: a transport failure
may follow an external effect and must be reconciled by the invocation owner.
"""
from __future__ import annotations

import asyncio
import fnmatch
import os
from contextlib import asynccontextmanager
from typing import Any

import anyio
import httpx2
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client, get_default_environment
from mcp.client.streamable_http import streamable_http_client

from homun.domain.models import ExternalServer

PROBE_TIMEOUT_SECONDS = 10.0
MAX_DISCOVERY_PAGES = 100
MCP_PROTOCOL_VERSION = "2025-06-18"  # SDK negotiates supported protocol versions.


def filtered_tools(server: ExternalServer, tools: list[dict[str, Any]]) -> list[str]:
    """The declared surface: include wins over exclude (Hermes semantics)."""
    names = []
    for tool in tools:
        name = str(tool.get("name") or "")
        if not name:
            continue
        if server.tools_include:
            allowed = any(fnmatch.fnmatch(name, p) for p in server.tools_include)
        else:
            allowed = not any(fnmatch.fnmatch(name, p) for p in server.tools_exclude)
        if allowed:
            names.append(name)
    return names


@asynccontextmanager
async def _transport(server: ExternalServer):
    if server.transport == "stdio":
        # SDK merges its safe baseline. Explicitly blank its other inherited keys
        # so only PATH/HOME and the person's declarations carry values.
        env = {key: "" for key in get_default_environment()}
        env.update(PATH=os.environ.get("PATH", "/usr/bin:/bin"), HOME=os.environ.get("HOME", ""))
        env.update(server.env)
        params = StdioServerParameters(command=server.command, args=server.args, env=env)
        with open(os.devnull, "w") as errlog:
            async with stdio_client(params, errlog=errlog) as streams:
                yield streams[0], streams[1]
    elif server.transport == "http":
        async with httpx2.AsyncClient(headers=server.headers, timeout=PROBE_TIMEOUT_SECONDS,
                                     follow_redirects=False) as client:
            async with streamable_http_client(server.url, http_client=client) as streams:
                yield streams[0], streams[1]
    else:
        raise RuntimeError("Unsupported MCP transport")


async def _operation(server: ExternalServer, tool_name: str | None, arguments: dict[str, Any]):
    with anyio.fail_after(PROBE_TIMEOUT_SECONDS):
        async with _transport(server) as (read, write):
            async with ClientSession(read, write, read_timeout_seconds=PROBE_TIMEOUT_SECONDS,
                                     client_info=types.Implementation(name="homun-engine", version="0.1.0")) as session:
                initialized = await session.initialize()
                if tool_name is not None:
                    result = await session.call_tool(tool_name, arguments)
                    raw = result.model_dump(mode="json", by_alias=True, exclude_none=True)
                    content = raw.get("content", [])
                    return {"text": "\n".join(item["text"] for item in content
                                             if item.get("type") == "text"),
                            "is_error": bool(raw.get("isError", False)),
                            "content": content,
                            "structured_content": raw.get("structuredContent")}
                discovered = []
                cursor = None
                seen = set()
                for _ in range(MAX_DISCOVERY_PAGES):
                    page = await session.list_tools(params=types.PaginatedRequestParams(cursor=cursor) if cursor else None)
                    discovered.extend(t.model_dump(mode="json", by_alias=True, exclude_none=True) for t in page.tools)
                    cursor = page.next_cursor
                    if not cursor:
                        break
                    if cursor in seen:
                        raise RuntimeError("MCP discovery repeated a pagination cursor")
                    seen.add(cursor)
                else:
                    raise RuntimeError("MCP discovery exceeded page limit")
                allowed = set(filtered_tools(server, discovered))
                descriptors = [tool for tool in discovered if tool["name"] in allowed]
                return {"ok": True,
                        "server_info": initialized.server_info.model_dump(mode="json", by_alias=True),
                        "tools": [tool["name"] for tool in descriptors],
                        "tool_descriptors": descriptors,
                        "tool_count_total": len(discovered)}


def _run(server: ExternalServer, tool_name: str | None, arguments: dict[str, Any]):
    if server.status != "enabled":
        raise RuntimeError("Server is disabled")
    try:
        return asyncio.run(_operation(server, tool_name, arguments))
    except Exception as exc:
        # Exception groups from transport teardown often conceal the useful leaf.
        leaf = exc
        while isinstance(leaf, BaseExceptionGroup) and leaf.exceptions:
            leaf = leaf.exceptions[0]
        raise RuntimeError(f"MCP operation failed: {type(leaf).__name__}: {leaf}") from exc


def probe_server(server: ExternalServer) -> dict[str, Any]:
    """Discover complete descriptors; retain the existing public names list."""
    return _run(server, None, {})


def call_tool(server: ExternalServer, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Execute once, preserving structured and non-text content for the owner."""
    if not filtered_tools(server, [{"name": tool_name}]):
        raise RuntimeError(f"Tool {tool_name!r} is not in the declared allowlist")
    return _run(server, tool_name, arguments)
