"""Public terminal request contracts and immutable consent payload."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from homun.execution.contracts import JobSpec, LocalJobSpec, SshJobSpec, digest


class TerminalProposalRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    command_id: str = Field(min_length=1, max_length=160)
    image: str | None = Field(default=None, pattern=r'^sha256:[0-9a-f]{64}$')
    command: str = Field(min_length=1, max_length=16000)
    expected_version: int = Field(ge=1)
    timeout_seconds: int = Field(default=300,ge=1,le=3600)
    background: bool = False
    stdin: bool = False
    pty: bool = False
    policy: Literal['docker-offline-v1', 'local-private-v1', 'ssh-v1'] = 'docker-offline-v1'
    ssh_host: str | None = Field(default=None, pattern=r'^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$')
    ssh_user: str | None = Field(default=None, pattern=r'^[A-Za-z0-9._-]{1,32}$')
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    ssh_host_key: str | None = Field(default=None, pattern=r'^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+$', max_length=2000)


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
    expected_version: int
    policy: Literal['docker-offline-v1', 'local-private-v1', 'ssh-v1']
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
    if proposal.get('background'):bound['background']=True
    if proposal.get('stdin'):bound['stdin']=True
    if proposal.get('pty'):bound['pty']=True
    for key in ('ssh_host','ssh_user','ssh_port','ssh_host_key','ssh_key_fingerprint'):
        if key in proposal:bound[key]=proposal[key]
    if proposal.get('_agent_binding'):bound['_agent_binding']=proposal['_agent_binding']
    return digest(bound)


def job_spec(ctx, proposal: dict) -> JobSpec | LocalJobSpec | SshJobSpec:
    common=dict(workspace_id=ctx.workspace_id,run_id=proposal.get('_agent_binding',{}).get('run_id',proposal['work_id']),
                call_id=proposal['id'],command=proposal['command'])
    if proposal.get('policy')=='local-private-v1':
        return LocalJobSpec(**common)
    if proposal.get('policy')=='ssh-v1':
        return SshJobSpec(**common, host=proposal['ssh_host'], user=proposal['ssh_user'], port=proposal['ssh_port'],
                          host_key=proposal['ssh_host_key'], key_fingerprint=proposal['ssh_key_fingerprint'],
                          key_path=proposal['_ssh_key_path'])
    return JobSpec(**common,image=proposal['image'])


def public(proposal: dict) -> dict:
    return TerminalProposal.model_validate(proposal).model_dump(exclude_none=True)
