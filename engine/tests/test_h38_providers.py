"""Tests for inference provider profiles, reasoning/media adaptation, credential pools, and auxiliary fallback (H38)."""
from __future__ import annotations

import time
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.auxiliary_router import AuxiliaryRouter, get_auxiliary_router, reset_auxiliary_router
from homun.application.credential_pool import (
    CredentialPool,
    STATUS_COOLDOWN,
    STATUS_DEAD,
    STATUS_OK,
    get_credential_pool,
    reset_credential_pool,
)
from homun.application.provider_contracts import ProviderProfile
from homun.application.provider_registry import (
    ProviderRegistry,
    get_provider_registry,
    reset_provider_registry,
)


@pytest.fixture(autouse=True)
def clean_h38_environment():
    reset_provider_registry()
    reset_credential_pool()
    reset_auxiliary_router()
    yield
    reset_provider_registry()
    reset_credential_pool()
    reset_auxiliary_router()


# 1. Provider profiles & catalog
def test_provider_profiles_and_catalog():
    registry = get_provider_registry()
    profiles = registry.list_profiles()
    names = {p.name for p in profiles}

    assert "openai" in names
    assert "anthropic" in names
    assert "openrouter" in names
    assert "deepseek" in names
    assert "gemini" in names
    assert "ollama" in names

    # Model resolution heuristics
    assert registry.resolve_provider_for_model("gpt-4o").name == "openai"
    assert registry.resolve_provider_for_model("claude-3-7-sonnet").name == "anthropic"
    assert registry.resolve_provider_for_model("deepseek-chat").name == "deepseek"
    assert registry.resolve_provider_for_model("gemini-2.0-flash").name == "gemini"
    assert registry.resolve_provider_for_model("meta-llama/llama-3.3-70b-instruct").name == "openrouter"
    assert registry.resolve_provider_for_model("llama3.2:latest").name == "ollama"


# 2. Reasoning adaptation
def test_provider_reasoning_adaptation():
    registry = get_provider_registry()

    # OpenAI: top-level reasoning_effort
    openai_p = registry.get_profile("openai")
    extra, top = openai_p.adapt_reasoning("medium")
    assert extra == {}
    assert top == {"reasoning_effort": "medium"}

    # OpenRouter: extra_body reasoning
    or_p = registry.get_profile("openrouter")
    extra, top = or_p.adapt_reasoning("high")
    assert extra == {"reasoning": {"effort": "high"}}
    assert top == {}

    # Anthropic: extra_body thinking budget
    anthropic_p = registry.get_profile("anthropic")
    extra, top = anthropic_p.adapt_reasoning("high")
    assert extra == {"thinking": {"type": "enabled", "budget_tokens": 8192}}
    assert top == {}

    # DeepSeek / Ollama: none (rejects parameter, omitted)
    deepseek_p = registry.get_profile("deepseek")
    extra, top = deepseek_p.adapt_reasoning("low")
    assert extra == {}
    assert top == {}


# 3. Media and Tool Result adaptation
def test_provider_media_and_tool_result_adaptation():
    registry = get_provider_registry()
    fixture = {"url": "https://example.com/chart.png", "alt": "Revenue Chart"}

    # Vision-capable provider (OpenAI)
    openai_p = registry.get_profile("openai")
    adapted_vis = openai_p.adapt_media_fixture(fixture)
    assert adapted_vis["type"] == "image_url"
    assert adapted_vis["image_url"]["url"] == "https://example.com/chart.png"

    # Non-vision provider (DeepSeek) -> fallback text representation
    deepseek_p = registry.get_profile("deepseek")
    adapted_non_vis = deepseek_p.adapt_media_fixture(fixture)
    assert adapted_non_vis["type"] == "text"
    assert "[Revenue Chart: https://example.com/chart.png]" in adapted_non_vis["text"]

    # Tool result adaptation: providers with supports_vision_tool_messages = False flatten to string
    parts = [
        {"type": "text", "text": "Analysis complete."},
        {"type": "image_url", "image_url": {"url": "https://example.com/output.png"}},
    ]
    # OpenAI keeps structured parts
    assert openai_p.adapt_tool_result_media(parts) == parts
    # DeepSeek flattens parts into text
    flattened = deepseek_p.adapt_tool_result_media(parts)
    assert isinstance(flattened, str)
    assert "Analysis complete." in flattened
    assert "[Media item: https://example.com/output.png]" in flattened


# 4. Schema adaptation
def test_provider_schema_adaptation():
    profile = ProviderProfile(
        name="strict_schema_provider",
        unsupported_response_formats=("json_schema",),
    )
    schema = {"type": "json_schema", "json_schema": {"name": "output", "schema": {}}}
    adapted = profile.adapt_schema(schema)
    assert adapted == {"type": "json_object"}


