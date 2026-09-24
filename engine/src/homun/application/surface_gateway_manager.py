"""Multi-Surface Gateway and Cross-Surface Synchronization Engine (H34).

Derived from Hermes tui_gateway/server.py, tui_gateway/session_lifecycle.py, and cli.py
at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Manages multi-connection transports (local, SSH, URL, cloud), surface session registration,
coherent task steering, distributed approval queues, deliverable artifact registry,
and reconnect state synchronization across CLI, TUI, Desktop, Web/Dashboard, and BotScreen.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Dict, List, Optional

from homun.application.surface_contracts import (
    ConnectionTransportKind,
    SurfaceApprovalRequest,
    SurfaceConnection,
    SurfaceKind,
    SurfaceLiveSessionSnapshot,
    SurfaceSteeringGuidance,
)

logger = logging.getLogger(__name__)


class SurfaceGatewayManager:
    """Homun-owned Multi-Surface Gateway Manager."""

    def __init__(self) -> None:
        self._connections: Dict[str, SurfaceConnection] = {}
        self._sessions: Dict[str, SurfaceLiveSessionSnapshot] = {}
        self._approvals: Dict[str, SurfaceApprovalRequest] = {}
        self._steering_queue: Dict[str, List[SurfaceSteeringGuidance]] = {}
        self._artifacts_by_session: Dict[str, List[Dict[str, Any]]] = {}

    # ── Connection Management ───────────────────────────────────────────────

    def register_connection(
        self,
        surface_kind: SurfaceKind,
        transport: ConnectionTransportKind,
        endpoint: str = "",
        profile: str = "default",
        client_version: str = "1.0.0",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SurfaceConnection:
        """Register a new surface client connection (CLI, TUI, Desktop, Web, BotScreen)."""
        conn_id = f"conn_{uuid.uuid4().hex[:12]}"
        conn = SurfaceConnection(
            connection_id=conn_id,
            surface_kind=surface_kind,
            transport=transport,
            endpoint=endpoint,
            profile=profile,
            client_version=client_version,
            metadata=metadata or {},
        )
        self._connections[conn_id] = conn
        logger.info("Registered surface connection: %s (%s via %s)", conn_id, surface_kind.value, transport.value)
        return conn

    def disconnect(self, connection_id: str) -> bool:
        """Remove a disconnected surface client."""
        if connection_id in self._connections:
            del self._connections[connection_id]
            return True
        return False

    def list_connections(self, profile: Optional[str] = None) -> List[SurfaceConnection]:
        """List active surface client connections, optionally filtered by profile."""
        conns = list(self._connections.values())
        if profile:
            return [c for c in conns if c.profile == profile]
        return conns

    # ── Surface Session Synchronization ─────────────────────────────────────

    def sync_session_state(
        self,
        session_id: str,
        profile: str,
        surface_kind: SurfaceKind,
        status: str,
        title: str = "",
        cwd: str = "",
        active_tools: Optional[List[str]] = None,
        token_usage: Optional[Dict[str, int]] = None,
    ) -> SurfaceLiveSessionSnapshot:
        """Update or create the authoritative live session snapshot visible across all surfaces."""
        snap = self._sessions.get(session_id)
        approvals = [a for a in self._approvals.values() if a.session_id == session_id and not a.resolved]
        steering = self._steering_queue.get(session_id, [])
        artifacts = self._artifacts_by_session.get(session_id, [])

        if snap is None:
            snap = SurfaceLiveSessionSnapshot(
                session_id=session_id,
                profile=profile,
                surface_kind=surface_kind,
                status=status,
                title=title,
                cwd=cwd,
                active_tools=active_tools or [],
                pending_approvals=approvals,
                pending_steering=steering,
                artifacts=artifacts,
                token_usage=token_usage or {},
            )
        else:
            snap.profile = profile
            snap.surface_kind = surface_kind
            snap.status = status
            if title:
                snap.title = title
            if cwd:
                snap.cwd = cwd
            if active_tools is not None:
                snap.active_tools = active_tools
            snap.pending_approvals = approvals
            snap.pending_steering = steering
            snap.artifacts = artifacts
            if token_usage:
                snap.token_usage = token_usage

        self._sessions[session_id] = snap
        return snap

    def get_session_snapshot(self, session_id: str) -> Optional[SurfaceLiveSessionSnapshot]:
        """Retrieve live task status, steering, approvals, and artifacts for a session."""
        if session_id not in self._sessions:
            return None
        # Refresh dynamic references
        snap = self._sessions[session_id]
        snap.pending_approvals = [a for a in self._approvals.values() if a.session_id == session_id and not a.resolved]
        snap.pending_steering = [s for s in self._steering_queue.get(session_id, []) if not s.applied]
        snap.artifacts = self._artifacts_by_session.get(session_id, [])
        return snap

    # ── Coherent Task Steering ──────────────────────────────────────────────

    def queue_steering_guidance(self, session_id: str, guidance: str) -> SurfaceSteeringGuidance:
        """Queue guidance injected from any surface (e.g. CLI or TUI 'e' steering form)."""
        steer = SurfaceSteeringGuidance(session_id=session_id, guidance=guidance.strip())
        if session_id not in self._steering_queue:
            self._steering_queue[session_id] = []
        self._steering_queue[session_id].append(steer)
        return steer

    def drain_steering_guidance(self, session_id: str) -> List[SurfaceSteeringGuidance]:
        """Consume pending steering instructions for the active model turn."""
        items = [s for s in self._steering_queue.get(session_id, []) if not s.applied]
        for s in items:
            s.applied = True
        return items

    # ── Cross-Surface Approval Queue ────────────────────────────────────────

    def request_approval(
        self,
        session_id: str,
        tool_name: str,
        command: str,
        description: str,
        choices: Optional[List[str]] = None,
    ) -> SurfaceApprovalRequest:
        """Post a dangerous tool action to the approval queue for user review on any surface."""
        req_id = f"appr_{uuid.uuid4().hex[:12]}"
        req = SurfaceApprovalRequest(
            request_id=req_id,
            session_id=session_id,
            tool_name=tool_name,
            command=command,
            description=description,
            choices=choices or ["once", "session", "always", "deny"],
        )
        self._approvals[req_id] = req
        return req

    def resolve_approval(self, request_id: str, decision: str) -> Optional[SurfaceApprovalRequest]:
        """Resolve a pending approval from any connected surface client."""
        req = self._approvals.get(request_id)
        if not req or req.resolved:
            return None
        valid = {"once", "session", "always", "deny"}
        dec = decision.strip().lower()
        if dec not in valid:
            raise ValueError(f"Decision must be one of {valid}")
        req.resolved = True
        req.decision = dec
        return req

    # ── Artifact Registration ───────────────────────────────────────────────

    def register_artifact(self, session_id: str, artifact_type: str, path_or_url: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Record a generated artifact for presentation across surfaces."""
        artifact = {
            "id": f"art_{uuid.uuid4().hex[:12]}",
            "type": artifact_type,
            "uri": path_or_url,
            "created_at": time.time(),
            "metadata": metadata or {},
        }
        if session_id not in self._artifacts_by_session:
            self._artifacts_by_session[session_id] = []
        self._artifacts_by_session[session_id].append(artifact)
        return artifact
