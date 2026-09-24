"""Tests for Gateway Runtime, Pairing, Turn Leases, Hosted Rooms, and Channel Adapters (H32/H33).

Validates:
- DM pairing codes with unambiguous alphabet, TTL expiry, rate limiting, and brute-force lockout.
- Platform allowlists, operator approvals, and revocations.
- Strict turn lease serialization per session/topic with fail-closed timeout.
- Multi-agent hosted rooms with member roles, append-only event log, and topic isolation.
- Messaging platform adapters: Telegram, Discord, Slack, WhatsApp, and Webhook relay.
- Channel registry dispatch with authorization gate and turn leasing.
- Agent tool `gateway_manage` execution and schema registration.
"""
from __future__ import annotations

import time
import pytest

from homun.application.channel_adapters import (
    ChannelRegistry,
    DiscordAdapter,
    SlackAdapter,
    TelegramAdapter,
    WebhookRelayAdapter,
    WhatsAppAdapter,
)
from homun.application.gateway_contracts import (
    ChannelMedia,
    ChannelMessage,
    HostedRoom,
    HostedRoomMember,
    PairingRequest,
)
from homun.application.gateway_hosted_rooms import HostedRoomManager
from homun.application.gateway_pairing import GatewayPairingManager
from homun.application.gateway_tools import execute as gateway_execute, reset_gateway_state
from homun.application.gateway_turn_lease import TurnLeaseManager, TurnLeaseTimeout
from homun.domain.errors import ValidationError


@pytest.fixture(autouse=True)
def _pairing_in_memory(monkeypatch):
    """Keep pairing unit tests off the product HOMUN_DATA_DIR sqlite file."""
    monkeypatch.setenv("HOMUN_PAIRING_DB", ":memory:")
    reset_gateway_state()
    yield
    reset_gateway_state()


# ---------------------------------------------------------------------------
# 1. Pairing Lifecycle & Security Tests
# ---------------------------------------------------------------------------

def test_pairing_survives_store_reopen(tmp_path, monkeypatch):
    monkeypatch.delenv("HOMUN_PAIRING_DB", raising=False)
    db = tmp_path / "pairing.sqlite"
    mgr1 = GatewayPairingManager(db_path=db)
    req = mgr1.request_pairing("telegram", "persist_user", username="alice")
    mgr1.approve_code(req.code, approved_by="ops")
    assert mgr1.is_user_authorized("telegram", "persist_user")

    mgr2 = GatewayPairingManager(db_path=db)
    assert mgr2.is_user_authorized("telegram", "persist_user")
    restored = mgr2.get_request_by_code(req.code, now=req.created_at + 10)
    assert restored is not None
    assert restored.status == "approved"


def test_pairing_code_generation_and_unambiguous_alphabet():
    mgr = GatewayPairingManager()
    req = mgr.request_pairing("telegram", "123456", username="alice")
    assert req.status == "pending"
    assert len(req.code) == 8
    # Unambiguous alphabet excludes 0, O, 1, I
    for ch in "0O1I":
        assert ch not in req.code


def test_pairing_ttl_expiry():
    mgr = GatewayPairingManager(code_ttl_seconds=0.1)
    req = mgr.request_pairing("discord", "usr_999")
    assert mgr.get_request_by_code(req.code) is not None
    time.sleep(0.15)
    # Expired code cannot be fetched or approved
    assert mgr.get_request_by_code(req.code) is None
    with pytest.raises(ValueError, match="Invalid or expired"):
        mgr.approve_code(req.code)


def test_pairing_rate_limit_and_lockout():
    mgr = GatewayPairingManager(code_ttl_seconds=60.0, rate_limit_seconds=10.0, max_pending_per_user=2)
    # 1st request succeeds
    r1 = mgr.request_pairing("slack", "U12345")
    # Immediate 2nd request violates rate limit (10s)
    with pytest.raises(ValueError, match="Please wait"):
        mgr.request_pairing("slack", "U12345")

    # Brute-force lockout test
    mgr2 = GatewayPairingManager(max_verification_failures=3)
    target = mgr2.request_pairing("telegram", "target_user")
    for _ in range(3):
        with pytest.raises(ValueError, match="Invalid or expired"):
            mgr2.approve_code("WRONGCOD")

    # Now the manager is locked out
    with pytest.raises(ValueError, match="Too many failed attempts"):
        mgr2.approve_code(target.code)