# 5. Credential pool rotation and cooldowns
def test_credential_pool_rotation_and_cooldown():
    pool = CredentialPool()
    c1 = pool.add_credential("openai", "sk-key-1", key_id="k1")
    c2 = pool.add_credential("openai", "sk-key-2", key_id="k2")

    # Round-robin acquisition
    acq1 = pool.acquire_credential("openai")
    assert acq1.key_id == "k1"
    assert acq1.usage_count == 1

    acq2 = pool.acquire_credential("openai")
    assert acq2.key_id == "k2"
    assert acq2.usage_count == 1

    # Next acquisition wraps around to k1
    acq3 = pool.acquire_credential("openai")
    assert acq3.key_id == "k1"

    # Report 429 rate limit on k1 -> cooldown
    pool.report_failure("openai", "k1", "rate_limit_exceeded (429)", cooldown_seconds=60.0)
    assert c1.status == STATUS_COOLDOWN
    assert not c1.is_available

    # With k1 in cooldown, subsequent acquisitions only yield k2
    acq_skip = pool.acquire_credential("openai")
    assert acq_skip.key_id == "k2"

    # Report terminal 401 on k2 -> dead
    pool.report_failure("openai", "k2", "401 unauthorized: invalid_api_key")
    assert c2.status == STATUS_DEAD
    assert not c2.is_available

    # Now both unavailable -> acquire returns None
    assert pool.acquire_credential("openai") is None

    # Fast-forward cooldown for k1
    c1.cooldown_until = time.time() - 1.0
    acq_recovered = pool.acquire_credential("openai")
    assert acq_recovered.key_id == "k1"
    assert acq_recovered.status == STATUS_OK


# 6. Auxiliary router with audited fallback
def test_auxiliary_router_audited_fallback():
    router = AuxiliaryRouter(
        custom_chains={
            "titling": [
                ("openai", "gpt-4o-mini"),
                ("anthropic", "claude-3-5-haiku-20241022"),
                ("ollama", "llama3.2:latest"),
            ]
        }
    )

    # Mock executor: fails on openai (simulate 429), succeeds on anthropic
    calls = []

    def mock_executor(provider, model, prompt, kwargs):
        calls.append((provider, model))
        if provider == "openai":
            raise RuntimeError("429 Too Many Requests")
        return {"text": "Generated Title", "tokens": 42}

    res = router.execute(
        task="titling",
        prompt="Generate title for meeting",
        executor=mock_executor,
        reasoning_effort="low",
    )

    assert res.task == "titling"
    assert res.provider_used == "anthropic"
    assert res.model_used == "claude-3-5-haiku-20241022"
    assert res.output == "Generated Title"
    assert res.fallback_occurred is True
    assert res.tokens_used == 42

    # Verify audit trail contains full history
    assert len(res.fallback_chain_audit) == 2
    assert res.fallback_chain_audit[0]["provider"] == "openai"
    assert res.fallback_chain_audit[0]["status"] == "failed"
    assert "429 Too Many Requests" in res.fallback_chain_audit[0]["error"]
    assert res.fallback_chain_audit[1]["provider"] == "anthropic"
    assert res.fallback_chain_audit[1]["status"] == "success"


# 7. REST API routes
def test_provider_routes_api():
    app = create_app()
    client = TestClient(app)

    # 1. GET /v1/providers
    resp = client.get("/v1/providers")
    assert resp.status_code == 200
    providers = resp.json()
    names = {p["name"] for p in providers}
    assert "openai" in names
    assert "anthropic" in names

    # 2. GET /v1/providers/openai
    resp = client.get("/v1/providers/openai")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "openai"
    assert data["supports_vision"] is True

    # 3. POST /v1/providers/openai/adapt
    resp = client.post(
        "/v1/providers/openai/adapt",
        json={
            "reasoning_effort": "high",
            "media_item": {"url": "https://example.com/photo.jpg", "alt": "Photo"},
        },
    )
    assert resp.status_code == 200
    adapt_data = resp.json()
    assert adapt_data["adapted_reasoning"]["top_level"] == {"reasoning_effort": "high"}
    assert adapt_data["adapted_media"]["type"] == "image_url"

    # 4. POST /v1/credentials/pool & GET /v1/credentials/pool
    resp = client.post(
        "/v1/credentials/pool",
        json={"provider": "anthropic", "secret_value": "sk-ant-testsecret12345678", "key_id": "ant_1"},
    )
    assert resp.status_code == 200
    assert resp.json()["key_id"] == "ant_1"
    assert resp.json()["masked_secret"] == "sk-a...5678"

    resp = client.get("/v1/credentials/pool?provider=anthropic")
    assert resp.status_code == 200
    creds = resp.json()
    assert len(creds) == 1
    assert creds[0]["key_id"] == "ant_1"

    # 5. POST /v1/credentials/pool/report (failure -> cooldown)
    resp = client.post(
        "/v1/credentials/pool/report",
        json={
            "provider": "anthropic",
            "key_id": "ant_1",
            "status": "failure",
            "error_type": "rate_limit_exceeded",
            "cooldown_seconds": 30.0,
        },
    )
    assert resp.status_code == 200
    assert resp.json()["success"] is True
