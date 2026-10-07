"""Un run orfano (lavoro cancellato, es. dopo un ripristino) non blocca la chat.

`route_message` instrada i messaggi verso il run attivo del lavoro: se un run
punta a un lavoro inesistente deve saltarlo, non far crashare il comando
(KeyError 500) né bloccare la conversazione per sempre.
"""
import secrets

import pytest

from homun.application import chat_agent
from homun.application.agent_chat_control import route_message
from homun.context import create_context
from homun.domain.models import Actor, AgentProfile


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / "ctx.db", data_dir=tmp_path, for_tests=True)
    actor = Actor(id="person_owner", workspace_id=ctx.workspace_id, display_name="Owner")
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        conv = svc.apply(actor, "conv", "conversation.create", {"title": "Chat"})["conversation_id"]
        store.agents["agent_chat"] = AgentProfile(
            id="agent_chat", workspace_id=ctx.workspace_id, name="ChatBot",
            autonomy_mode="supervised")
    yield ctx, actor, conv
    ctx.close()


def _orphan_run(store, actor_id: str, workspace_id: str) -> None:
    from homun.application.agent_runs import PROPOSAL_TYPE
    from homun.domain.models import CommandRecord
    run_id = f"chat-run:{secrets.token_hex(6)}"
    store.commands[run_id] = CommandRecord(
        command_id=run_id, type=PROPOSAL_TYPE, actor_id=actor_id,
        workspace_id=workspace_id,
        result={"id": run_id, "status": "running", "work_id": "work_scomparso",
                "_native": True, "_messages": [], "observations": []},
    )


def test_orphan_run_is_skipped_not_fatal(setup):
    ctx, actor, conv = setup
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    with ctx.repository.transaction() as write_store:
        _orphan_run(write_store, actor.id, ctx.workspace_id)
    store = ctx.repository.load()
    # un messaggio qualunque: il run orfano viene saltato, nessuna KeyError
    body = type("Body", (), {
        "command_id": "cmd-x", "type": "conversation.post_message",
        "payload": {"conversation_id": conv, "text": "ciao"},
    })()
    result: dict = {}
    assert route_message(ctx, store, actor, body, result) is False