def test_pairing_operator_approve_decline_and_revoke():
    mgr = GatewayPairingManager()
    req = mgr.request_pairing("telegram", "tg_user_1", username="bob")
    assert not mgr.is_user_authorized("telegram", "tg_user_1")

    # Operator approves
    approved = mgr.approve_code(req.code)
    assert approved.status == "approved"
    assert mgr.is_user_authorized("telegram", "tg_user_1")

    # Revoke user
    revoked = mgr.revoke_user("telegram", "tg_user_1")
    assert revoked is True
    assert not mgr.is_user_authorized("telegram", "tg_user_1")

    # Decline a new request
    req2 = mgr.request_pairing("telegram", "tg_user_2")
    declined = mgr.decline_code(req2.code)
    assert declined.status == "declined"
    assert not mgr.is_user_authorized("telegram", "tg_user_2")


def test_pairing_allowlist():
    mgr = GatewayPairingManager(
        allowlist_users={"discord:approved_user"},
        denylist_users={"discord:banned_user"},
    )
    assert mgr.is_user_authorized("discord", "approved_user")
    assert not mgr.is_user_authorized("discord", "banned_user")

    # Banned user cannot even request pairing
    with pytest.raises(ValueError, match="User is blocked"):
        mgr.request_pairing("discord", "banned_user")


# ---------------------------------------------------------------------------
# 2. Turn Lease Concurrency Tests
# ---------------------------------------------------------------------------

def test_turn_lease_lifecycle():
    lease_mgr = TurnLeaseManager(default_ttl=5.0)
    key = "session:test_1"

    token = lease_mgr.acquire(key, owner_key="actor_a", timeout=1.0)
    assert token.key == key
    assert token.owner_key == "actor_a"
    assert lease_mgr.is_locked(key)

    # Concurrency test: second attempt on same key fails with TurnLeaseTimeout
    with pytest.raises(TurnLeaseTimeout, match="Turn lease wait timed out"):
        lease_mgr.acquire(key, owner_key="actor_b", timeout=0.1)

    # Release frees the lease
    released = lease_mgr.release(token)
    assert released is True
    assert not lease_mgr.is_locked(key)

    # Subsequent acquisition succeeds
    token_b = lease_mgr.acquire(key, owner_key="actor_b", timeout=1.0)
    assert token_b.owner_key == "actor_b"
    lease_mgr.release(token_b)


def test_turn_lease_independent_keys():
    lease_mgr = TurnLeaseManager(default_ttl=5.0)
    t1 = lease_mgr.acquire("key_one", owner_key="a", timeout=0.5)
    t2 = lease_mgr.acquire("key_two", owner_key="b", timeout=0.5)
    assert lease_mgr.is_locked("key_one")
    assert lease_mgr.is_locked("key_two")
    lease_mgr.release(t1)
    lease_mgr.release(t2)


# ---------------------------------------------------------------------------
# 3. Hosted Rooms Tests
# ---------------------------------------------------------------------------

def test_hosted_room_lifecycle_and_events():
    rm = HostedRoomManager()
    room = rm.create_room(
        name="Architecture Discussion",
        topic="Design of Homun gateway runtime",
        owner_id="admin_1",
    )
    assert room.name == "Architecture Discussion"
    assert room.status == "active"
    assert "admin_1" in room.members
    assert room.members["admin_1"].role == "owner"

    # Member joins
    mem = rm.join_room(room.id, "agent_coder", role="member")
    assert mem.actor_id == "agent_coder"
    assert mem.role == "member"

    # Post events
    e1 = rm.post_event(room.id, "admin_1", kind="message.user", content="Welcome all")
    e2 = rm.post_event(room.id, "agent_coder", kind="message.agent", content="Ready to code")

    events = rm.get_events(room.id)
    assert len(events) == 4
    assert events[0].kind == "room.created"
    assert events[1].kind == "room.members_changed"
    assert events[2].id == e1.id
    assert events[3].content == "Ready to code"

    # Member leaves
    left = rm.leave_room(room.id, "agent_coder")
    assert left is True
    assert "agent_coder" not in rm.get_room(room.id).members

    # Disband room
    disbanded = rm.disband_room(room.id)
    assert disbanded.status == "disbanded"

    # Cannot post to disbanded room
    with pytest.raises(ValueError, match="is not active"):
        rm.post_event(room.id, "admin_1", kind="message.user", content="Anyone here?")


