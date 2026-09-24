"""Public terminal request contracts and immutable consent payload."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from homun.execution.contracts import JobSpec, digest


class TerminalProposalRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    command_id: str = Field(min_length=1, max_length=160)
    image: str = Field(pattern=r'^sha256:[0-9a-f]{64}$')
    command: str = Field(min_length=1, max_length=16000)
    expected_version: int = Field(ge=1)


class TerminalApprovalRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    digest: str = Field(pattern=r'^[0-9a-f]{64}$')


class TerminalLogs(BaseModel):
    text: str
    truncated: bool
    tail_only: bool
    line_limit: int


class TerminalProposal(BaseModel):
    id: str
    work_id: str
    image: str
    command: str
    expected_version: int
    policy: Literal['docker-offline-v1']
    digest: str
    status: Literal['pending_approval','dispatching','created','running','paused','restarting','removing','exited','dead','outcome_unknown']
    created_by: str
    created_at: str
    running: bool | None = None
    exit_code: int | None = None
    oom_killed: bool | None = None
    logs: TerminalLogs | None = None
    error_code: str | None = None
    error: str | None = None


class TerminalList(BaseModel):
    items: list[TerminalProposal]


def consent(proposal: dict) -> str:
    return digest({k:proposal[k] for k in ('id','work_id','image','command','expected_version','policy','created_by')})


def job_spec(ctx, proposal: dict) -> JobSpec:
    return JobSpec(workspace_id=ctx.workspace_id,run_id=proposal['work_id'],call_id=proposal['id'],
                   image=proposal['image'],command=proposal['command'])


def public(proposal: dict) -> dict:
    return TerminalProposal.model_validate(proposal).model_dump(exclude_none=True)
