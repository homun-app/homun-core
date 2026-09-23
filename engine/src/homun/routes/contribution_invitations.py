"""Session-owned invitation management and exactly two guest-authenticated routes."""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from homun.application import contribution_invitations as invites
from homun.context import get_context
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(tags=['contribution-invitations'])
GUEST_PATHS = frozenset({'/v1/contribution-portal/read','/v1/contribution-portal/respond'})

class InvitationRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    recipient_name: str = Field(min_length=1,max_length=120)

class ResponseRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    text: str = Field(min_length=1,max_length=12000)

def _call(fn,*args):
    try:
        return fn(*args)
    except DomainError as exc:
        raise _http_error(exc) from exc

def _token(header):
    if not header or not header.startswith('Bearer ') or len(header)>256:
        raise HTTPException(401,detail={'code':'unauthorized','message':'Invitation credential required'})
    return header[7:]

@router.get('/v1/workspaces/{workspace_id}/works/{work_id}/contribution-invitations')
def list_invitations(workspace_id:str,work_id:str,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    ctx,actor = request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    return _call(invites.list_invitations,ctx,actor,work_id)

@router.post('/v1/workspaces/{workspace_id}/contributions/{request_id}/invitation')
def issue(workspace_id:str,request_id:str,body:InvitationRequest,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    ctx,actor = request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    return _call(invites.issue_invitation,ctx,actor,request_id,body.model_dump())

@router.post('/v1/workspaces/{workspace_id}/contribution-invitations/{invitation_id}/revoke')
def revoke(workspace_id:str,invitation_id:str,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    ctx,actor = request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    return _call(invites.revoke_invitation,ctx,actor,invitation_id)

@router.post('/v1/contribution-portal/read')
def read(authorization:str|None=Header(default=None)):
    return _call(invites.read_invitation,get_context(),_token(authorization))

@router.post('/v1/contribution-portal/respond')
def respond(body:ResponseRequest,authorization:str|None=Header(default=None)):
    return _call(invites.respond,get_context(),_token(authorization),body.text)

from homun.application import contribution_people

class PersonRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    command_id: str = Field(min_length=1,max_length=160)
    name: str = Field(min_length=1,max_length=120)

class AskPersonRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    command_id: str = Field(min_length=1,max_length=160)
    person_id: str
    need: str = Field(min_length=1,max_length=4000)
    step_id: str = Field(min_length=1,max_length=160)
    expected_version: int = Field(ge=1)

@router.get('/v1/workspaces/{workspace_id}/people')
def people(workspace_id:str,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    ctx,actor = request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    return _call(contribution_people.list_people,ctx,actor)

@router.post('/v1/workspaces/{workspace_id}/people')
def define_person(workspace_id:str,body:PersonRequest,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    ctx,actor = request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    return _call(contribution_people.create_person,ctx,actor,body.model_dump())

@router.post('/v1/workspaces/{workspace_id}/works/{work_id}/ask-person')
def ask_person(workspace_id:str,work_id:str,body:AskPersonRequest,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    ctx,actor = request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    return _call(contribution_people.request_contribution,ctx,actor,work_id,body.model_dump())
