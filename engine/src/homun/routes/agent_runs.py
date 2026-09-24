"""Adaptive runs: selected sources, explicit scope approval, observable progress."""
from typing import Literal
from fastapi import APIRouter, Header
from pydantic import BaseModel, Field
from homun.application.agent_runs import approve, list_runs, propose
from homun.application.agent_control import control
from homun.application.agent_side_questions import answer_side_question
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix='/v1/workspaces/{workspace_id}', tags=['agent-runs'])


class RunRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    expected_version: int = Field(ge=1)
    terminal_image: str | None = Field(default=None,pattern=r'^sha256:[0-9a-f]{64}$')
    terminal_backend: Literal['docker', 'local', 'ssh', 'modal', 'managed_modal', 'singularity', 'daytona', 'vercel'] | None = None
    ssh_host: str | None = Field(default=None, max_length=253)
    ssh_user: str | None = Field(default=None, max_length=32)
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    ssh_host_key: str | None = Field(default=None, max_length=2000)
    ssh_key_path: str | None = Field(default=None, max_length=4096)
    web_pages: bool = False
    browser: bool = False
    server_ids: list[str] = Field(default_factory=list, max_length=4)
    material_ids: list[str] = Field(default_factory=list, max_length=12)
    team_id: str | None = Field(default=None, max_length=160)
    person_id: str | None = Field(default=None, min_length=1, max_length=160)
    cwd: str | None = Field(default=None, max_length=4096)
    workspace_root: str | None = Field(default=None, max_length=4096)


class RunApproval(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    expected_version: int = Field(ge=1)
    digest: str


class RunView(BaseModel):
    id: str
    work_id: str
    status: str
    expected_version: int
    digest: str
    materials: list[dict]
    team: dict | None = None
    person: dict | None = None
    limits: dict
    external_tools: list[dict] | None = None
    external_request_id: str | None = None
    terminal_request_id: str | None = None
    file_edit_request_id: str | None = None
    terminal: dict | None = None
    web_pages: dict | None = None
    browser: dict | None = None
    tools: list[dict] | None = None
    tool_version: str
    assignee_id: str
    executor_name: str
    connection_id: str
    observations: list[dict]
    context: dict | None = None
    recovery: dict | None = None
    turns: int
    model_attempts: int
    history_redacted: bool = False
    request_id: str | None = None
    artifact_id: str | None = None
    error_code: str | None = None


class RunList(BaseModel):
    items: list[RunView]


@router.post('/works/{work_id}/agent-runs', response_model=RunView, response_model_exclude_none=True)
def create_run(workspace_id: str, work_id: str, body: RunRequest,
               x_homun_actor_id: str | None = Header(default=None),
               x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return propose(ctx, actor, work_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get('/works/{work_id}/agent-runs', response_model=RunList, response_model_exclude_none=True)
def get_runs(workspace_id: str, work_id: str,
             x_homun_actor_id: str | None = Header(default=None),
             x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return list_runs(ctx, actor, work_id)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post('/works/{work_id}/agent-runs/{run_id}/approve', response_model=RunView, response_model_exclude_none=True)
def approve_run(workspace_id: str, work_id: str, run_id: str, body: RunApproval,
                x_homun_actor_id: str | None = Header(default=None),
                x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return approve(ctx, actor, work_id, run_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


class RunControl(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    expected_version: int = Field(ge=1)
    action: Literal['steer','redirect','pause','resume','cancel']
    text: str | None = Field(default=None, min_length=1, max_length=16000)


@router.post('/works/{work_id}/agent-runs/{run_id}/control', response_model=RunView, response_model_exclude_none=True)
def control_run(workspace_id: str, work_id: str, run_id: str, body: RunControl,
                x_homun_actor_id: str | None = Header(default=None),
                x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return control(ctx, actor, work_id, run_id, body.model_dump(exclude_none=True))
    except DomainError as exc:
        raise _http_error(exc) from exc


class SideQuestionRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)


class SideQuestionView(BaseModel):
    answer: str
    usage: dict | None = None
    attempted_tools: list[str] = Field(default_factory=list)
    run_id: str
    work_id: str
    main_transcript_unchanged: bool = True


@router.post(
    '/works/{work_id}/agent-runs/{run_id}/side-question',
    response_model=SideQuestionView,
    response_model_exclude_none=True,
)
def side_question(
    workspace_id: str,
    work_id: str,
    run_id: str,
    body: SideQuestionRequest,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
):
    """Answer a detached /btw question without mutating the main run transcript (H03)."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return answer_side_question(ctx, actor, work_id, run_id, body.question)
    except DomainError as error:
        raise _http_error(error) from error
