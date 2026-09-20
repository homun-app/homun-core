"""F3.1 model provider + secret store tests."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.models.fake import FakeProvider
from homun.models.openai_compat import OpenAICompatibleProvider, assistant_text_from_message
from homun.models.registry import ModelRegistry
from homun.models.secrets import MemorySecretStore
from homun.models.types import ChatMessage


def test_fake_provider_is_deterministic() -> None:
    provider = FakeProvider()
    messages = [ChatMessage(role="user", content="Prepara il catalogo autunno")]
    first = provider.complete(messages)
    second = provider.complete(messages)
    assert first.text == second.text
    assert "catalogo" in first.text.lower() or "Catalogo" in first.text
    assert first.usage.status == "ok"
    assert provider.verify_connection().ok is True


def test_registry_list_connections_marks_active(tmp_path: Path) -> None:
    registry = ModelRegistry(
        data_dir=tmp_path,
        secrets=MemorySecretStore(),
        active_provider_id="fake",
    )
    items = {c.id: c for c in registry.list_connections()}
    assert items["fake"].active is True
    assert items["openai_compatible"].active is False
    registry.set_active("openai_compatible")
    assert registry.get_connection("openai_compatible").active is True

    registry = ModelRegistry(
        data_dir=tmp_path,
        secrets=MemorySecretStore(),
        active_provider_id="fake",
    )
    assert registry.active_provider_id == "fake"
    registry.set_openai_credentials(
        api_key="sk-test",
        base_url="http://127.0.0.1:9999/v1",
        default_model="local-model",
    )
    providers = {p.id: p for p in registry.list_providers()}
    assert providers["openai_compatible"].credential_present is True
    assert providers["openai_compatible"].base_url == "http://127.0.0.1:9999/v1"
    registry.set_active_provider("openai_compatible")
    assert registry.active_provider_id == "openai_compatible"
    # Verify fails without a live server — credential present but unreachable.
    result = registry.verify("openai_compatible")
    assert result.ok is False
    assert "Missing" not in result.message


def test_http_models_fake_complete(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_local.sqlite3"
    ctx = create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    app = create_app()
    with TestClient(app) as client:
        listed = client.get("/v1/models/providers")
        assert listed.status_code == 200
        body = listed.json()
        assert body["active_provider_id"] == "fake"
        assert any(item["id"] == "fake" for item in body["items"])

        connections = client.get("/v1/models/connections")
        assert connections.status_code == 200
        conn_body = connections.json()
        assert conn_body["active_connection_id"] == "fake"
        assert any(item["id"] == "fake" and item["active"] for item in conn_body["items"])

        verified = client.post("/v1/models/providers/fake/verify")
        assert verified.status_code == 200
        assert verified.json()["ok"] is True

        completed = client.post(
            "/v1/models/complete",
            json={
                "messages": [{"role": "user", "content": "Analizza i log di errore"}],
                "provider_id": "fake",
            },
        )
        assert completed.status_code == 200, completed.text
        text = completed.json()["text"]
        assert "fake:" in text
        assert "log" in text.lower()

        chat = client.post(
            "/v1/models/chat",
            json={
                "messages": [{"role": "user", "content": "Ciao catalogo"}],
                "connection_id": "fake",
            },
        )
        assert chat.status_code == 200, chat.text
        assert chat.json()["text"]

        usage = client.get("/v1/models/usage")
        assert usage.status_code == 200
        assert len(usage.json()["items"]) >= 1

        caps = client.get("/v1/capabilities")
        assert caps.json()["features"]["models"] is True

    reset_context_for_tests(None)


def test_credentials_endpoint_requires_key(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_local.sqlite3"
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    )
    app = create_app()
    with TestClient(app) as client:
        bad = client.post(
            "/v1/models/providers/openai_compatible/credentials",
            json={"api_key": "   "},
        )
        assert bad.status_code == 400
        ok = client.post(
            "/v1/models/providers/openai_compatible/credentials",
            json={"api_key": "sk-demo", "base_url": "https://example.test/v1"},
        )
        assert ok.status_code == 200
        assert ok.json()["credential_present"] is True
    reset_context_for_tests(None)


def test_assistant_text_prefers_content_over_reasoning() -> None:
    assert (
        assistant_text_from_message({"content": "final", "reasoning": "trace"}) == "final"
    )
    assert assistant_text_from_message({"content": "", "reasoning": '{"kind":"reply"}'}) == (
        '{"kind":"reply"}'
    )
    assert assistant_text_from_message({"content": "  ", "thinking": "trace"}) == "trace"
    assert assistant_text_from_message({"content": None}) == ""


def test_local_ollama_uses_native_chat_root() -> None:
    provider = OpenAICompatibleProvider(
        secrets=MemorySecretStore(),
        base_url="http://127.0.0.1:11434/v1",
        default_model="qwen3.5:4b",
    )
    assert provider._ollama_native_root() == "http://127.0.0.1:11434"
    remote = OpenAICompatibleProvider(
        secrets=MemorySecretStore(),
        base_url="https://api.openai.com/v1",
        default_model="gpt-4o-mini",
    )
    assert remote._ollama_native_root() is None
