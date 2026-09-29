"""Tests for Channel Platforms REST configuration and live test endpoints in channel_ingress_api."""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from homun.routes.channel_ingress_api import router


@pytest.fixture
def api_client(tmp_path, monkeypatch):
    monkeypatch.setenv("HOMUN_DATA_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client


def test_channel_platforms_lifecycle(api_client):
    # 1. GET platforms list
    res = api_client.get("/v1/gateway/channels/platforms")
    assert res.status_code == 200
    data = res.json()
    assert "platforms" in data
    assert len(data["platforms"]) > 0
    telegram = next((p for p in data["platforms"] if p["id"] == "telegram"), None)
    assert telegram is not None
    assert telegram["enabled"] is False

    # 2. PUT platform configuration
    put_res = api_client.put(
        "/v1/gateway/channels/platforms/telegram",
        json={"enabled": True, "fields": {"bot_token": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"}},
    )
    assert put_res.status_code == 200
    assert put_res.json()["ok"] is True

    # 3. GET platforms list again -> verify persisted
    res2 = api_client.get("/v1/gateway/channels/platforms")
    tg2 = next(p for p in res2.json()["platforms"] if p["id"] == "telegram")
    assert tg2["enabled"] is True
    assert tg2["configured"] is True
    assert tg2["has_secrets"] is True

    # 4. POST test endpoint with empty/missing token
    test_fail = api_client.post("/v1/gateway/channels/platforms/telegram/test", json={"fields": {"bot_token": ""}})
    assert test_fail.status_code == 200
    assert test_fail.json()["ok"] is False

    # 5. POST test unknown platform
    test_unknown = api_client.post("/v1/gateway/channels/platforms/nonexistent/test", json={"fields": {"dummy": "value"}})
    assert test_unknown.status_code == 200
    assert test_unknown.json()["ok"] is False
    assert "non riconosciuta" in test_unknown.json()["message"]


def test_channel_platform_delete_removes_configuration(api_client):
    # 1. Configure telegram
    put_res = api_client.put(
        "/v1/gateway/channels/platforms/telegram",
        json={"enabled": True, "fields": {"bot_token": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"}},
    )
    assert put_res.status_code == 200

    # 2. DELETE removes it
    del_res = api_client.delete("/v1/gateway/channels/platforms/telegram")
    assert del_res.status_code == 200
    assert del_res.json()["ok"] is True
    assert del_res.json()["platform"] == "telegram"

    # 3. Platform is back to unconfigured/disabled
    res = api_client.get("/v1/gateway/channels/platforms")
    tg = next(p for p in res.json()["platforms"] if p["id"] == "telegram")
    assert tg["enabled"] is False
    assert tg["configured"] is False
    assert tg["fields"] == {}

    # 4. Live adapter config was cleared
    from homun.routes.channel_ingress_api import get_channel_registry
    adapter = get_channel_registry().get_adapter("telegram")
    assert adapter is not None
    assert not (getattr(adapter, "config", None) or {}).get("TELEGRAM_BOT_TOKEN")
    assert not (getattr(adapter, "config", None) or {}).get("bot_token")

    # 5. Deleting again is a typed 404
    del_again = api_client.delete("/v1/gateway/channels/platforms/telegram")
    assert del_again.status_code == 404
    assert del_again.json()["detail"]["code"] == "channel_platform_not_configured"


def test_telegram_onboarding_lifecycle(api_client, monkeypatch):
    from homun.routes import channel_ingress_api

    # Mock the external service response
    class FakeResponse:
        status_code = 201
        text = "{}"

        def json(self):
            return {
                "pairing_id": "test_pair_123",
                "poll_token": "secret_poll_token",
                "deep_link": "https://t.me/TestBot?start=pair_test_pair_123",
                "qr_payload": "https://t.me/TestBot?start=pair_test_pair_123",
                "expires_at": "2026-09-28T21:00:00Z",
                "suggested_username": "test_bot",
            }

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, json=None, headers=None, **kwargs):
            return FakeResponse()

        async def get(self, url, headers=None, **kwargs):
            class ReadyResp:
                status_code = 200
                text = "{}"

                def json(self):
                    return {
                        "status": "ready",
                        "token": "123456:FAKE_TOKEN_FOR_TEST",
                        "bot_username": "my_new_bot",
                        "owner_user_id": "999888777",
                    }
            return ReadyResp()

    monkeypatch.setattr(channel_ingress_api.httpx, "AsyncClient", FakeAsyncClient)

    # 1. Start onboarding
    start_res = api_client.post("/v1/gateway/channels/telegram/onboarding/start", json={"bot_name": "Test Agent"})
    assert start_res.status_code == 200
    data = start_res.json()
    assert data["pairing_id"] == "test_pair_123"
    assert "t.me/TestBot" in data["deep_link"]

    # 2. Get status -> ready
    status_res = api_client.get("/v1/gateway/channels/telegram/onboarding/test_pair_123")
    assert status_res.status_code == 200
    assert status_res.json()["status"] == "ready"
    assert status_res.json()["bot_username"] == "my_new_bot"
    assert status_res.json()["owner_user_id"] == "999888777"

    # 3. Apply onboarding
    apply_res = api_client.post("/v1/gateway/channels/telegram/onboarding/test_pair_123/apply", json={})
    assert apply_res.status_code == 200
    assert apply_res.json()["ok"] is True
    assert apply_res.json()["platform"] == "telegram"

    # 4. Verify in platforms list
    platforms_res = api_client.get("/v1/gateway/channels/platforms")
    tg = next(p for p in platforms_res.json()["platforms"] if p["id"] == "telegram")
    assert tg["enabled"] is True
    assert tg["configured"] is True

