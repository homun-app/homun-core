"""Extend MCP client with resources, prompts, and explicit sampling/elicitation gates (H36).

Discovery still never grants execution. Sampling and elicitation require injected
callbacks; the default refuses with typed MCP ErrorData so servers cannot obtain
silent model or human answers.
"""
from __future__ import annotations

import asyncio
import fnmatch
import os
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable, Optional

import anyio
import httpx
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client, get_default_environment
from mcp.client.streamable_http import streamable_http_client

from homun.domain.models import ExternalServer

PROBE_TIMEOUT_SECONDS = 10.0
MAX_DISCOVERY_PAGES = 100
MCP_PROTOCOL_VERSION = "2025-06-18"  # SDK negotiates supported protocol versions.
PROBE_RECONNECT_ATTEMPTS = 2  # discovery-only reconnect; never after tools/call starts

SamplingCallback = Callable[[Any, types.CreateMessageRequestParams], Awaitable[Any]]
ElicitationCallback = Callable[[Any, types.ElicitRequestParams], Awaitable[Any]]

_sampling_callback: Optional[SamplingCallback] = None
_elicitation_callback: Optional[ElicitationCallback] = None


def set_sampling_callback(callback: Optional[SamplingCallback]) -> None:
    """Install product-owned sampling; None restores refuse-by-default."""
    global _sampling_callback
    _sampling_callback = callback


def set_elicitation_callback(callback: Optional[ElicitationCallback]) -> None:
    """Install product-owned elicitation; None restores refuse-by-default."""
    global _elicitation_callback
    _elicitation_callback = callback


async def _refuse_sampling(context, params: types.CreateMessageRequestParams):
    return types.ErrorData(
        code=types.INVALID_REQUEST,
        message=(
            "MCP sampling is not configured for this Homun session. "
            "Refusing createMessage without an authorized model callback."
        ),
    )


async def _refuse_elicitation(context, params: types.ElicitRequestParams):
    return types.ErrorData(
        code=types.INVALID_REQUEST,
        message=(
            "MCP elicitation is not configured for this Homun session. "
            "Refusing elicit without an authorized human consent callback."
        ),
    )


def filtered_tools(server: ExternalServer, tools: list[dict[str, Any]]) -> list[str]:
    """The declared surface: include wins over exclude (precedence semantics)."""
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



def _require_transport_auth(server: ExternalServer) -> Optional[str]:
    """Resolve OAuth access token via real token broker if declared; refuse on missing credentials."""
    if str(getattr(server, "oauth_client_id", "") or "").strip() or str(
        getattr(server, "oauth_token_url", "") or ""
    ).strip():
        from homun.application.mcp_oauth import get_mcp_oauth_broker

        broker = get_mcp_oauth_broker()
        return broker.get_access_token(server)
    return None


def _httpx_mtls_cert(server: ExternalServer):
    cert = str(getattr(server, "mtls_cert_path", "") or "").strip()
    key = str(getattr(server, "mtls_key_path", "") or "").strip()
    if cert and key:
        return (cert, key)
    if cert:
        return cert
    return None


@asynccontextmanager
async def _transport(server: ExternalServer):
    bearer_token = _require_transport_auth(server)
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
        headers = dict(server.headers)
        if bearer_token:
            headers["Authorization"] = f"Bearer {bearer_token}"
        cert = _httpx_mtls_cert(server)
        async with httpx.AsyncClient(headers=headers, timeout=PROBE_TIMEOUT_SECONDS,
                                     follow_redirects=False, cert=cert) as client:
            async with streamable_http_client(server.url, http_client=client) as streams:
                yield streams[0], streams[1]
    else:
        raise RuntimeError("Unsupported MCP transport")


class MCPPreflightError(RuntimeError):
    """The call was rejected before tools/call was sent."""


async def _paginate(session, list_fn) -> list[dict[str, Any]]:
    items, cursor, seen = [], None, set()
    for _ in range(MAX_DISCOVERY_PAGES):
        page = await list_fn(params=types.PaginatedRequestParams(cursor=cursor) if cursor else None)
        batch = getattr(page, "tools", None)
        if batch is None:
            batch = getattr(page, "resources", None)
        if batch is None:
            batch = getattr(page, "prompts", None)
        if batch is None:
            batch = getattr(page, "resourceTemplates", None) or getattr(page, "resource_templates", None) or []
        items.extend(t.model_dump(mode="json", by_alias=True, exclude_none=True) for t in batch)
        cursor = page.next_cursor
        if not cursor:
            return items
        if cursor in seen:
            raise RuntimeError("MCP discovery repeated a pagination cursor")
        seen.add(cursor)
    raise RuntimeError("MCP discovery exceeded page limit")


async def _discover_tools(session):
    return await _paginate(session, session.list_tools)


async def _discover_resources(session):
    try:
        return await _paginate(session, session.list_resources)
    except Exception:
        return []


async def _discover_prompts(session):
    try:
        return await _paginate(session, session.list_prompts)
    except Exception:
        return []


