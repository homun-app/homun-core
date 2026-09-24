"""Execution of gateway_manage tool for agent runs (H32/H33).

Derived from Hermes gateway/pairing.py, gateway/hosted_rooms.py, and
gateway/platforms/ at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun provides a unified gateway_manage tool allowing agent runs and operators
to manage DM pairing, turn leases, hosted multi-agent rooms, and channel adapters.
"""
from __future__ import annotations

from typing import Any, Dict

from homun.application.channel_adapters import ChannelRegistry
from homun.application.gateway_hosted_rooms import HostedRoomManager
from homun.application.gateway_pairing import (
    GatewayPairingManager,
    get_gateway_pairing_manager,
    set_gateway_pairing_manager,
)
from homun.application.gateway_turn_lease import TurnLeaseManager
from homun.domain.errors import ValidationError

_GLOBAL_PAIRING_MGR = GatewayPairingManager(db_path=":memory:")
_GLOBAL_LEASE_MGR = TurnLeaseManager()
_GLOBAL_ROOM_MGR = HostedRoomManager(db_path=":memory:")
_GLOBAL_CHANNEL_REG = ChannelRegistry(_GLOBAL_PAIRING_MGR, _GLOBAL_LEASE_MGR)


def reset_gateway_state() -> None:
    """Reset global gateway managers (primarily used in tests)."""
    global _GLOBAL_PAIRING_MGR, _GLOBAL_LEASE_MGR, _GLOBAL_ROOM_MGR, _GLOBAL_CHANNEL_REG
    _GLOBAL_PAIRING_MGR = GatewayPairingManager(db_path=":memory:")
    set_gateway_pairing_manager(_GLOBAL_PAIRING_MGR)
    _GLOBAL_LEASE_MGR = TurnLeaseManager()
    _GLOBAL_ROOM_MGR = HostedRoomManager(db_path=":memory:")
    _GLOBAL_CHANNEL_REG = ChannelRegistry(_GLOBAL_PAIRING_MGR, _GLOBAL_LEASE_MGR)


