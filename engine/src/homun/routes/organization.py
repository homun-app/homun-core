"""Optional company onboarding transport, bound to the authenticated local actor."""
from fastapi import APIRouter, Header
from pydantic import BaseModel, Field
from homun.application import organization
from homun.models.organization import OrganizationContext
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix='/v1/workspaces/{workspace_id}/organization', tags=['organization'])

class RevisionRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    expected_revision: int = Field(ge=0)

class ContextRequest(OrganizationContext, RevisionRequest):
    pass

class ConfirmRequest(RevisionRequest):
    proposal_id: str


def _call(workspace_id, actor_id, actor_name, operation, body=None):
    ctx,actor = request_context(workspace_id,actor_id,actor_name)
    try:
        return operation(ctx,actor,body.model_dump()) if body is not None else operation(ctx,actor)
    except DomainError as exc:
        raise _http_error(exc) from exc

@router.get('')
def get_state(workspace_id:str,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    return _call(workspace_id,x_homun_actor_id,x_homun_actor_name,organization.get_state)

@router.post('/context')
def update_context(workspace_id:str,body:ContextRequest,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    return _call(workspace_id,x_homun_actor_id,x_homun_actor_name,organization.update_context,body)

@router.post('/propose')
def propose(workspace_id:str,body:RevisionRequest,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    return _call(workspace_id,x_homun_actor_id,x_homun_actor_name,organization.propose,body)

@router.post('/confirm')
def confirm(workspace_id:str,body:ConfirmRequest,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    return _call(workspace_id,x_homun_actor_id,x_homun_actor_name,organization.confirm,body)