async def _operation(
    server: ExternalServer,
    tool_name: str | None,
    arguments: dict[str, Any],
    expected_descriptor=None,
    dispatch_state=None,
    *,
    resource_uri: str | None = None,
    prompt_name: str | None = None,
    prompt_arguments: dict[str, Any] | None = None,
):
    with anyio.fail_after(PROBE_TIMEOUT_SECONDS):
        async with _transport(server) as (read, write):
            async with ClientSession(
                read,
                write,
                read_timeout_seconds=PROBE_TIMEOUT_SECONDS,
                client_info=types.Implementation(name="homun-engine", version="0.1.0"),
                sampling_callback=_sampling_callback or _refuse_sampling,
                elicitation_callback=_elicitation_callback or _refuse_elicitation,
            ) as session:
                initialized = await session.initialize()
                if tool_name is not None:
                    if expected_descriptor is not None:
                        from homun.application.mcp_contracts import select_descriptor, validate_arguments, require_same_descriptor
                        try:
                            descriptors = await _discover_tools(session)
                            actual = select_descriptor(descriptors, tool_name)
                            require_same_descriptor(expected_descriptor, actual)
                            validate_arguments(actual, arguments)
                        except Exception as exc:
                            raise MCPPreflightError('Tool contract preflight rejected; no call sent') from exc
                    if dispatch_state is not None:
                        dispatch_state['started'] = True
                    result = await session.call_tool(tool_name, arguments)
                    raw = result.model_dump(mode="json", by_alias=True, exclude_none=True)
                    content = raw.get("content", [])
                    return {"text": "\n".join(item["text"] for item in content
                                             if item.get("type") == "text"),
                            "is_error": bool(raw.get("isError", False)),
                            "content": content,
                            "structured_content": raw.get("structuredContent")}
                if resource_uri is not None:
                    if dispatch_state is not None:
                        dispatch_state['started'] = True
                    result = await session.read_resource(resource_uri)
                    raw = result.model_dump(mode="json", by_alias=True, exclude_none=True)
                    return {"uri": resource_uri, "contents": raw.get("contents") or []}
                if prompt_name is not None:
                    if dispatch_state is not None:
                        dispatch_state['started'] = True
                    raw_args = prompt_arguments or {}
                    str_args = {str(k): str(v) for k, v in raw_args.items()}
                    result = await session.get_prompt(prompt_name, str_args or None)
                    raw = result.model_dump(mode="json", by_alias=True, exclude_none=True)
                    return {
                        "name": prompt_name,
                        "description": raw.get("description"),
                        "messages": raw.get("messages") or [],
                    }
                discovered = await _discover_tools(session)
                allowed = set(filtered_tools(server, discovered))
                descriptors = [tool for tool in discovered if tool["name"] in allowed]
                caps = initialized.capabilities
                resources: list[dict[str, Any]] = []
                prompts: list[dict[str, Any]] = []
                if getattr(caps, "resources", None) is not None:
                    resources = await _discover_resources(session)
                if getattr(caps, "prompts", None) is not None:
                    prompts = await _discover_prompts(session)
                return {"ok": True,
                        "server_info": initialized.server_info.model_dump(mode="json", by_alias=True),
                        "tools": [tool["name"] for tool in descriptors],
                        "tool_descriptors": descriptors,
                        "tool_count_total": len(discovered),
                        "resources": resources,
                        "resource_uris": [str(r.get("uri") or "") for r in resources if r.get("uri")],
                        "prompts": prompts,
                        "prompt_names": [str(p.get("name") or "") for p in prompts if p.get("name")],
                        "sampling_configured": _sampling_callback is not None,
                        "elicitation_configured": _elicitation_callback is not None}


def _run(server: ExternalServer, tool_name: str | None, arguments: dict[str, Any], expected_descriptor=None,
         *, resource_uri: str | None = None, prompt_name: str | None = None,
         prompt_arguments: dict[str, Any] | None = None):
    if server.status != "enabled":
        raise RuntimeError("Server is disabled")
    dispatch_state = {"started": False}
    discovery_only = tool_name is None and resource_uri is None and prompt_name is None
    attempts = PROBE_RECONNECT_ATTEMPTS if discovery_only else 1
    last_exc: Exception | None = None
    for attempt in range(attempts):
        dispatch_state["started"] = False
        try:
            return asyncio.run(_operation(
                server, tool_name, arguments, expected_descriptor, dispatch_state,
                resource_uri=resource_uri, prompt_name=prompt_name, prompt_arguments=prompt_arguments,
            ))
        except Exception as exc:
            last_exc = exc
            if expected_descriptor is not None and not dispatch_state["started"]:
                raise MCPPreflightError("Tool contract preflight failed; no call sent") from exc
            leaf = exc
            while isinstance(leaf, BaseExceptionGroup) and leaf.exceptions:
                leaf = leaf.exceptions[0]
            if isinstance(leaf, MCPPreflightError):
                raise leaf from exc
            # Reconnect only for discovery before any external effect.
            if discovery_only and attempt + 1 < attempts and not dispatch_state["started"]:
                continue
            raise RuntimeError(f"MCP operation failed: {type(leaf).__name__}: {leaf}") from exc
    assert last_exc is not None
    raise RuntimeError(f"MCP operation failed after reconnect: {last_exc}") from last_exc


def probe_server(server: ExternalServer) -> dict[str, Any]:
    """Discover tools, resources, and prompts; retain the existing public names list."""
    return _run(server, None, {})


def call_tool(server: ExternalServer, tool_name: str, arguments: dict[str, Any], expected_descriptor=None) -> dict[str, Any]:
    """Execute once, preserving structured and non-text content for the owner."""
    if not filtered_tools(server, [{"name": tool_name}]):
        raise RuntimeError(f"Tool {tool_name!r} is not in the declared allowlist")
    return _run(server, tool_name, arguments, expected_descriptor)


def read_resource(server: ExternalServer, uri: str) -> dict[str, Any]:
    """Read one MCP resource URI through the live session."""
    if not str(uri or "").strip():
        raise RuntimeError("Resource URI is required")
    return _run(server, None, {}, resource_uri=uri)


def get_prompt(server: ExternalServer, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    """Fetch one MCP prompt template through the live session."""
    if not str(name or "").strip():
        raise RuntimeError("Prompt name is required")
    return _run(server, None, {}, prompt_name=name, prompt_arguments=arguments or {})
