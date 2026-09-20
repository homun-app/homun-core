"""F3.5 slice C — SSE command stream with display tokens."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.routes.sse import chunk_text, sse_event


def test_chunk_text_and_sse_helpers() -> None:
    assert chunk_text("abcdefghij", size=4) == ["abcd", "efgh", "ij"]
    assert sse_event("token", {"text": "hi"}).startswith("event: token\n")


def test_post_message_stream_emits_tokens(tmp_path: Path) -> None:
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    try:
        headers = {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}
        conv = client.post(
            f"/v1/workspaces/{ctx.workspace_id}/commands",
            headers=headers,
            json={
                "command_id": "cmd_conv_stream",
                "type": "conversation.create",
                "payload": {"title": "Stream"},
            },
        )
        assert conv.status_code == 200, conv.text
        conversation_id = conv.json()["result"]["conversation_id"]

        with client.stream(
            "POST",
            f"/v1/workspaces/{ctx.workspace_id}/commands/stream",
            headers=headers,
            json={
                "command_id": "cmd_msg_stream",
                "type": "conversation.post_message",
                "payload": {
                    "conversation_id": conversation_id,
                    "text": "Ciao Homun, serve un catalogo prodotti",
                },
            },
        ) as response:
            assert response.status_code == 200
            body = "".join(response.iter_text())
        assert "event: phase" in body
        assert "event: token" in body
        assert "event: result" in body
        assert "assistant_text" in body
    finally:
        reset_context_for_tests(None)
        ctx.repository.close()
