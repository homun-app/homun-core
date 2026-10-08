"""Multi-Surface Gateway and Cross-Surface Synchronization Engine (H34).

at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Manages multi-connection transports (local, SSH, URL, cloud), surface session registration,
coherent task steering, distributed approval queues, deliverable artifact registry,
and reconnect state synchronization across CLI, TUI, Desktop, Web/Dashboard, and BotScreen.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from homun.application.surface_contracts import (
    ConnectionTransportKind,
    SurfaceApprovalRequest,
    SurfaceConnection,
    SurfaceKind,
    SurfaceLiveSessionSnapshot,
    SurfaceSteeringGuidance,
)
from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)


def _enum_val(value: Any) -> str:
    return value.value if hasattr(value, "value") else str(value)


class SurfaceGatewayManager:
    """Homun-owned Multi-Surface Gateway Manager with durable SQLite state."""

    def __init__(self, db_path: Optional[Path | str] = None) -> None:
        self._connections: Dict[str, SurfaceConnection] = {}
        self._sessions: Dict[str, SurfaceLiveSessionSnapshot] = {}
        self._approvals: Dict[str, SurfaceApprovalRequest] = {}
        self._steering_queue: Dict[str, List[SurfaceSteeringGuidance]] = {}
        self._artifacts_by_session: Dict[str, List[Dict[str, Any]]] = {}
        if db_path is None:
            root = default_data_dir() / "surfaces"
            root.mkdir(parents=True, exist_ok=True)
            db_path = root / "gateway.sqlite"
        self._db_path = str(db_path)
        if self._db_path != ":memory:":
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS surface_kv (
                kind TEXT NOT NULL,
                key TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (kind, key)
            )
            """
        )
        self._conn.commit()
        self._load()

    def _put(self, kind: str, key: str, payload: Dict[str, Any]) -> None:
        self._conn.execute(
            """
            INSERT INTO surface_kv(kind, key, payload, updated_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(kind, key) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (kind, key, json.dumps(payload, ensure_ascii=False, sort_keys=True), time.time()),
        )
        self._conn.commit()

    def _load(self) -> None:
        rows = self._conn.execute("SELECT kind, key, payload FROM surface_kv").fetchall()
        for kind, key, payload in rows:
            try:
                data = json.loads(payload)
            except Exception:
                continue
            if kind == "approval":
                self._approvals[key] = SurfaceApprovalRequest(
                    request_id=str(data.get("request_id") or key),
                    session_id=str(data.get("session_id") or ""),
                    tool_name=str(data.get("tool_name") or ""),
                    command=str(data.get("command") or ""),
                    description=str(data.get("description") or ""),
                    choices=list(data.get("choices") or ["once", "session", "always", "deny"]),
                    created_at=float(data.get("created_at") or time.time()),
                    resolved=bool(data.get("resolved")),
                    decision=data.get("decision"),
                )
            elif kind == "session":
                sk = data.get("surface_kind") or "cli"
                self._sessions[key] = SurfaceLiveSessionSnapshot(
                    session_id=str(data.get("session_id") or key),
                    profile=str(data.get("profile") or "default"),
                    surface_kind=SurfaceKind(sk) if not isinstance(sk, SurfaceKind) else sk,
                    status=str(data.get("status") or "idle"),
                    title=str(data.get("title") or ""),
                    cwd=str(data.get("cwd") or ""),
                    active_tools=list(data.get("active_tools") or []),
                    artifacts=list(data.get("artifacts") or []),
                    message_count=int(data.get("message_count") or 0),
                    token_usage=dict(data.get("token_usage") or {}),
                )
            elif kind == "steering":
                items = []
                for item in data.get("items") or []:
                    items.append(
                        SurfaceSteeringGuidance(
                            session_id=str(item.get("session_id") or key),
                            guidance=str(item.get("guidance") or ""),
                            queued_at=float(item.get("queued_at") or time.time()),
                            applied=bool(item.get("applied")),
                        )
                    )
                self._steering_queue[key] = items
            elif kind == "artifacts":
                self._artifacts_by_session[key] = list(data.get("items") or [])

    def _persist_approval(self, req: SurfaceApprovalRequest) -> None:
        self._put("approval", req.request_id, asdict(req))

    def _persist_session(self, snap: SurfaceLiveSessionSnapshot) -> None:
        payload = {
            "session_id": snap.session_id,
            "profile": snap.profile,
            "surface_kind": _enum_val(snap.surface_kind),
            "status": snap.status,
            "title": snap.title,
            "cwd": snap.cwd,
            "active_tools": snap.active_tools,
            "artifacts": snap.artifacts,
            "message_count": snap.message_count,
            "token_usage": snap.token_usage,
        }
        self._put("session", snap.session_id, payload)

    def _persist_steering(self, session_id: str) -> None:
        items = [asdict(s) for s in self._steering_queue.get(session_id, [])]
        self._put("steering", session_id, {"items": items})

    def _persist_artifacts(self, session_id: str) -> None:
        self._put("artifacts", session_id, {"items": self._artifacts_by_session.get(session_id, [])})

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
        self._persist_session(snap)
        return snap

    def get_session_snapshot(self, session_id: str) -> Optional[SurfaceLiveSessionSnapshot]:
        """Retrieve live task status, steering, approvals, and artifacts for a session."""
        if session_id not in self._sessions:
            return None
        snap = self._sessions[session_id]
        snap.pending_approvals = [a for a in self._approvals.values() if a.session_id == session_id and not a.resolved]
        snap.pending_steering = [s for s in self._steering_queue.get(session_id, []) if not s.applied]
        snap.artifacts = self._artifacts_by_session.get(session_id, [])
        return snap

    def queue_steering_guidance(self, session_id: str, guidance: str) -> SurfaceSteeringGuidance:
        """Queue guidance injected from any surface (e.g. CLI or TUI 'e' steering form)."""
        steer = SurfaceSteeringGuidance(session_id=session_id, guidance=guidance.strip())
        if session_id not in self._steering_queue:
            self._steering_queue[session_id] = []
        self._steering_queue[session_id].append(steer)
        self._persist_steering(session_id)
        return steer

    def drain_steering_guidance(self, session_id: str) -> List[SurfaceSteeringGuidance]:
        """Consume pending steering instructions for the active model turn."""
        items = [s for s in self._steering_queue.get(session_id, []) if not s.applied]
        for s in items:
            s.applied = True
        if items:
            self._persist_steering(session_id)
        return items

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
        self._persist_approval(req)
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
        self._persist_approval(req)
        return req

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
        self._persist_artifacts(session_id)
        return artifact


_GLOBAL_MANAGER: SurfaceGatewayManager | None = None


def get_surface_gateway_manager() -> SurfaceGatewayManager:
    global _GLOBAL_MANAGER
    if _GLOBAL_MANAGER is None:
        _GLOBAL_MANAGER = SurfaceGatewayManager()
    return _GLOBAL_MANAGER


def set_surface_gateway_manager(manager: SurfaceGatewayManager | None) -> None:
    global _GLOBAL_MANAGER
    _GLOBAL_MANAGER = manager
