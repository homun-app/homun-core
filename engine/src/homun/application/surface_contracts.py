"""Surface adapter contracts for Multi-Surface Gateway (H34).

Defines surface kinds (CLI, TUI, Desktop, Web/Dashboard, BotScreen, Headless), connection transports
(local, SSH, URL, Cloud), multi-profile surface session leases, coherent steering, approval requests,
and live session synchronization snapshots.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class SurfaceKind(str, Enum):
    CLI = "cli"
    TUI = "tui"
    DESKTOP = "desktop"
    WEB = "web"
    BOT_SCREEN = "bot_screen"
    HEADLESS = "headless"


class ConnectionTransportKind(str, Enum):
    LOCAL = "local"
    SSH = "ssh"
    URL = "url"
    CLOUD = "cloud"


@dataclass
class SurfaceConnection:
    connection_id: str
    surface_kind: SurfaceKind
    transport: ConnectionTransportKind
    endpoint: str = ""
    profile: str = "default"
    client_version: str = "1.0.0"
    connected_at: float = field(default_factory=time.time)
    last_active_at: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SurfaceApprovalRequest:
    request_id: str
    session_id: str
    tool_name: str
    command: str
    description: str
    choices: List[str] = field(default_factory=lambda: ["once", "session", "always", "deny"])
    created_at: float = field(default_factory=time.time)
    resolved: bool = False
    decision: Optional[str] = None


@dataclass
class SurfaceSteeringGuidance:
    session_id: str
    guidance: str
    queued_at: float = field(default_factory=time.time)
    applied: bool = False


@dataclass
class SurfaceLiveSessionSnapshot:
    session_id: str
    profile: str
    surface_kind: SurfaceKind
    status: str  # idle, working, streaming, waiting_approval, paused
    title: str = ""
    cwd: str = ""
    active_tools: List[str] = field(default_factory=list)
    pending_approvals: List[SurfaceApprovalRequest] = field(default_factory=list)
    pending_steering: List[SurfaceSteeringGuidance] = field(default_factory=list)
    artifacts: List[Dict[str, Any]] = field(default_factory=list)
    message_count: int = 0
    token_usage: Dict[str, int] = field(default_factory=dict)