def test_hosted_room_topic_isolation():
    rm = HostedRoomManager()
    r1 = rm.create_room("Room A", "Topic A", "owner_a")
    r2 = rm.create_room("Room B", "Topic B", "owner_b")

    rm.post_event(r1.id, "owner_a", kind="msg", content="Hello A")
    rm.post_event(r2.id, "owner_b", kind="msg", content="Hello B")

    assert len(rm.get_events(r1.id)) == 2
    assert rm.get_events(r1.id)[-1].content == "Hello A"
    assert len(rm.get_events(r2.id)) == 2
    assert rm.get_events(r2.id)[-1].content == "Hello B"


# ---------------------------------------------------------------------------
# 4. Channel Adapters Tests
# ---------------------------------------------------------------------------

def test_telegram_adapter():
    adapter = TelegramAdapter()
    payload = {
        "message": {
            "message_id": 1001,
            "from": {"id": 888123, "username": "tg_tester"},
            "chat": {"id": 888123, "type": "private"},
            "text": "Hello Telegram bot",
            "date": 1720000000,
        }
    }
    msg = adapter.parse_inbound(payload)
    assert msg.platform == "telegram"
    assert msg.channel_id == "888123"
    assert msg.user_id == "888123"
    assert msg.username == "tg_tester"
    assert msg.text == "Hello Telegram bot"
    assert msg.is_direct is True

    out = adapter.send("888123", "Echo reply")
    assert out["delivered"] is False
    assert out.get("code") == "backend_unavailable"
    assert out["platform"] == "telegram"


def test_discord_adapter():
    adapter = DiscordAdapter()
    payload = {
        "id": "dsc_msg_1",
        "channel_id": "chan_444",
        "author": {"id": "dsc_usr_1", "username": "discord_dev"},
        "content": "!status check",
        "attachments": [
            {"filename": "log.txt", "content_type": "text/plain", "size": 128, "url": "https://cdn.discord.com/log.txt"}
        ],
    }
    msg = adapter.parse_inbound(payload)
    assert msg.platform == "discord"
    assert msg.channel_id == "chan_444"
    assert msg.user_id == "dsc_usr_1"
    assert msg.username == "discord_dev"
    assert msg.is_direct is True
    assert len(msg.media) == 1
    assert msg.media[0].file_name == "log.txt"


def test_slack_adapter():
    adapter = SlackAdapter()
    payload = {
        "event": {
            "type": "message",
            "ts": "1720000100.000200",
            "user": "U987654",
            "channel": "D0123456",
            "text": "Slack message in direct chat",
        }
    }
    msg = adapter.parse_inbound(payload)
    assert msg.platform == "slack"
    assert msg.channel_id == "D0123456"
    assert msg.user_id == "U987654"
    assert msg.is_direct is True


def test_whatsapp_adapter():
    adapter = WhatsAppAdapter()
    payload = {
        "entry": [
            {
                "changes": [
                    {
                        "value": {
                            "messages": [
                                {
                                    "id": "wa_msg_1",
                                    "from": "+393331234567",
                                    "text": {"body": "Ciao Homun"},
                                    "timestamp": "1720000200",
                                }
                            ]
                        }
                    }
                ]
            }
        ]
    }
    msg = adapter.parse_inbound(payload)
    assert msg.platform == "whatsapp"
    assert msg.channel_id == "+393331234567"
    assert msg.user_id == "+393331234567"
    assert msg.text == "Ciao Homun"
    assert msg.is_direct is True


def test_webhook_adapter():
    adapter = WebhookRelayAdapter()
    payload = {
        "id": "hook_1",
        "channel_id": "alerts_hook",
        "user_id": "service_bot",
        "text": "Disk space warning",
    }
    msg = adapter.parse_inbound(payload)
    assert msg.platform == "webhook"
    assert msg.channel_id == "alerts_hook"
    assert msg.user_id == "service_bot"
    assert msg.text == "Disk space warning"


# ---------------------------------------------------------------------------
# 5. Channel Registry Dispatch & Authorization Gates
# ---------------------------------------------------------------------------

