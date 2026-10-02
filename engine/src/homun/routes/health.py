"""Health and capabilities endpoints for the local handshake spike."""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from fastapi import APIRouter

from homun import __version__
from homun.context import get_context
from homun.memory.mem0_port import DualWriteMemoryPort, describe_memory_backend
from homun.runtime import EngineCapabilities, get_capabilities, get_uptime_seconds

router = APIRouter(prefix="/v1", tags=["system"])


class HealthResponse(TypedDict):
    status: Literal["ok"]
    version: str
    uptime_seconds: float
    db: dict[str, Any]


@router.get("/health")
def health() -> HealthResponse:
    from homun.storage.recovery import db_state
    ctx = get_context()
    return {
        "status": "ok",
        "version": __version__,
        "uptime_seconds": get_uptime_seconds(),
        "db": db_state(ctx.repository.path.parent),
    }


@router.get("/diagnostics/db")
def diagnostics_db() -> dict[str, Any]:
    """Rapporto di recovery persistente: modalità, tabelle, problemi, quarantena."""
    from homun.storage.recovery import db_state
    ctx = get_context()
    return db_state(ctx.repository.path.parent)


@router.get("/capabilities")
def capabilities() -> EngineCapabilities:
    return get_capabilities()


@router.get("/memory/status")
def memory_status() -> dict[str, Any]:
    """Operator status: sqlite ledger vs local Mem0 (Ollama+Qdrant)."""
    ctx = get_context()
    port = ctx.memory
    if isinstance(port, DualWriteMemoryPort):
        return port.status()
    return describe_memory_backend(mem0_client=None)
