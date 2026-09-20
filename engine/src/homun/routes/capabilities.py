"""Actor-scoped read of registered capabilities and their current availability."""
from fastapi import APIRouter, Header
from pydantic import BaseModel

from homun.context import get_context
from homun.domain.capabilities import REGISTRY
from homun.policy.capabilities import capability_catalog
from homun.routes.domain_support import _actor_from_headers

router = APIRouter(prefix='/v1/workspaces/{workspace_id}', tags=['capabilities'])


class CapabilityItem(BaseModel):
    id: str
    kind: str
    tool_version: str
    summary: str
    inputs: list[str]
    outputs: list[str]
    effects: list[str]
    prerequisites: list[str]
    limits: dict[str, int]
    timeout_seconds: int
    ready: bool
    eligible_materials: int | None = None


class CapabilityCatalog(BaseModel):
    items: list[CapabilityItem]


@router.get('/capabilities', response_model=CapabilityCatalog)
def list_capabilities(workspace_id: str,
                      x_homun_actor_id: str | None = Header(default=None),
                      x_homun_actor_name: str | None = Header(default=None)):
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        from fastapi import HTTPException
        raise HTTPException(404, detail={'code': 'not_found', 'message': 'Unknown workspace'})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    return {'items': capability_catalog(ctx.service.store, actor)}


def transport_ids():
    """Intake transport keeps its Literal vocabulary in sync with the registry."""
    return tuple(REGISTRY)
