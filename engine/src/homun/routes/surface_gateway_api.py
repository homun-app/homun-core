"""REST API router for Multi-Surface Gateway (H34).

Exposes surface connection management, cross-surface session synchronization,
coherent steering queues, unified approvals, and artifact registries.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from homun.application.surface_contracts import ConnectionTransportKind, SurfaceKind
from homun.application.surface_gateway_manager import SurfaceGatewayManager, get_surface_gateway_manager, get_surface_gateway_manager

router = APIRouter(prefix="/v1/surfaces", tags=["surfaces"])




# ── Schemas ─────────────────────────────────────────────────────────────

class ConnectionRegisterRequest(BaseModel):
    surface_kind: str
    transport: str
    endpoint: Optional[str] = ""
    profile: Optional[str] = "default"
    client_version: Optional[str] = "1.0.0"
    metadata: Dict[str, Any] = Field(default_factory=dict)


class SessionSyncRequest(BaseModel):
    session_id: str
    profile: str
    surface_kind: str
    status: str
    title: Optional[str] = ""
    cwd: Optional[str] = ""
    active_tools: Optional[List[str]] = None
    token_usage: Optional[Dict[str, int]] = None


class SteeringQueueRequest(BaseModel):
    session_id: str
    guidance: str


class ApprovalCreateRequest(BaseModel):
    session_id: str
    tool_name: str
    command: str
    description: str
    choices: Optional[List[str]] = None


class ApprovalResolveRequest(BaseModel):
    decision: str


class ArtifactRegisterRequest(BaseModel):
    session_id: str
    artifact_type: str
    path_or_url: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


# ── Connection Endpoints ────────────────────────────────────────────────

@router.post("/connections")
def register_connection(req: ConnectionRegisterRequest) -> Dict[str, Any]:
    """Register a new surface client connection."""
    try:
        kind = SurfaceKind(req.surface_kind)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid surface_kind: {req.surface_kind}")

    try:
        transport = ConnectionTransportKind(req.transport)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid transport: {req.transport}")

    conn = get_surface_gateway_manager().register_connection(
        surface_kind=kind,
        transport=transport,
        endpoint=req.endpoint or "",
        profile=req.profile or "default",
        client_version=req.client_version or "1.0.0",
        metadata=req.metadata,
    )
    return {
        "connection_id": conn.connection_id,
        "surface_kind": conn.surface_kind.value,
        "transport": conn.transport.value,
        "profile": conn.profile,
        "connected_at": conn.connected_at,
    }


@router.get("/connections")
def list_connections(profile: Optional[str] = None) -> Dict[str, Any]:
    """List active surface client connections."""
    conns = get_surface_gateway_manager().list_connections(profile=profile)
    return {
        "connections": [
            {
                "connection_id": c.connection_id,
                "surface_kind": c.surface_kind.value,
                "transport": c.transport.value,
                "profile": c.profile,
                "endpoint": c.endpoint,
                "client_version": c.client_version,
                "connected_at": c.connected_at,
            }
            for c in conns
        ]
    }


@router.delete("/connections/{connection_id}")
def disconnect(connection_id: str) -> Dict[str, Any]:
    """Disconnect a surface client."""
    ok = get_surface_gateway_manager().disconnect(connection_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Connection not found")
    return {"ok": True, "connection_id": connection_id}


# ── Session Synchronization Endpoints ───────────────────────────────────

@router.post("/sessions/sync")
def sync_session(req: SessionSyncRequest) -> Dict[str, Any]:
    """Synchronize task state across surfaces."""
    try:
        kind = SurfaceKind(req.surface_kind)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid surface_kind: {req.surface_kind}")

    snap = get_surface_gateway_manager().sync_session_state(
        session_id=req.session_id,
        profile=req.profile,
        surface_kind=kind,
        status=req.status,
        title=req.title or "",
        cwd=req.cwd or "",
        active_tools=req.active_tools,
        token_usage=req.token_usage,
    )
    return {
        "session_id": snap.session_id,
        "profile": snap.profile,
        "surface_kind": snap.surface_kind.value,
        "status": snap.status,
        "title": snap.title,
        "cwd": snap.cwd,
        "active_tools": snap.active_tools,
    }


@router.get("/sessions/{session_id}/snapshot")
def get_session_snapshot(session_id: str) -> Dict[str, Any]:
    """Get live task status, steering, approvals, and artifacts for a session."""
    snap = get_surface_gateway_manager().get_session_snapshot(session_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Session snapshot not found")

    return {
        "session_id": snap.session_id,
        "profile": snap.profile,
        "surface_kind": snap.surface_kind.value,
        "status": snap.status,
        "title": snap.title,
        "cwd": snap.cwd,
        "active_tools": snap.active_tools,
        "pending_approvals": [
            {
                "request_id": a.request_id,
                "tool_name": a.tool_name,
                "command": a.command,
                "description": a.description,
                "choices": a.choices,
            }
            for a in snap.pending_approvals
        ],
        "pending_steering": [
            {"guidance": s.guidance, "queued_at": s.queued_at}
            for s in snap.pending_steering
        ],
        "artifacts": snap.artifacts,
        "token_usage": snap.token_usage,
    }


# ── Steering Endpoints ──────────────────────────────────────────────────

@router.post("/steering")
def queue_steering(req: SteeringQueueRequest) -> Dict[str, Any]:
    """Queue steering guidance from any surface."""
    steer = get_surface_gateway_manager().queue_steering_guidance(req.session_id, req.guidance)
    return {
        "ok": True,
        "session_id": steer.session_id,
        "guidance": steer.guidance,
        "queued_at": steer.queued_at,
    }


@router.post("/sessions/{session_id}/steering/drain")
def drain_steering(session_id: str) -> Dict[str, Any]:
    """Consume pending steering instructions for active turn."""
    items = get_surface_gateway_manager().drain_steering_guidance(session_id)
    return {
        "session_id": session_id,
        "guidance_list": [{"guidance": s.guidance, "queued_at": s.queued_at} for s in items],
    }


# ── Approvals Endpoints ─────────────────────────────────────────────────

@router.post("/approvals")
def create_approval(req: ApprovalCreateRequest) -> Dict[str, Any]:
    """Post an action approval to the queue."""
    appr = get_surface_gateway_manager().request_approval(
        session_id=req.session_id,
        tool_name=req.tool_name,
        command=req.command,
        description=req.description,
        choices=req.choices,
    )
    return {
        "request_id": appr.request_id,
        "session_id": appr.session_id,
        "tool_name": appr.tool_name,
        "command": appr.command,
        "description": appr.description,
        "choices": appr.choices,
    }


@router.post("/approvals/{request_id}/resolve")
def resolve_approval(request_id: str, req: ApprovalResolveRequest) -> Dict[str, Any]:
    """Resolve a pending approval."""
    try:
        resolved = get_surface_gateway_manager().resolve_approval(request_id, req.decision)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not resolved:
        raise HTTPException(status_code=404, detail="Approval request not found or already resolved")

    return {
        "request_id": resolved.request_id,
        "decision": resolved.decision,
        "resolved": resolved.resolved,
    }


# ── Artifact Endpoints ──────────────────────────────────────────────────

@router.post("/artifacts")
def register_artifact(req: ArtifactRegisterRequest) -> Dict[str, Any]:
    """Record an artifact for multi-surface availability."""
    art = get_surface_gateway_manager().register_artifact(
        session_id=req.session_id,
        artifact_type=req.artifact_type,
        path_or_url=req.path_or_url,
        metadata=req.metadata,
    )
    return art
