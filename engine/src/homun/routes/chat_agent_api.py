"""Conversazioni legate a un agente: la chat singola con l'agente."""
from fastapi import APIRouter, Header
from pydantic import BaseModel, Field

from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/chat-agent", tags=["chat-agent"])


class BindRequest(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=160)
    agent_id: str = Field(min_length=1, max_length=160)


@router.post("/bind")
def bind(workspace_id: str, body: BindRequest,
         x_homun_actor_id: str | None = Header(default=None),
         x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.application import chat_agent
    try:
        return chat_agent.bind(ctx, actor, body.conversation_id, body.agent_id)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/unbind")
def unbind(workspace_id: str, body: BindRequest,
           x_homun_actor_id: str | None = Header(default=None),
         x_homun_actor_name: str | None = Header(default=None)):
    ctx, _actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.application import chat_agent
    return {"conversation_id": body.conversation_id,
            "unbound": chat_agent.unbind(ctx, body.conversation_id)}


@router.get("/{conversation_id}")
def status(workspace_id: str, conversation_id: str,
           x_homun_actor_id: str | None = Header(default=None),
           x_homun_actor_name: str | None = Header(default=None)):
    ctx, _actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.application import chat_agent
    binding = chat_agent.binding_for(ctx, conversation_id)
    return {"conversation_id": conversation_id,
            "agent_id": binding["agent_id"] if binding else None}
