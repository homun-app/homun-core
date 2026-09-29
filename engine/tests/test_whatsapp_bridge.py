"""WhatsApp bridge: adapter, onboarding endpoints and platform registration."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from homun.application.whatsapp_bridge_adapter import WhatsAppBridgeAdapter
from homun.context import create_context, reset_context_for_tests
from homun.routes.channel_ingress_api import reset_channel_registry, router


@pytest.fixture
def api(tmp_path):
    # Explicit isolated context: the routes resolve data_dir through
    # get_context() and must never touch the real engine data directory.
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    reset_channel_registry()
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client
    reset_channel_registry()
    reset_context_for_tests(None)


def _status_payload(*, paired=False, jid=None, qr=True, logged_out=False):
    payload = {
        "ok": True,
        "service": "wa-rs-bridge",
        "paired": paired,
        "jid": jid,
        "logged_out": logged_out,
        "qr": {"payload": "2@qr-payload-data", "expires_at": "2026-09-29T13:00:00+00:00"} if qr else None,
        "pair_code": None,
    }
    return payload


def test_parse_inbound_maps_bridge_callback(api):
    adapter = WhatsAppBridgeAdapter()
    msg = adapter.parse_inbound({
        "source": "wa-rs-bridge",
        "message": {
            "id": "msgid-1",
            "chat": "393331234567@s.whatsapp.net",
            "sender": "393331234567@s.whatsapp.net",
            "push_name": "Fabio",
            "is_group": False,
            "text": "Ciao Homun",
            "timestamp": "2026-09-29T12:00:00+00:00",
        },
    })
    assert msg.platform == "whatsapp"
    assert msg.channel_id == "393331234567@s.whatsapp.net"
    assert msg.user_id == "393331234567@s.whatsapp.net"
    assert msg.username == "Fabio"
    assert msg.text == "Ciao Homun"
    assert msg.is_direct is True


def test_send_failure_is_typed_when_bridge_unreachable():
    adapter = WhatsAppBridgeAdapter({"bridge_url": "http://127.0.0.1:59999"})
    result = adapter.send("393331234567", "ciao")
    assert result["delivered"] is False
    assert "unreachable" in result["error"]


def test_whatsapp_platform_registered_as_bridge():
    from homun.routes.channel_ingress_api import get_channel_registry
    registry = get_channel_registry()
    adapter = registry.get_adapter("whatsapp")
    assert isinstance(adapter, WhatsAppBridgeAdapter)
    cloud = registry.get_adapter("whatsapp_cloud")
    assert cloud is not None and cloud.platform == "whatsapp_cloud"


def test_onboarding_flow_from_qr_to_ready_and_apply(api, monkeypatch):
    bridge = WhatsAppBridgeAdapter()
    pairing_done = {"value": False}

    def fake_status(timeout=5.0):
        if pairing_done["value"]:
            return _status_payload(paired=True, jid="393331234567@s.whatsapp.net")
        return _status_payload(paired=False)

    monkeypatch.setattr(WhatsAppBridgeAdapter, "bridge_status", fake_status)

    # 1. start → waiting with QR payload
    start = api.post("/v1/gateway/channels/whatsapp/onboarding/start")
    assert start.status_code == 200
    data = start.json()
    assert data["paired"] is False
    assert data["qr_payload"] == "2@qr-payload-data"
    pairing_id = data["pairing_id"]

    # 2. status while waiting
    status = api.get(f"/v1/gateway/channels/whatsapp/onboarding/{pairing_id}")
    assert status.json()["status"] == "waiting"

    # 3. phone completes linking → ready
    pairing_done["value"] = True
    status = api.get(f"/v1/gateway/channels/whatsapp/onboarding/{pairing_id}")
    assert status.json()["status"] == "ready"
    assert status.json()["jid"] == "393331234567@s.whatsapp.net"

    # 4. apply persists the channel with the paired account as sole authorized sender
    apply_res = api.post(f"/v1/gateway/channels/whatsapp/onboarding/{pairing_id}/apply", json={})
    assert apply_res.status_code == 200
    assert apply_res.json()["ok"] is True
    fields = apply_res.json()["fields"]
    assert fields["allowed_user_ids"] == "393331234567@s.whatsapp.net"

    # 5. platform list reflects the connection
    platforms = api.get("/v1/gateway/channels/platforms").json()["platforms"]
    wa = next(p for p in platforms if p["id"] == "whatsapp")
    assert wa["enabled"] is True
    assert wa["configured"] is True


def test_onboarding_start_unreachable_bridge_is_typed_502(api, monkeypatch):
    def unreachable(timeout=5.0):
        return None

    monkeypatch.setattr(WhatsAppBridgeAdapter, "bridge_status", unreachable)
    res = api.post("/v1/gateway/channels/whatsapp/onboarding/start")
    assert res.status_code == 502
    assert res.json()["detail"]["code"] == "bridge_unreachable"


def test_apply_before_ready_is_typed_400(api, monkeypatch):
    monkeypatch.setattr(WhatsAppBridgeAdapter, "bridge_status", lambda timeout=5.0: _status_payload(paired=False))
    start = api.post("/v1/gateway/channels/whatsapp/onboarding/start")
    pairing_id = start.json()["pairing_id"]
    res = api.post(f"/v1/gateway/channels/whatsapp/onboarding/{pairing_id}/apply", json={})
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "pairing_not_ready"
