"""Hosted room management: multi-agent and multi-user discussion rooms (H32).

Derived from Hermes gateway/hosted_rooms.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun maintains gateway-hosted discussion rooms with membership roles, append-only
event logging, strict topic isolation, and moderated turn settlement.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Dict, List, Optional

from homun.application.gateway_contracts import (
    HostedRoom,
    HostedRoomEvent,
    HostedRoomMember,
)

logger = logging.getLogger(__name__)


class HostedRoomManager:
    """Manager for gateway-hosted multi-participant discussion rooms and event logs."""

    def __init__(self, workspace_id: str = "default"):
        self.workspace_id = workspace_id
        self._rooms: Dict[str, HostedRoom] = {}
        self._room_events: Dict[str, List[HostedRoomEvent]] = {}

    def create_room(
        self,
        name: str,
        topic: str,
        owner_id: str = "system",
        *,
        metadata: Optional[Dict[str, Any]] = None,
        now: Optional[float] = None,
    ) -> HostedRoom:
        curr = time.time() if now is None else float(now)
        room_id = f"room-{uuid.uuid4().hex[:8]}"

        members: Dict[str, HostedRoomMember] = {
            owner_id: HostedRoomMember(actor_id=owner_id, role="owner", joined_at=curr)
        }

        room = HostedRoom(
            id=room_id,
            name=name.strip(),
            topic=topic.strip(),
            created_at=curr,
            status="active",
            members=members,
            metadata=dict(metadata or {}),
        )
        self._rooms[room_id] = room

        # Record room creation event
        self.post_event(
            room_id,
            owner_id,
            kind="room.created",
            content=f"Room '{room.name}' created with topic: {room.topic}",
            now=curr,
        )
        return room

    def get_room(self, room_id: str) -> Optional[HostedRoom]:
        return self._rooms.get(room_id)

    def list_rooms(self) -> List[HostedRoom]:
        return list(self._rooms.values())

    def join_room(
        self,
        room_id: str,
        actor_id: str,
        role: str = "member",
        *,
        now: Optional[float] = None,
    ) -> HostedRoomMember:
        curr = time.time() if now is None else float(now)
        room = self.get_room(room_id)
        if not room:
            raise ValueError(f"Room not found: {room_id}")
        if room.status != "active":
            raise ValueError(f"Cannot join room: status is {room.status}")

        aid = actor_id.strip()
        member = HostedRoomMember(
            actor_id=aid,
            role=role.strip().lower(),
            joined_at=curr,
        )
        room.members[aid] = member

        self.post_event(
            room_id,
            aid,
            kind="room.members_changed",
            content=f"{aid} joined room as {member.role}",
            now=curr,
        )
        return member

    def leave_room(
        self,
        room_id: str,
        actor_id: str,
        *,
        now: Optional[float] = None,
    ) -> bool:
        curr = time.time() if now is None else float(now)
        room = self.get_room(room_id)
        if not room:
            return False

        aid = actor_id.strip()
        if aid in room.members:
            del room.members[aid]
            self.post_event(
                room_id,
                aid,
                kind="room.members_changed",
                content=f"{aid} left room",
                now=curr,
            )
            return True
        return False

    def disband_room(self, room_id: str, *, now: Optional[float] = None) -> HostedRoom:
        curr = time.time() if now is None else float(now)
        room = self.get_room(room_id)
        if not room:
            raise ValueError(f"Room not found: {room_id}")
        self.post_event(
            room_id,
            "system",
            kind="room.disbanded",
            content=f"Room '{room.name}' was disbanded.",
            now=curr,
        )
        room.status = "disbanded"
        return room

    def post_event(
        self,
        room_id: str,
        actor_id: str,
        kind: str,
        content: str,
        *,
        metadata: Optional[Dict[str, Any]] = None,
        now: Optional[float] = None,
    ) -> HostedRoomEvent:
        curr = time.time() if now is None else float(now)
        room = self.get_room(room_id)
        if not room:
            raise ValueError(f"Room not found: {room_id}")
        if room.status != "active":
            raise ValueError(f"Cannot post event: room {room_id} is not active (status: {room.status})")

        event = HostedRoomEvent(
            event_id=f"evt-{uuid.uuid4().hex[:8]}",
            room_id=room_id,
            actor_id=actor_id.strip(),
            kind=kind.strip(),
            content=content.strip(),
            timestamp=curr,
            metadata=dict(metadata or {}),
        )
        self._room_events.setdefault(room_id, []).append(event)
        return event

    def get_events(
        self,
        room_id: str,
        *,
        limit: Optional[int] = None,
        after_id: Optional[str] = None,
    ) -> List[HostedRoomEvent]:
        events = self._room_events.get(room_id, [])
        if after_id:
            idx = -1
            for i, e in enumerate(events):
                if e.id == after_id or e.event_id == after_id:
                    idx = i
                    break
            if idx >= 0:
                events = events[idx + 1 :]
        if limit and limit > 0:
            events = events[-limit:]
        return list(events)
