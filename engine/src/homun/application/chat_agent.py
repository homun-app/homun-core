"""Conversazioni con l'agente: la chat singola funziona come ci si aspetta.

Una conversazione può essere legata a un agente; da quel momento ogni
messaggio della persona avvia (o_steera) un run nativo dell'agente su quel
testo, e la risposta finale dell'agente torna nella conversazione come
messaggio. Niente cerimonia di lavoro: il lavoro chat è nascosto e riusato.
I gate (terminale, modifiche file) restano quelli del motore.
"""
from __future__ import annotations

import json
import logging
import secrets
from pathlib import Path
from typing import Any, Dict, Optional

from homun.domain.errors import DomainError, NotFoundError, ValidationError
from homun.domain.models import Actor, utc_now

logger = logging.getLogger(__name__)

STATE_FILENAME = "chat_agents.json"
CHAT_WORK_TITLE = "Chat agente"


def _state_path(ctx) -> Path:
    return ctx.data_dir / STATE_FILENAME


def _load(ctx) -> Dict[str, Any]:
    try:
        data = json.loads(_state_path(ctx).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        logger.warning("chat agent state illegibile, si riparte da zero", exc_info=True)
        return {}


def _save(ctx, state: Dict[str, Any]) -> None:
    path = _state_path(ctx)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def binding_for(ctx, conversation_id: str) -> Optional[Dict[str, Any]]:
    entry = _load(ctx).get(conversation_id)
    return entry if isinstance(entry, dict) and entry.get("agent_id") else None


def bind(ctx, actor: Actor, conversation_id: str, agent_id: str) -> Dict[str, Any]:
    store = ctx.repository.load()
    if conversation_id not in store.conversations:
        raise NotFoundError(f"Conversation not found: {conversation_id}")
    agent = store.agents.get(agent_id)
    if agent is None or agent.status == "retired":
        raise NotFoundError(f"Agent not found: {agent_id}")
    state = _load(ctx)
    state[conversation_id] = {"agent_id": agent_id}
    _save(ctx, state)
    return {"conversation_id": conversation_id, "agent_id": agent_id}


def unbind(ctx, conversation_id: str) -> bool:
    state = _load(ctx)
    removed = state.pop(conversation_id, None) is not None
    if removed:
        _save(ctx, state)
    return removed


def _active_chat_run(store, conversation_id: str):
    """Un run nativo attivo del lavoro chat di questa conversazione."""
    from homun.application.agent_runs import PROPOSAL_TYPE
    for record in store.commands.values():
        if record.type != PROPOSAL_TYPE or not isinstance(record.result, dict):
            continue
        run = record.result
        if run.get("status") not in {"queued", "running", "waiting_input",
                                     "waiting_external", "waiting_automation", "paused"}:
            continue
        work = store.works.get(run.get("work_id", ""))
        if work and work.primary_conversation_id == conversation_id \
                and work.title == CHAT_WORK_TITLE:
            return run
    return None


def default_chat_agent(store) -> Optional[str]:
    """La chat è con l'agente per default: primo agente attivo del workspace."""
    for agent in sorted(store.agents.values(), key=lambda a: a.created_at):
        if agent.status == "active":
            return agent.id
    return None


def handles(ctx, store, body) -> bool:
    """Il messaggio va all'agente invece che al solo interprete testuale.

    Conversazioni legate esplicitamente, oppure il default del workspace
    (primo agente attivo): la chat funziona come una chat con un agente.
    """
    if body.type != "conversation.post_message":
        return False
    conversation_id = str(body.payload.get("conversation_id") or "")
    if binding_for(ctx, conversation_id) is not None:
        return True
    return default_chat_agent(store) is not None


def _new_chat_work(ctx, actor: Actor, conversation_id: str, agent_id: str,
                   text: str) -> str:
    """Lavoro chat del turno: objective = il messaggio della persona."""
    import secrets as _secrets
    with ctx.repository.locked():
        with ctx.repository.transaction() as write_store:
            svc = ctx.service.for_store(write_store)
            work_id = svc.apply(actor, f"chat-work:{_secrets.token_hex(4)}",
                                "work.create", {
                                    "conversation_id": conversation_id,
                                    "title": CHAT_WORK_TITLE,
                                    "objective": text.strip()[:2000] or "Rispondi in chat.",
                                })["work_id"]
            version = write_store.works[work_id].version
            svc.apply(actor, f"chat-plan:{_secrets.token_hex(4)}",
                      "plan.propose", {
                          "work_id": work_id, "expected_version": version,
                          "steps": [{"title": "Chat", "assignee_id": agent_id,
                                     "capability": "agent_run"}]})
            version = write_store.works[work_id].version
            svc.apply(actor, f"chat-accept:{_secrets.token_hex(4)}",
                      "plan.accept", {"work_id": work_id, "expected_version": version})
        ctx.service.store = write_store
    return str(work_id)


def start_chat_turn(ctx, actor: Actor, conversation_id: str, text: str) -> Dict[str, Any]:
    """Avvia il run della risposta; il testo torna in chat quando completa."""
    from homun.application.agent_runs import propose
    entry = binding_for(ctx, conversation_id)
    store = ctx.repository.load()
    if entry is None:
        agent_id = default_chat_agent(store)
        if agent_id is None:
            raise ValidationError("Conversazione non legata a un agente")
        entry = bind(ctx, actor, conversation_id, agent_id)
    active = _active_chat_run(store, conversation_id)
    if active is not None:
        # un run è già in volo su questa chat: il messaggio lo steera
        from homun.application.agent_control import control_in_store
        work = store.works[active["work_id"]]
        control_in_store(ctx, store, actor, work.id, active["id"], {
            "command_id": f"chat-steer:{secrets.token_hex(6)}",
            "expected_version": work.version, "action": "steer", "text": text}, echo=False)
        return {"agent_run_id": active["id"], "steered": True}

    work_id = _new_chat_work(ctx, actor, conversation_id, entry["agent_id"], text)
    version = ctx.repository.load().works[work_id].version
    body = {
        "command_id": f"chat-run:{secrets.token_hex(6)}",
        "expected_version": version, "material_ids": [],
        "web_pages": True,
    }
    try:
        run = propose(ctx, actor, work_id, body)
    except ValidationError:
        # la ricerca web richiede run nativi: chat testuale senza, il resto invariato
        body.pop("web_pages")
        body["command_id"] = f"chat-run:{secrets.token_hex(6)}"
        run = propose(ctx, actor, work_id, body)
    # Chi scrive in chat ha già deciso: il run parte subito, timbrato.
    from homun.application.agent_runs import approve
    owner = Actor(id=actor.id, workspace_id=ctx.workspace_id,
                  display_name="Chat", kind="person")
    approve(ctx, owner, work_id, run["id"], {
        "command_id": f"chat-ap:{secrets.token_hex(6)}",
        "expected_version": run["expected_version"], "digest": run["digest"]})
    with ctx.repository.locked():
        with ctx.repository.transaction() as write_store:
            record = write_store.commands.get(run["id"])
            if record is not None:
                record.result["_approval_channel"] = "chat:person"
                record.result["_chat_conversation_id"] = conversation_id
        ctx.service.store = write_store
    return {"agent_run_id": run["id"], "steered": False}


def _final_answer(run: Dict[str, Any]) -> str:
    messages = run.get("_messages") or []
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "assistant" \
                and str(message.get("content") or "").strip():
            return str(message["content"]).strip()
    for observation in reversed(run.get("observations") or []):
        text = str((observation or {}).get("message") or "").strip()
        if text:
            return text
    return ""


def deliver_chat_answers(ctx) -> int:
    """Pump: le risposte dei run chat completati tornano in conversazione."""
    from homun.application.agent_runs import PROPOSAL_TYPE
    delivered = 0
    store = ctx.repository.load()
    for record in store.commands.values():
        if record.type != PROPOSAL_TYPE or not isinstance(record.result, dict):
            continue
        run = record.result
        if run.get("status") not in {"completed", "waiting_input"} or run.get("_chat_delivered"):
            continue
        conversation_id = run.get("_chat_conversation_id")
        if not conversation_id or binding_for(ctx, str(conversation_id)) is None:
            continue
        answer = _final_answer(run) or ("(run completato senza risposta testuale)")
        try:
            with ctx.repository.locked():
                with ctx.repository.transaction() as write_store:
                    ctx.service.for_store(write_store).append_engine_message(
                        actor=Actor(id="person_local", workspace_id=ctx.workspace_id,
                                    display_name="Homun"),
                        command_id=f"chat-answer:{run['id'][:16]}:{secrets.token_hex(3)}",
                        conversation_id=str(conversation_id),
                        author_id="homun_engine",
                        text=answer,
                        event_type="message.interpreted",
                        event_payload={"agent_run_id": run["id"], "chat": True})
                    target = write_store.commands.get(run["id"])
                    if target is not None:
                        target.result["_chat_delivered"] = True
                ctx.service.store = write_store
            delivered += 1
        except Exception:
            logger.warning("consegna risposta chat fallita per %s", run.get("id"), exc_info=True)
    return delivered
