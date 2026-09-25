"""Contracts and data models for durable session lifecycle, lineage, and accounting (H30/H31).

at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun maintains sessions with working directory restoration, carrier-aware turn rewind,
forked branching with lineage tracking, secret-redacted export, transcript import without
identity drift, and SQLite FTS-backed storage with integrity repair and usage accounting.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional

from pydantic import BaseModel, Field


@dataclass
class SessionRecord:
    """Serializable record of an agent conversation session."""
    id: str
    workspace_id: str = "default"
    title: Optional[str] = None
    cwd: str = ""
    status: str = "active"              # active | archived | cleared
    pinned: bool = False
    parent_id: Optional[str] = None     # forked lineage parent
    forked_at_turn: Optional[int] = None
    created_at: float = 0.0
    updated_at: float = 0.0
    last_active_at: float = 0.0
    model_pin: Optional[str] = None
    provider_pin: Optional[str] = None
    message_count: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_estimate: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SessionRecord":
        return cls(
            id=str(data.get("id") or ""),
            workspace_id=str(data.get("workspace_id") or "default"),
            title=data.get("title"),
            cwd=str(data.get("cwd") or ""),
            status=str(data.get("status") or "active"),
            pinned=bool(data.get("pinned") or False),
            parent_id=data.get("parent_id"),
            forked_at_turn=(int(data["forked_at_turn"]) if data.get("forked_at_turn") is not None else None),
            created_at=float(data.get("created_at") or 0.0),
            updated_at=float(data.get("updated_at") or 0.0),
            last_active_at=float(data.get("last_active_at") or 0.0),
            model_pin=data.get("model_pin"),
            provider_pin=data.get("provider_pin"),
            message_count=int(data.get("message_count") or 0),
            prompt_tokens=int(data.get("prompt_tokens") or 0),
            completion_tokens=int(data.get("completion_tokens") or 0),
            cost_estimate=float(data.get("cost_estimate") or 0.0),
            metadata=dict(data.get("metadata") or {}),
        )


@dataclass
class SessionMessage:
    """A durable message within a session transcript."""
    id: str
    session_id: str
    turn_index: int
    role: str                           # user | assistant | system | tool
    content: str
    timestamp: float = 0.0
    tool_name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[str] = None    # serialized JSON calls
    active: int = 1                     # 1 = active, 0 = rewound
    compacted: int = 0                  # 1 = compaction carrier
    tokens: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SessionMessage":
        return cls(
            id=str(data.get("id") or ""),
            session_id=str(data.get("session_id") or ""),
            turn_index=int(data.get("turn_index") or 0),
            role=str(data.get("role") or "user"),
            content=str(data.get("content") or ""),
            timestamp=float(data.get("timestamp") or 0.0),
            tool_name=data.get("tool_name"),
            tool_call_id=data.get("tool_call_id"),
            tool_calls=data.get("tool_calls"),
            active=int(data.get("active") if data.get("active") is not None else 1),
            compacted=int(data.get("compacted") or 0),
            tokens=int(data.get("tokens") or 0),
            metadata=dict(data.get("metadata") or {}),
        )


@dataclass
class RewindOutcome:
    """Outcome report of a turn rewind operation."""
    session_id: str
    target_turn: int
    messages_deactivated: int
    active_messages_remaining: int
    last_active_turn: int

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class SessionLineage:
    """Lineage information representing session family trees."""
    session_id: str
    parent_id: Optional[str]
    forked_at_turn: Optional[int]
    ancestors: List[str] = field(default_factory=list)
    children: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class SessionUsage:
    """Token and cost usage summary."""
    session_id: Optional[str]
    workspace_id: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    total_cost: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# --- Pydantic Arguments for Agent Tool Registry ---

class SessionManageArguments(BaseModel):
    action: str = Field(
        description="Action to perform: create | get | list | update | resume | pin | unpin | archive | unarchive | prune | export | import | rewind | fork | handoff | repair | usage"
    )
    session_id: Optional[str] = Field(default=None, description="Session identifier")
    title: Optional[str] = Field(default=None, description="Title for create, update, or fork")
    cwd: Optional[str] = Field(default=None, description="Working directory path")
    pinned: Optional[bool] = Field(default=None, description="Pin status")
    archived: Optional[bool] = Field(default=None, description="Archive status")
    parent_id: Optional[str] = Field(default=None, description="Parent session identifier for forking")
    turn_index: Optional[int] = Field(default=None, description="Turn index target for rewind or fork")
    format: Optional[str] = Field(default="jsonl", description="Export format: jsonl | markdown")
    redact_secrets: Optional[bool] = Field(default=True, description="When true, sanitizes API keys and bearer tokens on export")
    data: Optional[str] = Field(default=None, description="Serialized transcript text for import")
    older_than_seconds: Optional[float] = Field(default=None, description="Age threshold in seconds for pruning")
    include_archived: Optional[bool] = Field(default=False, description="Whether to include archived sessions in listing or pruning")
    model_pin: Optional[str] = Field(default=None, description="Pinned model identifier")
    provider_pin: Optional[str] = Field(default=None, description="Pinned provider identifier")
    query: Optional[str] = Field(default=None, description="Search query string for FTS message matching")
    target_profile: Optional[str] = Field(default=None, description="Target workspace profile for handoff")


def entries(executor: Callable, version: int) -> list:
    from homun.application.agent_tool_contracts import ToolDefinition, ToolEntry

    return [
        ToolEntry(
            ToolDefinition(
                name="session_manage",
                description="Manage durable agent sessions: CRUD, cwd resume, title, pin, archive, prune, export with redaction, import without identity drift, rewind, fork lineage, handoff, integrity repair, and token accounting.",
                input_schema=SessionManageArguments.model_json_schema(),
            ),
            "session",
            str(version),
            SessionManageArguments,
            executor,
        ),
    ]
