"""Chat con l'agente: la conversazione legata a un agente esegue run e risponde in chat."""
import pytest

from homun.application import chat_agent
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


def test_bind_and_handles(setup):
    ctx, actor, conv = setup
    # col default del workspace (primo agente attivo) la chat è già dell'agente
    assert chat_agent.handles(ctx, ctx.repository.load(), _post_body(conv)) is True
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    assert chat_agent.handles(ctx, ctx.repository.load(), _post_body(conv)) is True
    assert chat_agent.unbind(ctx, conv) is True
    with ctx.repository.transaction() as store:
        store.agents["agent_chat"].status = "retired"
    assert chat_agent.handles(ctx, ctx.repository.load(), _post_body(conv)) is False


def _post_body(conv):
    from homun.application.command_types import CommandRequest
    return CommandRequest(command_id="m1", type="conversation.post_message",
                          payload={"conversation_id": conv, "text": "ciao"})


def test_start_chat_turn_creates_approved_run(setup):
    ctx, actor, conv = setup
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    outcome = chat_agent.start_chat_turn(ctx, actor, conv, "Prepara l'indice del catalogo")
    assert outcome["steered"] is False
    run = ctx.repository.load().commands[outcome["agent_run_id"]].result
    assert run["status"] in {"queued", "running"}
    assert run["_approval_channel"] == "chat:person"
    assert run["_chat_conversation_id"] == conv
    work = ctx.repository.load().works[run["work_id"]]
    assert work.primary_conversation_id == conv
    assert "indice" in work.objective


def test_chat_run_budget_survives_long_research(setup):
    """Parity Hermes: il run chat muore sul limite di turni, mai sul volume
    delle osservazioni (una ricerca multi-pagina sfora i 64k di default)."""
    from homun.domain.capabilities import AGENT_RUN
    ctx, actor, conv = setup
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    outcome = chat_agent.start_chat_turn(ctx, actor, conv, "cerca e confronta")
    run = ctx.repository.load().commands[outcome["agent_run_id"]].result
    assert run["limits"]["max_observation_characters"] > 10 * AGENT_RUN.limits["max_observation_characters"]
    assert run["limits"]["max_turns"] == 24


def test_active_chat_run_is_detected_for_steering(setup):
    """Un secondo messaggio mentre il run è attivo trova il run da stestrare."""
    ctx, actor, conv = setup
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    first = chat_agent.start_chat_turn(ctx, actor, conv, "primo")
    store = ctx.repository.load()
    active = chat_agent._active_chat_run(store, conv)
    assert active is not None and active["id"] == first["agent_run_id"]
    # la corsa conclusa non è più attiva
    with ctx.repository.transaction() as write_store:
        write_store.commands[first["agent_run_id"]].result["status"] = "completed"
    assert chat_agent._active_chat_run(ctx.repository.load(), conv) is None


def test_deliver_chat_answers_appends_engine_message(setup):
    ctx, actor, conv = setup
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    outcome = chat_agent.start_chat_turn(ctx, actor, conv, "dimmi ciao")
    run_id = outcome["agent_run_id"]
    # simula la risposta finale del run
    with ctx.repository.transaction() as store:
        store.commands[run_id].result["status"] = "completed"
        store.commands[run_id].result["_messages"] = [
            {"role": "user", "content": "dimmi ciao"},
            {"role": "assistant", "content": "Ciao! Come posso aiutarti?"},
        ]
    delivered = chat_agent.deliver_chat_answers(ctx)
    assert delivered == 1
    store = ctx.repository.load()
    messages = [m for m in store.messages.values() if m.conversation_id == conv]
    answer = [m for m in messages if m.author_id == "homun_engine"]
    assert any("Ciao!" in m.text for m in answer)
    assert store.commands[run_id].result["_chat_delivered"] is True
    # idempotente: non riconsegna
    assert chat_agent.deliver_chat_answers(ctx) == 0


def test_failed_run_delivers_honest_error_note(setup):
    """Un run fallito non lascia la chat muta: arriva una nota con il codice."""
    ctx, actor, conv = setup
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    outcome = chat_agent.start_chat_turn(ctx, actor, conv, "x")
    with ctx.repository.transaction() as store:
        store.commands[outcome["agent_run_id"]].result["status"] = "failed"
        store.commands[outcome["agent_run_id"]].result["error_code"] = "agent_model_invalid_request"
    assert chat_agent.deliver_chat_answers(ctx) == 1
    store = ctx.repository.load()
    notes = [m for m in store.messages.values()
             if m.conversation_id == conv and m.author_id == "homun_engine"
             and "non è andata a buon fine" in m.text]
    assert notes and "agent_model_invalid_request" in notes[0].text


def test_default_agent_makes_every_chat_an_agent_chat(setup):
    """Senza binding esplicito, la chat usa la persona dedicata ('Homun') se c'è."""
    ctx, actor, conv = setup
    store = ctx.repository.load()
    # niente persona dedicata: cade sul primo agente attivo
    assert chat_agent.default_chat_agent(store) == "agent_chat"
    persona = chat_agent.ensure_chat_persona(ctx, actor)
    assert persona is not None
    assert chat_agent.default_chat_agent(ctx.repository.load()) == persona
    assert chat_agent.handles(ctx, store, _post_body(conv)) is True
    outcome = chat_agent.start_chat_turn(ctx, actor, conv, "ciao")
    run = ctx.repository.load().commands[outcome["agent_run_id"]].result
    # al primo messaggio il binding resta impresso (sulla persona dedicata)
    assert chat_agent.binding_for(ctx, conv)["agent_id"] == persona
    # run non nativo in unit test: la chat degrada senza ricerca, il resto invariato
    assert run["status"] in {"queued", "running"}


def test_no_agents_falls_back_to_interpretation(setup):
    """Zero agenti attivi: la chat resta testuale (nessuna regressione)."""
    ctx, actor, conv = setup
    with ctx.repository.transaction() as store:
        store.agents["agent_chat"].status = "retired"
    assert chat_agent.default_chat_agent(ctx.repository.load()) is None
    assert chat_agent.handles(ctx, ctx.repository.load(), _post_body(conv)) is False
