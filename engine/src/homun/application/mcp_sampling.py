"""Product-owned MCP sampling callback (H36).

When HOMUN_MCP_SAMPLING=1 and a completion callable is installed, Homun answers
createMessage requests via the engine model path. Default remains refuse-by-default.
"""
from __future__ import annotations

import os
from typing import Any, Awaitable, Callable, Optional

from mcp import types

from homun.application import mcp_client

CompleteFn = Callable[[list[dict[str, str]], Optional[str]], str]


def mcp_sampling_enabled() -> bool:
    return str(os.environ.get("HOMUN_MCP_SAMPLING") or "").strip() in {"1", "true", "yes"}


def _messages_from_params(params: types.CreateMessageRequestParams) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for msg in params.messages or []:
        role = str(getattr(msg, "role", "user") or "user")
        content = getattr(msg, "content", None)
        text = ""
        if isinstance(content, list):
            parts = []
            for block in content:
                if getattr(block, "type", None) == "text":
                    parts.append(str(getattr(block, "text", "") or ""))
                elif isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
            text = "\n".join(parts)
        elif getattr(content, "type", None) == "text":
            text = str(getattr(content, "text", "") or "")
        elif isinstance(content, str):
            text = content
        out.append({"role": role, "content": text})
    return out


def build_sampling_callback(complete: CompleteFn) -> mcp_client.SamplingCallback:
    async def _callback(_context: Any, params: types.CreateMessageRequestParams):
        if not mcp_sampling_enabled():
            return types.ErrorData(
                code=types.INVALID_REQUEST,
                message="MCP sampling is disabled (set HOMUN_MCP_SAMPLING=1).",
            )
        messages = _messages_from_params(params)
        model = str(getattr(params, "modelPreferences", None) and getattr(params.modelPreferences, "hints", None) or "") or None
        try:
            text = complete(messages, model)
        except Exception as exc:
            return types.ErrorData(
                code=types.INTERNAL_ERROR,
                message=f"Homun sampling failed: {exc}",
            )
        return types.CreateMessageResult(
            role="assistant",
            content=types.TextContent(type="text", text=text),
            model=str(model or "homun"),
            stop_reason="endTurn",
        )

    return _callback


def install_product_sampling(complete: CompleteFn) -> bool:
    """Install sampling when opt-in env is set; returns True if installed."""
    if not mcp_sampling_enabled():
        mcp_client.set_sampling_callback(None)
        return False
    mcp_client.set_sampling_callback(build_sampling_callback(complete))
    return True
