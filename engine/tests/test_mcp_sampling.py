"""H36 product MCP sampling opt-in tests."""
from __future__ import annotations

import asyncio

from mcp import types

from homun.application import mcp_client
from homun.application.mcp_sampling import build_sampling_callback, install_product_sampling, mcp_sampling_enabled


def test_sampling_disabled_by_default(monkeypatch):
    monkeypatch.delenv("HOMUN_MCP_SAMPLING", raising=False)
    assert mcp_sampling_enabled() is False
    assert install_product_sampling(lambda m, mid=None: "x") is False


def test_sampling_callback_uses_complete(monkeypatch):
    monkeypatch.setenv("HOMUN_MCP_SAMPLING", "1")
    seen = {}

    def complete(messages, model_id=None):
        seen["messages"] = messages
        return "homun-answer"

    cb = build_sampling_callback(complete)
    params = types.CreateMessageRequestParams(
        messages=[
            types.SamplingMessage(
                role="user",
                content=types.TextContent(type="text", text="ping"),
            )
        ],
        maxTokens=64,
    )
    result = asyncio.run(cb(None, params))
    assert isinstance(result, types.CreateMessageResult)
    assert result.content.text == "homun-answer"
    assert seen["messages"][0]["content"] == "ping"
    assert install_product_sampling(complete) is True
    assert mcp_client._sampling_callback is not None
    mcp_client.set_sampling_callback(None)
