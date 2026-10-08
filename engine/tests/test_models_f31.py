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


def test_provider_connection_upsert_and_pool_sync(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_sync.sqlite3"
    ctx = create_context(workspace_id="ws_sync", db_path=db_path, data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    with TestClient(create_app()) as client:
        res = client.post(
            "/v1/models/connections",
            json={
                "connection_id": "deepseek",
                "kind": "openai_compatible",
                "display_name": "DeepSeek",
                "model_id": "deepseek-chat",
                "api_key": "sk-deepseek-test-key-12345",
                "base_url": "https://api.deepseek.com/v1",
            },
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["id"] == "deepseek"
        assert data["credential_present"] is True
        assert data["model_id"] == "deepseek-chat"

        # Verify provider list sees credential present
        prov_res = client.get("/v1/models/providers")
        assert prov_res.status_code == 200
        providers = prov_res.json()["items"]
        deepseek_prov = next((p for p in providers if p["id"] == "deepseek"), None)
        assert deepseek_prov is not None
        assert deepseek_prov["credential_present"] is True
        assert deepseek_prov["default_model"] == "deepseek-chat"

        # Verify credential was added to credential pool
        cred_res = client.get("/v1/credentials/pool?provider=deepseek")
        assert cred_res.status_code == 200
        creds = cred_res.json()
        assert len(creds) >= 1
        assert creds[0]["provider"] == "deepseek"
        assert creds[0]["is_available"] is True

        # Verify endpoint accepts transient body
        verify_res = client.post(
            "/v1/models/providers/fake/verify",
            json={"api_key": "override-key"},
        )
        assert verify_res.status_code == 200
        assert verify_res.json()["ok"] is True
    reset_context_for_tests(None)


def test_ollama_preset_alias_resolves_saved_active_provider(tmp_path):
    """Configs saved by the UI may say active "ollama"; the preset IS the
    openai_compatible connection, and the registry must resolve the alias."""
    import json

    (tmp_path / "models.json").write_text(json.dumps({
        "active_provider_id": "ollama",
        "openai_compatible": {"base_url": "http://127.0.0.1:11434/v1", "default_model": "qwen3.5:4b"},
    }), encoding="utf-8")
    (tmp_path / "secrets.json").write_text(json.dumps({"provider:openai_compatible:api_key": "ollama"}), encoding="utf-8")
    from homun.models.registry import build_default_registry
    registry = build_default_registry(tmp_path)
    provider = registry._get_provider(None)
    assert provider is not None
    assert provider.provider_id == "openai_compatible"
    assert provider.base_url == "http://127.0.0.1:11434/v1"
    # The user's model choice survives the alias, instead of the builtin
    # profile default (llama3.2:latest) the saved active id would pick.
    assert provider.default_model == "qwen3.5:4b"
    assert registry._get_provider("ollama") is provider
