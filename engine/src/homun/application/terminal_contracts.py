"""Public terminal request contracts and immutable consent payload."""
from typing import Literal
import re
from pydantic import BaseModel, ConfigDict, Field, model_validator
from homun.domain.errors import ValidationError
from homun.execution.contracts import JobSpec, LocalJobSpec, SshJobSpec, digest
from homun.execution.singularity_jobs import SingularityJobSpec
from homun.execution.modal_jobs import ModalJobSpec
from homun.execution.daytona_jobs import DaytonaJobSpec


class TerminalProposalRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    command_id: str = Field(min_length=1, max_length=160)
    image: str | None = Field(default=None, max_length=4000)
    command: str = Field(min_length=1, max_length=16000)
    cwd: str = '.'
    expected_version: int = Field(ge=1)
    timeout_seconds: int = Field(default=300,ge=1,le=3600)
    background: bool = False
    stdin: bool = False
    pty: bool = False
    policy: Literal[
        'docker-offline-v1',
        'local-private-v1',
        'ssh-v1',
        'cloud-singularity-v1',
        'cloud-modal-v1',
        'cloud-managed_modal-v1',
        'cloud-daytona-v1',
        'cloud-vercel-v1',
    ] = 'docker-offline-v1'
    ssh_host: str | None = Field(default=None, pattern=r'^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$')
    ssh_user: str | None = Field(default=None, pattern=r'^[A-Za-z0-9._-]{1,32}$')
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    ssh_host_key: str | None = Field(default=None, pattern=r'^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+$', max_length=2000)

    @model_validator(mode='after')
    def docker_image_must_be_digest(self):
        if self.policy == 'docker-offline-v1' and self.image is not None:
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', self.image):
                raise ValueError('Terminal image must be a pinned SHA256')
        return self


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
    image: str | None = None
    command: str
    cwd: str | None = None
    expected_version: int
    policy: Literal[
        'docker-offline-v1',
        'local-private-v1',
        'ssh-v1',
        'cloud-singularity-v1',
        'cloud-modal-v1',
        'cloud-managed_modal-v1',
        'cloud-daytona-v1',
        'cloud-vercel-v1',
    ]
    digest: str
    status: Literal['pending_approval','dispatching','created','running','paused','restarting','removing','exited','dead','outcome_unknown']
    agent_run_id: str | None = None
    created_by: str
    created_at: str
    timeout_seconds: int | None = None
    background: bool | None = None
    stdin: bool | None = None
    pty: bool | None = None
    ssh_host: str | None = None
    ssh_user: str | None = None
    ssh_port: int | None = None
    ssh_host_key: str | None = None
    ssh_key_fingerprint: str | None = None
    deadline_at: str | None = None
    timed_out: bool = False
    running: bool | None = None
    exit_code: int | None = None
    oom_killed: bool | None = None
    logs: TerminalLogs | None = None
    error_code: str | None = None
    error: str | None = None


class TerminalList(BaseModel):
    items: list[TerminalProposal]


def consent(proposal: dict) -> str:
    fields=('id','work_id','image','command','expected_version','policy','created_by')
    bound={k:proposal[k] for k in fields if k in proposal}
    if 'timeout_seconds' in proposal:bound['timeout_seconds']=proposal['timeout_seconds']
    if proposal.get('cwd', '.') != '.':bound['cwd']=proposal['cwd']
    if proposal.get('background'):bound['background']=True
    if proposal.get('stdin'):bound['stdin']=True
    if proposal.get('pty'):bound['pty']=True
    for key in ('ssh_host','ssh_user','ssh_port','ssh_host_key','ssh_key_fingerprint'):
        if key in proposal:bound[key]=proposal[key]
    if proposal.get('_agent_binding'):bound['_agent_binding']=proposal['_agent_binding']
    return digest(bound)


def job_spec(ctx, proposal: dict) -> JobSpec | LocalJobSpec | SshJobSpec | SingularityJobSpec:
    common=dict(workspace_id=ctx.workspace_id,run_id=proposal.get('_agent_binding',{}).get('run_id',proposal['work_id']),
                call_id=proposal['id'],command=proposal['command'])
    if proposal.get('policy')=='local-private-v1':
        return LocalJobSpec(**common, cwd=proposal.get('cwd', '.'), deadline_at=proposal.get("deadline_at") if proposal.get("_local_deadline_supervised") else None)
    if proposal.get('policy')=='ssh-v1':
        return SshJobSpec(**common, host=proposal['ssh_host'], user=proposal['ssh_user'], port=proposal['ssh_port'],
                          host_key=proposal['ssh_host_key'], key_fingerprint=proposal['ssh_key_fingerprint'],
                          key_path=proposal['_ssh_key_path'])
    if proposal.get('policy')=='cloud-singularity-v1':
        image = proposal.get('image') or proposal.get('singularity_image')
        if not image:
            raise ValidationError('Singularity image (SIF path or docker:// URI) is required')
        return SingularityJobSpec(**common, image=image)
    if proposal.get('policy')=='cloud-modal-v1':
        image = proposal.get('image')
        if not image:
            raise ValidationError('Modal registry image reference is required')
        return ModalJobSpec(**common, image=image)
    if proposal.get('policy')=='cloud-daytona-v1':
        image = proposal.get('image')
        if not image:
            raise ValidationError('Daytona image reference is required')
        return DaytonaJobSpec(**common, image=image)
    return JobSpec(**common,image=proposal['image'],cwd=proposal.get('cwd', '.'))


def public(proposal: dict) -> dict:
    return TerminalProposal.model_validate(proposal).model_dump(exclude_none=True)
