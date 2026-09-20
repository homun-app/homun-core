"""F3.5 slice E — true ModelPort / provider token streaming."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.models.openai_compat import SECRET_KEY, OpenAICompatibleProvider
from homun.models.registry import build_default_registry
from homun.models.secrets import MemorySecretStore
from homun.models.types import ChatMessage


def test_fake_provider_stream_yields_chunks(tmp_path: Path) -> None:
    registry = build_default_registry(tmp_path, for_tests=True)
    chunks = list(
        registry.stream([ChatMessage(role="user", content="ciao catalogo")], provider_id="fake")
    )
    assert len(chunks) >= 2
    assert "catalogo" in "".join(chunks).lower() or "fake" in "".join(chunks).lower()
    assert registry.list_usage()
    assert registry.list_usage()[-1].status == "ok"


def test_openai_compat_stream_parses_sse_chunks() -> None:
    secrets = MemorySecretStore()
    secrets.put(SECRET_KEY, "test-key")
    provider = OpenAICompatibleProvider(
        secrets=secrets,
        base_url="https://api.example.com/v1",
        default_model="gpt-test",
    )
    sse_body = (
        b'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'
        b'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
        b'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        b'"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'
        b"data: [DONE]\n\n"
    )

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return sse_body

        def __iter__(self):
            for line in sse_body.splitlines(keepends=True):
                yield line

    with patch("homun.models.openai_compat.urlopen", return_value=_Resp()):
        chunks = list(provider.stream([ChatMessage(role="user", content="hi")]))
    assert chunks == ["Hel", "lo"]
    assert provider.last_stream_result is not None
    assert provider.last_stream_result.text == "Hello"
    assert provider.last_stream_result.usage.input_tokens == 3
    assert provider.last_stream_result.usage.output_tokens == 2


def test_chat_stream_emits_tokens_before_result(tmp_path: Path) -> None:
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    )
    app = create_app()
    with TestClient(app) as client:
        with client.stream(
            "POST",
            "/v1/models/chat/stream",
            json={
                "messages": [{"role": "user", "content": "ciao catalogo"}],
                "connection_id": "fake",
            },
        ) as response:
            assert response.status_code == 200
            body = "".join(response.iter_text())
        assert "event: token" in body
        assert "event: result" in body
        token_pos = body.index("event: token")
        result_pos = body.index("event: result")
        assert token_pos < result_pos
    reset_context_for_tests(None)


def test_command_stream_tokens_mark_provider_source(tmp_path: Path) -> None:
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    try:
        headers = {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}
        conv = client.post(
            f"/v1/workspaces/{ctx.workspace_id}/commands",
            headers=headers,
            json={
                "command_id": "cmd_conv_ps",
                "type": "conversation.create",
                "payload": {"title": "Stream"},
            },
        )
        assert conv.status_code == 200
        conversation_id = conv.json()["result"]["conversation_id"]
        with client.stream(
            "POST",
            f"/v1/workspaces/{ctx.workspace_id}/commands/stream",
            headers=headers,
            json={
                "command_id": "cmd_msg_ps",
                "type": "conversation.post_message",
                "payload": {
                    "conversation_id": conversation_id,
                    "text": "ok",
                },
            },
        ) as response:
            assert response.status_code == 200
            body = "".join(response.iter_text())
        assert '"source": "modelport"' in body or '"source":"modelport"' in body
        assert "event: token" in body
        assert "event: result" in body
    finally:
        reset_context_for_tests(None)
        ctx.repository.close()