def execute(ctx, actor, run, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if run.get("gateway", {}).get("policy") != "core-gateway-v1":
        raise ValidationError("Gateway management tools are not enabled for this run")

    action = str(args.get("action") or "").strip().lower()

    # --- Pairing Actions ---
    if action == "pairing_request":
        platform = str(args.get("platform") or "").strip()
        user_id = str(args.get("user_id") or "").strip()
        if not platform or not user_id:
            raise ValidationError("platform and user_id are required for 'pairing_request'")
        try:
            req = _GLOBAL_PAIRING_MGR.request_pairing(platform, user_id, username=args.get("username"))
            return {"status": "requested", "pairing": req.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "pairing_approve":
        code = str(args.get("code") or "").strip()
        if not code:
            raise ValidationError("code is required for 'pairing_approve'")
        try:
            req = _GLOBAL_PAIRING_MGR.approve_code(code)
            return {"status": "approved", "pairing": req.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "pairing_reject":
        code = str(args.get("code") or "").strip()
        if not code:
            raise ValidationError("code is required for 'pairing_reject'")
        try:
            req = _GLOBAL_PAIRING_MGR.decline_code(code)
            return {"status": "rejected", "pairing": req.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "pairing_revoke":
        platform = str(args.get("platform") or "").strip()
        user_id = str(args.get("user_id") or "").strip()
        if not platform or not user_id:
            raise ValidationError("platform and user_id are required for 'pairing_revoke'")
        revoked = _GLOBAL_PAIRING_MGR.revoke_user(platform, user_id)
        return {"status": "revoked" if revoked else "not_found", "platform": platform, "user_id": user_id}

    if action == "pairing_list":
        platform = args.get("platform")
        reqs = _GLOBAL_PAIRING_MGR.list_pairing_requests(platform=platform)
        return {"count": len(reqs), "requests": [r.to_dict() for r in reqs]}

    # --- Turn Lease Actions ---
    if action == "lease_status":
        session_id = str(args.get("session_id") or "").strip()
        if not session_id:
            raise ValidationError("session_id is required for 'lease_status'")
        is_locked = _GLOBAL_LEASE_MGR.is_locked(session_id)
        return {"session_id": session_id, "locked": is_locked}

    # --- Hosted Room Actions ---
    if action == "room_create":
        name = str(args.get("room_name") or "").strip()
        topic = str(args.get("topic") or "").strip()
        if not name or not topic:
            raise ValidationError("room_name and topic are required for 'room_create'")
        room = _GLOBAL_ROOM_MGR.create_room(name, topic, owner_id=str(args.get("actor_id") or "system"))
        return {"status": "created", "room": room.to_dict()}

    if action == "room_get":
        room_id = str(args.get("room_id") or "").strip()
        if not room_id:
            raise ValidationError("room_id is required for 'room_get'")
        room = _GLOBAL_ROOM_MGR.get_room(room_id)
        if not room:
            raise ValidationError(f"Room not found: {room_id}")
        return {"room": room.to_dict()}

    if action == "room_list":
        rooms = _GLOBAL_ROOM_MGR.list_rooms()
        return {"count": len(rooms), "rooms": [r.to_dict() for r in rooms]}

    if action == "room_join":
        room_id = str(args.get("room_id") or "").strip()
        actor_id = str(args.get("actor_id") or "").strip()
        if not room_id or not actor_id:
            raise ValidationError("room_id and actor_id are required for 'room_join'")
        try:
            member = _GLOBAL_ROOM_MGR.join_room(
                room_id, actor_id, role=str(args.get("role") or "member")
            )
            return {"status": "joined", "member": member.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "room_leave":
        room_id = str(args.get("room_id") or "").strip()
        actor_id = str(args.get("actor_id") or "").strip()
        if not room_id or not actor_id:
            raise ValidationError("room_id and actor_id are required for 'room_leave'")
        left = _GLOBAL_ROOM_MGR.leave_room(room_id, actor_id)
        return {"status": "left" if left else "not_found", "room_id": room_id, "actor_id": actor_id}

    if action == "room_post":
        room_id = str(args.get("room_id") or "").strip()
        actor_id = str(args.get("actor_id") or "user").strip()
        text = str(args.get("text") or "").strip()
        if not room_id or not text:
            raise ValidationError("room_id and text are required for 'room_post'")
        try:
            event = _GLOBAL_ROOM_MGR.post_event(room_id, actor_id, kind="message.user", content=text)
            return {"status": "posted", "event": event.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "room_events":
        room_id = str(args.get("room_id") or "").strip()
        if not room_id:
            raise ValidationError("room_id is required for 'room_events'")
        events = _GLOBAL_ROOM_MGR.get_events(room_id)
        return {"room_id": room_id, "count": len(events), "events": [e.to_dict() for e in events]}

    # --- Channel Adapter Actions ---
    if action == "adapter_send":
        platform = str(args.get("platform") or "").strip().lower()
        channel_id = str(args.get("channel_id") or "").strip()
        text = str(args.get("text") or "").strip()
        if not platform or not channel_id or not text:
            raise ValidationError("platform, channel_id, and text are required for 'adapter_send'")
        adapter = _GLOBAL_CHANNEL_REG.get_adapter(platform)
        if not adapter:
            raise ValidationError(f"Adapter not available for platform: {platform}")
        res = adapter.send(channel_id, text, thread_id=args.get("thread_id"))
        delivered = bool(res.get("delivered"))
        return {
            "status": "sent" if delivered else "failed",
            "delivery": res,
        }

    if action == "adapter_status":
        adapters = list(_GLOBAL_CHANNEL_REG._adapters.keys())
        return {"registered_adapters": adapters}

    raise ValidationError(f"Unsupported gateway action: {action!r}")
