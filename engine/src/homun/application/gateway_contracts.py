"""Contracts and data models for gateway authorization, pairing, turn leases, rooms, and channel adapters (H32/H33).

Derived from Hermes gateway/pairing.py, gateway/authz_mixin.py, gateway/turn_lease.py,
gateway/hosted_rooms.py, and gateway/platforms/ at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun maintains core channel runtime with code-based pairing, strict topic/user isolation,
atomic turn serialization leases, multi-agent hosted rooms, and pluggable messaging adapters.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional

from pydantic import BaseModel, Field


class PlatformKind(str, Enum):
    TELEGRAM = "telegram"
    DISCORD = "discord"
    SLACK = "slack"
    WHATSAPP = "whatsapp"
    WEBHOOK = "webhook"
    LOCAL = "local"


@dataclass
class PairingRequest:
    """A pending or approved code-based pairing authorization."""
    code: str
    platform: str
    user_id: str
    username: Optional[str] = None
    created_at: float = 0.0
    expires_at: float = 0.0
    status: str = "pending"             # pending | approved | rejected | expired
    approved_by: Optional[str] = None
    approved_at: Optional[float] = None
    failed_attempts: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PairingRequest":
        return cls(
            code=str(data.get("code") or ""),
            platform=str(data.get("platform") or ""),
            user_id=str(data.get("user_id") or ""),
            username=data.get("username"),
            created_at=float(data.get("created_at") or 0.0),
            expires_at=float(data.get("expires_at") or 0.0),
            status=str(data.get("status") or "pending"),
            approved_by=data.get("approved_by"),
            approved_at=(float(data["approved_at"]) if data.get("approved_at") is not None else None),
            failed_attempts=int(data.get("failed_attempts") or 0),
        )


@dataclass
class ChannelMedia:
    """Attached media in a channel message."""
    url: Optional[str] = None
    mime_type: str = "application/octet-stream"
    file_name: Optional[str] = None
    size_bytes: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ChannelMessage:
    """Unified inbound/outbound channel message."""
    id: str
    platform: str
    channel_id: str
    user_id: str
    text: str
    topic_id: Optional[str] = None
    thread_id: Optional[str] = None
    is_direct: bool = True
    username: Optional[str] = None
    media: List[ChannelMedia] = field(default_factory=list)
    timestamp: float = 0.0
    reply_to_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["media"] = [m.to_dict() for m in self.media]
        return d


@dataclass
class TurnLeaseToken:
    """Active lease handle ensuring sequential execution on a session or topic."""
    session_id: str
    owner_key: str
    generation: int
    acquired_at: float
    released: bool = False

    @property
    def key(self) -> str:
        return self.session_id

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class HostedRoomMember:
    """Participant in a gateway hosted room."""
    actor_id: str
    role: str = "member"                # owner | member | guest
    display_name: Optional[str] = None
    joined_at: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class HostedRoomEvent:
    """Append-only room event in hosted room discussion log."""
    event_id: str
    room_id: str
    actor_id: str
    kind: str                           # message.user | message.member | room.created | room.activity | turn.started | turn.settled
    content: str
    timestamp: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.event_id

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class HostedRoom:
    """Multi-participant, multi-agent discussion room."""
    id: str
    name: str
    topic: str
    created_at: float = 0.0
    status: str = "active"              # active | disbanded | paused
    members: Dict[str, HostedRoomMember] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["members"] = {k: v.to_dict() for k, v in self.members.items()}
        return d


# --- Tool Arguments Schema for Agent Registry ---

class GatewayManageArguments(BaseModel):
    action: str = Field(
        description="Action to perform: pairing_request | pairing_approve | pairing_reject | pairing_revoke | pairing_list | lease_status | room_create | room_get | room_list | room_join | room_leave | room_post | room_events | adapter_send | adapter_status"
    )
    platform: Optional[str] = Field(default=None, description="Platform identifier (telegram, discord, slack, whatsapp, webhook)")
    user_id: Optional[str] = Field(default=None, description="Platform user identifier")
    username: Optional[str] = Field(default=None, description="Platform username or handle")
    code: Optional[str] = Field(default=None, description="Pairing authorization code")
    session_id: Optional[str] = Field(default=None, description="Session identifier for turn lease checks")
    room_id: Optional[str] = Field(default=None, description="Hosted room identifier")
    room_name: Optional[str] = Field(default=None, description="Name for room creation")
    topic: Optional[str] = Field(default=None, description="Topic or prompt for hosted room")
    actor_id: Optional[str] = Field(default=None, description="Actor identifier in hosted room")
    role: Optional[str] = Field(default="member", description="Role in hosted room: owner | member | guest")
    text: Optional[str] = Field(default=None, description="Message text content")
    channel_id: Optional[str] = Field(default=None, description="Destination channel or thread ID")
    thread_id: Optional[str] = Field(default=None, description="Thread or topic identifier")


def entries(executor: Callable, version: int) -> list:
    from homun.application.agent_tool_contracts import ToolDefinition, ToolEntry

    return [
        ToolEntry(
            ToolDefinition(
                name="gateway_manage",
                description="Manage gateway runtime: DM pairing codes and approvals, turn leases, hosted multi-agent rooms, and messaging platform adapters.",
                input_schema=GatewayManageArguments.model_json_schema(),
            ),
            "gateway",
            str(version),
            GatewayManageArguments,
            executor,
        ),
    ]
