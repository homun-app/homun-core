"""Health and capabilities endpoints for the local handshake spike."""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from fastapi import APIRouter, Header

from homun import __version__
from homun.context import get_context
from homun.domain.errors import DomainError
from homun.memory.mem0_port import DualWriteMemoryPort, describe_memory_backend
from homun.routes.domain_support import _actor_from_headers, _http_error
from homun.runtime import EngineCapabilities, get_capabilities, get_uptime_seconds

router = APIRouter(prefix="/v1", tags=["system"])


class HealthResponse(TypedDict):
    status: Literal["ok"]
    version: str
    uptime_seconds: float
    db: dict[str, str]


@router.get("/health")
def health() -> HealthResponse:
    from homun.storage.recovery import db_health_summary
    ctx = get_context()
    return {
        "status": "ok",
        "version": __version__,
        "uptime_seconds": get_uptime_seconds(),
        "db": db_health_summary(ctx.repository.path.parent),
    }


@router.get("/diagnostics/db")
def diagnostics_db(
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    """Full recovery report: mode, tables, issues, quarantine. Owner/admin only."""
    from homun.identity import require_owner_or_admin
    from homun.storage.recovery import db_state
    ctx = get_context()
    actor = _actor_from_headers(ctx.workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        require_owner_or_admin(
            ctx, actor,
            message="Only an owner or admin can read database diagnostics",
        )
    except DomainError as exc:
        raise _http_error(exc) from exc
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
