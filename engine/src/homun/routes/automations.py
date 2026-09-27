"""Human configuration of work-scoped heartbeat and loop execution."""
from typing import Literal
from fastapi import APIRouter, Header
from homun.application.automation_configuration import AutomationCommand, configure
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix='/v1/workspaces/{workspace_id}/works/{work_id}/agent-runs', tags=['agent-runs'])


@router.post('/{run_id}/automations/{kind}')
def configure_automation(workspace_id: str, work_id: str, run_id: str,
                         kind: Literal['heartbeat','loop'], body: AutomationCommand,
                         x_homun_actor_id: str | None = Header(default=None),
                         x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return configure(ctx, actor, work_id, run_id, kind, body)
    except DomainError as exc:
        raise _http_error(exc) from exc
