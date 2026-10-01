"""Conversazioni legate a un agente: la chat singola con l'agente."""
from fastapi import APIRouter, Header, Query
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


@router.get("/{conversation_id}/events")
def conversation_events_stream(workspace_id: str, conversation_id: str,
                               actor: str | None = Query(default=None),
                               x_homun_actor_id: str | None = Header(default=None),
                               x_homun_actor_name: str | None = Header(default=None)):
    """SSE: la conversazione in parti (run, tool, delta di testo, messaggi).

    EventSource non puo' inviare header: il fallback query actor vale
    quanto l'header (stessa risoluzione, stesso spazio dei nomi).
    """
    from fastapi.responses import StreamingResponse
    ctx, resolved = request_context(workspace_id, x_homun_actor_id or actor,
                                    x_homun_actor_name)
    actor = resolved
    from homun.application.chat_events import conversation_events_threaded
    return StreamingResponse(
        conversation_events_threaded(ctx, actor, conversation_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/{conversation_id}/browser-pip")
def browser_pip(workspace_id: str, conversation_id: str,
                actor: str | None = Query(default=None),
                x_homun_actor_id: str | None = Header(default=None),
                x_homun_actor_name: str | None = Header(default=None)):
    """Stato live del browser dell'agente per il PiP: url + screenshot.

    Risponde per il run chat attivo della conversazione; se il run non sta
    usando il browser, active=false (il PiP si nasconde da solo).
    """
    import base64
    import tempfile
    from pathlib import Path

    ctx, _resolved = request_context(workspace_id, x_homun_actor_id or actor,
                                     x_homun_actor_name)
    from homun.application.chat_agent import _active_chat_run
    run = _active_chat_run(ctx.repository.load(), conversation_id)
    if run is None:
        return {"active": False}
    from homun.execution.browser_sessions import require_browser
    browser = require_browser(str(run.get("id")))
    if browser is None:
        return {"active": False, "run_id": run.get("id")}
    from homun.execution.browser_shots import capture
    with tempfile.TemporaryDirectory() as tmp:
        shot = capture(browser, Path(tmp) / "pip.png")
    if not isinstance(shot, dict) or "url" not in shot:
        return {"active": False, "run_id": run.get("id")}
    png = Path(shot["path"]).read_bytes()
    return {
        "active": True,
        "run_id": run.get("id"),
        "url": shot.get("url"),
        "width": shot.get("width"),
        "height": shot.get("height"),
        "screenshot": "data:image/png;base64," + base64.b64encode(png).decode(),
    }
