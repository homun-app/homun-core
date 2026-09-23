"""Typed intake transport. Failed interpretation remains a retryable proposal."""
from typing import Literal
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field
from homun.application.intake import classify_message, confirm, list_proposals, propose
from homun.domain.errors import DomainError
from homun.models.intake import NewAgent
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router=APIRouter(prefix='/v1/workspaces/{workspace_id}',tags=['intake'])

class IntakeRequest(BaseModel):
    command_id: str = Field(min_length=1,max_length=160)
    text: str = Field(min_length=1,max_length=12000)
    expected_version: int = Field(ge=1)
    language: str | None = Field(default=None, max_length=8)

class ConfirmRequest(BaseModel):
    command_id: str = Field(min_length=1,max_length=160)
    digest: str
    expected_version: int = Field(ge=1)
    create_agent: bool = False

class SuggestedAgent(BaseModel):
    id: str
    name: str
    role: str
    revision: int

class PlanStepPayload(BaseModel):
    title: str
    capability: Literal['compare_csv', 'read_material', 'synthesize', 'general'] = 'general'
    expected_materials: list[str] = Field(default_factory=list)
    output_expected: str = ''
    assignee: str = ''

class BriefChange(BaseModel):
    field: str
    from_value: str | list[str] | None = None
    to_value: str | list[str] | None = None

class IntakeProposal(BaseModel):
    id: str
    status: Literal['pending_confirmation','confirmed','failed']
    work_id: str
    expected_version: int
    digest: str
    title: str
    objective: str
    output: str
    constraints: list[str]
    missing_information: list[str]
    suggested_agent: SuggestedAgent | None = None
    new_agent: NewAgent | None = None
    rationale: str
    capability: Literal['compare_csv','read_material','synthesize','general']
    original_request: str
    changed_fields: list[str] = Field(default_factory=list)
    changes: list[BriefChange] = Field(default_factory=list)
    plan_steps: list[PlanStepPayload] = Field(default_factory=list)
    error_code: str | None = None

class IntakeList(BaseModel):
    items: list[IntakeProposal]

class ClassifyRequest(BaseModel):
    text: str = Field(min_length=1, max_length=12000)

class IntakeClassification(BaseModel):
    kind: Literal['work_request', 'question']
    language: str | None = None

@router.post('/works/{work_id}/intake/classify', response_model=IntakeClassification)
def classify_intake(workspace_id:str,work_id:str,body:ClassifyRequest,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    """Routing aid only: it stores nothing and never assigns or executes."""
    ctx,actor=request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    try:
        kind, language = classify_message(ctx,actor,work_id,body.text)
        return IntakeClassification(kind=kind, language=language)
    except DomainError as exc:
        raise _http_error(exc) from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=503, detail={'code':'intake_invalid_response','message':'Classification unavailable; the client falls back to a proposal'}) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail={'code':'provider_unavailable','message':'Model provider unavailable for classification'}) from exc

@router.post('/works/{work_id}/intake',response_model=IntakeProposal)
def post_intake(workspace_id:str,work_id:str,body:IntakeRequest,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    ctx,actor=request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    try:
        return propose(ctx,actor,work_id,body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc

@router.get('/works/{work_id}/intake',response_model=IntakeList)
def get_intake(workspace_id:str,work_id:str,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    ctx,actor=request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    try:
        return list_proposals(ctx,actor,work_id)
    except DomainError as exc:
        raise _http_error(exc) from exc

@router.post('/works/{work_id}/intake/{proposal_id}/confirm',response_model=IntakeProposal)
def confirm_intake(workspace_id:str,work_id:str,proposal_id:str,body:ConfirmRequest,x_homun_actor_id:str|None=Header(default=None),x_homun_actor_name:str|None=Header(default=None)):
    ctx,actor=request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    try:
        return confirm(ctx,actor,work_id,proposal_id,body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc
