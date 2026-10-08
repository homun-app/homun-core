"""Authenticated native terminal proposals and explicit process control."""
from fastapi import APIRouter, Header
from homun.application import terminal_jobs
from homun.application.terminal_contracts import (
    TerminalApprovalRequest, TerminalList, TerminalProposal, TerminalProposalRequest,
)
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix='/v1/workspaces/{workspace_id}/works/{work_id}/terminal-jobs',tags=['terminal'])


def _call(operation,workspace_id,actor_id,actor_name,*args):
    ctx,actor = request_context(workspace_id,actor_id,actor_name)
    try:
        return operation(ctx,actor,*args)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post('',response_model=TerminalProposal,response_model_exclude_none=True)
def propose(workspace_id: str,work_id: str,body: TerminalProposalRequest,
            x_homun_actor_id: str | None = Header(default=None),
            x_homun_actor_name: str | None = Header(default=None)):
    return _call(terminal_jobs.propose,workspace_id,x_homun_actor_id,x_homun_actor_name,work_id,body.model_dump())


@router.get('',response_model=TerminalList,response_model_exclude_none=True)
def list_jobs(workspace_id: str,work_id: str,
              x_homun_actor_id: str | None = Header(default=None),
              x_homun_actor_name: str | None = Header(default=None)):
    return _call(terminal_jobs.list_for_work,workspace_id,x_homun_actor_id,x_homun_actor_name,work_id)


@router.post('/{proposal_id}/approve',response_model=TerminalProposal,response_model_exclude_none=True)
def approve(workspace_id: str,work_id: str,proposal_id: str,body: TerminalApprovalRequest,
            x_homun_actor_id: str | None = Header(default=None),
            x_homun_actor_name: str | None = Header(default=None)):
    return _call(terminal_jobs.approve,workspace_id,x_homun_actor_id,x_homun_actor_name,work_id,proposal_id,body.model_dump())


@router.post('/{proposal_id}/refresh',response_model=TerminalProposal,response_model_exclude_none=True)
def refresh(workspace_id: str,work_id: str,proposal_id: str,
            x_homun_actor_id: str | None = Header(default=None),
            x_homun_actor_name: str | None = Header(default=None)):
    return _call(terminal_jobs.refresh,workspace_id,x_homun_actor_id,x_homun_actor_name,work_id,proposal_id)


@router.post('/{proposal_id}/stop',response_model=TerminalProposal,response_model_exclude_none=True)
def stop(workspace_id: str,work_id: str,proposal_id: str,
         x_homun_actor_id: str | None = Header(default=None),
         x_homun_actor_name: str | None = Header(default=None)):
    return _call(terminal_jobs.stop,workspace_id,x_homun_actor_id,x_homun_actor_name,work_id,proposal_id)