def test_channel_registry_dispatch_flow():
    pairing_mgr = GatewayPairingManager()
    lease_mgr = TurnLeaseManager(default_ttl=5.0)
    registry = ChannelRegistry(pairing_mgr, lease_mgr)

    # 1. Unpaired / unauthorized message is rejected
    raw_telegram = {
        "message": {
            "message_id": 501,
            "from": {"id": 112233, "username": "stranger"},
            "chat": {"id": 112233, "type": "private"},
            "text": "Hello bot",
        }
    }
    res_unauth = registry.dispatch_inbound("telegram", raw_telegram, lambda msg: "Echo: " + msg.text)
    assert res_unauth["status"] == "unauthorized"

    # 2. Pair user
    req = pairing_mgr.request_pairing("telegram", "112233")
    pairing_mgr.approve_code(req.code)

    # 3. Dispatched message executes under turn lease and returns response
    res_auth = registry.dispatch_inbound("telegram", raw_telegram, lambda msg: f"Processed: {msg.text}")
    assert res_auth["status"] == "processed"
    assert res_auth["response"] == "Processed: Hello bot"
    assert res_auth["delivery"]["delivered"] is False
    assert res_auth["delivery"].get("code") == "backend_unavailable"

    # 4. Turn lease was cleanly released
    assert not lease_mgr.is_locked("telegram:112233:main")


# ---------------------------------------------------------------------------
# 6. Gateway Manage Tool & Registry Tests
# ---------------------------------------------------------------------------

def test_gateway_manage_tool_actions():
    reset_gateway_state()

    run = {"gateway": {"policy": "core-gateway-v1", "version": 1}}

    # 1. Request pairing
    req_res = gateway_execute(None, None, run, "gateway_manage", {
        "action": "pairing_request",
        "platform": "telegram",
        "user_id": "999888",
        "username": "tester",
    })
    assert req_res["status"] == "requested"
    code = req_res["pairing"]["code"]

    # 2. List pairing requests
    list_res = gateway_execute(None, None, run, "gateway_manage", {
        "action": "pairing_list",
        "platform": "telegram",
    })
    assert list_res["count"] == 1

    # 3. Approve pairing
    app_res = gateway_execute(None, None, run, "gateway_manage", {
        "action": "pairing_approve",
        "code": code,
    })
    assert app_res["status"] == "approved"

    # 4. Check lease status
    lease_res = gateway_execute(None, None, run, "gateway_manage", {
        "action": "lease_status",
        "session_id": "sess_dummy",
    })
    assert lease_res["locked"] is False

    # 5. Room creation & messaging
    room_res = gateway_execute(None, None, run, "gateway_manage", {
        "action": "room_create",
        "room_name": "War Room",
        "topic": "Incident triage",
        "actor_id": "lead_1",
    })
    assert room_res["status"] == "created"
    room_id = room_res["room"]["id"]

    join_res = gateway_execute(None, None, run, "gateway_manage", {
        "action": "room_join",
        "room_id": room_id,
        "actor_id": "agent_triage",
        "role": "member",
    })
    assert join_res["status"] == "joined"

    post_res = gateway_execute(None, None, run, "gateway_manage", {
        "action": "room_post",
        "room_id": room_id,
        "actor_id": "agent_triage",
        "text": "Analyzing traces...",
    })
    assert post_res["status"] == "posted"

    events_res = gateway_execute(None, None, run, "gateway_manage", {
        "action": "room_events",
        "room_id": room_id,
    })
    assert events_res["count"] == 3

    # 6. Adapter send
    send_res = gateway_execute(None, None, run, "gateway_manage", {
        "action": "adapter_send",
        "platform": "telegram",
        "channel_id": "999888",
        "text": "Outbound alert",
    })
    assert send_res["status"] == "sent"

    # 7. Revoke pairing
    rev_res = gateway_execute(None, None, run, "gateway_manage", {
        "action": "pairing_revoke",
        "platform": "telegram",
        "user_id": "999888",
    })
    assert rev_res["status"] == "revoked"


def test_gateway_manage_disabled_policy():
    run = {"gateway": {"policy": "other-policy", "version": 1}}
    with pytest.raises(ValidationError, match="not enabled"):
        gateway_execute(None, None, run, "gateway_manage", {"action": "pairing_list"})
