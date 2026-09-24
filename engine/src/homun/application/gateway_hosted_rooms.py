"""Hosted room management: multi-agent and multi-user discussion rooms (H32).

Derived from Hermes gateway/hosted_rooms.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun maintains gateway-hosted discussion rooms with membership roles, append-only
event logging, strict topic isolation, and moderated turn settlement.
Rooms and events persist under HOMUN_DATA_DIR/gateway/rooms-<workspace>.sqlite.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from homun.application.gateway_contracts import (
    HostedRoom,
    HostedRoomEvent,
    HostedRoomMember,
)
from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)


def _room_from_dict(data: Dict[str, Any]) -> HostedRoom:
    members_raw = data.get("members") or {}
    members = {
        str(k): HostedRoomMember(
            actor_id=str(v.get("actor_id") or k),
            role=str(v.get("role") or "member"),
            display_name=v.get("display_name"),
            joined_at=float(v.get("joined_at") or 0.0),
        )
        for k, v in members_raw.items()
        if isinstance(v, dict)
    }
    return HostedRoom(
        id=str(data.get("id") or ""),
        name=str(data.get("name") or ""),
        topic=str(data.get("topic") or ""),
        created_at=float(data.get("created_at") or 0.0),
        status=str(data.get("status") or "active"),
        members=members,
        metadata=dict(data.get("metadata") or {}),
    )


def _event_from_dict(data: Dict[str, Any]) -> HostedRoomEvent:
    return HostedRoomEvent(
        event_id=str(data.get("event_id") or data.get("id") or ""),
        room_id=str(data.get("room_id") or ""),
        actor_id=str(data.get("actor_id") or ""),
        kind=str(data.get("kind") or ""),
        content=str(data.get("content") or ""),
        timestamp=float(data.get("timestamp") or 0.0),
        metadata=dict(data.get("metadata") or {}),
    )


class HostedRoomManager:
    """Manager for gateway-hosted multi-participant discussion rooms and event logs."""

    def __init__(self, workspace_id: str = "default", *, db_path: Optional[str | Path] = None):
        self.workspace_id = workspace_id
        self._rooms: Dict[str, HostedRoom] = {}
        self._room_events: Dict[str, List[HostedRoomEvent]] = {}
        if db_path is None:
            override = os.environ.get("HOMUN_ROOMS_DB")
            if override:
                db_path = override
            else:
                root = default_data_dir() / "gateway"
                root.mkdir(parents=True, exist_ok=True)
                db_path = root / f"rooms-{self.workspace_id}.sqlite"
        self._db_path = str(db_path)
        self._lock = threading.RLock()
        if self._db_path != ":memory:":
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        if self._db_path != ":memory:":
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS rooms (
                room_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS room_events (
                event_id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                timestamp REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_room_events_room
                ON room_events(room_id, timestamp);
            """
        )
        self._conn.commit()
        self._load()

    def _persist_room(self, room: HostedRoom) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO rooms(room_id, payload, updated_at)
                VALUES(?, ?, ?)
                ON CONFLICT(room_id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (room.id, json.dumps(room.to_dict(), ensure_ascii=False, sort_keys=True), time.time()),
            )
            self._conn.commit()

    def _persist_event(self, event: HostedRoomEvent) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO room_events(event_id, room_id, payload, timestamp)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(event_id) DO UPDATE SET
                    payload = excluded.payload,
                    timestamp = excluded.timestamp,
                    room_id = excluded.room_id
                """,
                (
                    event.event_id,
                    event.room_id,
                    json.dumps(event.to_dict(), ensure_ascii=False, sort_keys=True),
                    event.timestamp,
                ),
            )
            self._conn.commit()

    def _load(self) -> None:
        for row in self._conn.execute("SELECT payload FROM rooms").fetchall():
            try:
                room = _room_from_dict(json.loads(row[0]))
                self._rooms[room.id] = room
            except Exception as exc:
                logger.warning("Failed to load hosted room: %s", exc)
        for row in self._conn.execute(
            "SELECT room_id, payload FROM room_events ORDER BY timestamp ASC"
        ).fetchall():
            try:
                event = _event_from_dict(json.loads(row[1]))
                self._room_events.setdefault(row[0], []).append(event)
            except Exception as exc:
                logger.warning("Failed to load room event: %s", exc)

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
        self._persist_room(room)

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
        self._persist_room(room)

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
            self._persist_room(room)
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
        self._persist_room(room)
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
        if room.status != "active" and kind != "room.disbanded":
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
        self._persist_event(event)
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
