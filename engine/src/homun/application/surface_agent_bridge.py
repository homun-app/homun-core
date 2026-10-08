"""Bridge multi-surface steering onto the canonical agent_run steering queue (H34)."""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from uuid import uuid4

from homun.application.surface_gateway_manager import SurfaceGatewayManager, get_surface_gateway_manager
from homun.domain.models import Actor


def import_surface_steering_into_run(
    run: Dict[str, Any],
    actor: Actor,
    *,
    manager: Optional[SurfaceGatewayManager] = None,
    session_id: Optional[str] = None,
) -> int:
    """Drain surface steering for run/session id into run["_steering"]. Returns count."""
    mgr = manager or get_surface_gateway_manager()
    key = session_id or str(run.get("id") or "")
    if not key:
        return 0
    items = mgr.drain_steering_guidance(key)
    for item in items:
        run.setdefault("_steering", []).append(
            {
                "text": item.guidance,
                "command_id": f"surface-{uuid4().hex[:10]}",
                "actor_id": actor.id,
                "source": "surface_gateway",
            }
        )
    return len(items)
