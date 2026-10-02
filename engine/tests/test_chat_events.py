"""Eventi SSE della conversazione: parti run/tool/testo/messaggio."""
import pytest

from homun.application import chat_agent, chat_events
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
            id="agent_chat", workspace_id=ctx.workspace_id, name="ChatBot")
    yield ctx, actor, conv
    ctx.close()


def collect(ctx, actor, conv):
    """Il flusso si chiude da solo dopo qualche ciclo a vuoto (max_idle_cycles)."""
    events = []
    for chunk in chat_events.conversation_events(ctx, actor, conv, max_idle_cycles=2):
        for line in chunk.strip().split("\n"):
            if line.startswith("event: "):
                events.append(line[len("event: "):])
    return events


def test_open_counts_existing_messages_not_reamitted(setup):
    ctx, actor, conv = setup
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).append_engine_message(
            actor=actor, command_id="m1", conversation_id=conv,
            author_id="homun_engine", text="ciao")
    events = collect(ctx, actor, conv)
    assert events[0] == "open"
    assert "message" not in events
    assert events[-1] == "closed"


def test_new_message_while_streaming_arrives_as_part(setup):
    import threading
    ctx, actor, conv = setup

    def append_later():
        import time as _t
        _t.sleep(0.03)
        with ctx.repository.transaction() as store:
            ctx.service.for_store(store).append_engine_message(
                actor=actor, command_id="m2", conversation_id=conv,
                author_id="homun_engine", text="nuovo")

    threading.Thread(target=append_later).start()
    events = collect(ctx, actor, conv)
    assert "message" in events


def test_run_parts_tool_and_delta(setup):
    ctx, actor, conv = setup
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    outcome = chat_agent.start_chat_turn(ctx, actor, conv, "cerca le notizie")
    run_id = outcome["agent_run_id"]
    with ctx.repository.transaction() as store:
        run = store.commands[run_id].result
        run["observations"] = [{"tool": "web_search", "message": "ricerca",
                                "result": {"hits": 2}}]
        run["_messages"] = [
            {"role": "user", "content": "cerca"},
            {"role": "assistant", "content": "Sto cercando"},
        ]
    events = collect(ctx, actor, conv)
    assert "run_started" in events
    assert "tool_result" in events
    assert "text_delta" in events
    # completato nel frattempo: run_finished arriva una volta sola
    with ctx.repository.transaction() as store:
        store.commands[run_id].result["status"] = "completed"
    events2 = collect(ctx, actor, conv)
    assert events2.count("run_finished") == 1


def test_unauthorized_conversation_refused(setup):
    from homun.domain.models import Actor as A
    ctx, actor, conv = setup
    stranger = A(id="stranger", workspace_id="ws_altra", display_name="X")
    with pytest.raises(Exception):
        list(chat_events.conversation_events(ctx, stranger, conv, max_idle_cycles=1))


def test_text_delta_strips_orphan_think_reasoning(setup):
    """Il ragionamento (</think> orfano) non si streamma: solo la risposta."""
    import json
    ctx, actor, conv = setup
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    run_id = chat_agent.start_chat_turn(ctx, actor, conv, "chi sei")["agent_run_id"]
    with ctx.repository.transaction() as store:
        store.commands[run_id].result["_messages"] = [
            {"role": "user", "content": "chi sei"},
            {"role": "assistant",
             "content": 'The user asks "chi sei". No tools needed.</think>'
                        'Sono Homun, un assistente operativo.'},
        ]
    payloads = []
    for chunk in chat_events.conversation_events(ctx, actor, conv, max_idle_cycles=2):
        for line in chunk.strip().split("\n"):
            if line.startswith("data: ") and "delta" in line:
                payloads.append(json.loads(line[len("data: "):]))
    assert payloads, "nessun text_delta emesso"
    streamed = "".join(p["delta"] for p in payloads)
    assert streamed == "Sono Homun, un assistente operativo."
    assert "</think>" not in streamed


def test_text_delta_resets_when_tail_assistant_message_changes(setup):
    """Cambio del messaggio di coda (turni con tool): reset con testo intero,
    nella STESSA connessione (ogni connessione riparte dal stato vuoto)."""
    import json
    import threading
    import time as _t
    ctx, actor, conv = setup
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    run_id = chat_agent.start_chat_turn(ctx, actor, conv, "cerca")["agent_run_id"]
    with ctx.repository.transaction() as store:
        store.commands[run_id].result["_messages"] = [
            {"role": "user", "content": "cerca"},
            {"role": "assistant", "content": "Sto cercando i listini"},
        ]

    def replace_tail_later():
        _t.sleep(0.3)
        with ctx.repository.transaction() as store:
            store.commands[run_id].result["_messages"].append(
                {"role": "assistant", "content": "Ecco il risultato finale."})

    threading.Thread(target=replace_tail_later).start()
    deltas = []
    for chunk in chat_events.conversation_events(ctx, actor, conv, max_idle_cycles=2):
        for line in chunk.strip().split("\n"):
            if line.startswith("data: ") and "delta" in line:
                deltas.append(json.loads(line[len("data: "):]))
    reset = [d for d in deltas if d.get("reset") is True]
    assert reset and reset[0]["delta"] == "Ecco il risultato finale."
    # il delta di crescita normale resta quello del primo messaggio
    assert "Sto cercando i listini" in "".join(
        d["delta"] for d in deltas if not d.get("reset"))


def test_stream_state_splits_reasoning_from_visible(setup):
    """Il parziale in-flight si streamma diviso: ragionamento prima di </think>,
    risposta dopo — chiude la fase di pensiero come ChatGPT."""
    import json
    ctx, actor, conv = setup
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    run_id = chat_agent.start_chat_turn(ctx, actor, conv, "chi sei")["agent_run_id"]

    def set_partial(text, messages=None):
        with ctx.repository.transaction() as store:
            run = store.commands[run_id].result
            run["stream_partial"] = {"text": text}
            if messages is not None:
                run["_messages"] = messages

    def harvest():
        states = []
        for chunk in chat_events.conversation_events(ctx, actor, conv, max_idle_cycles=2):
            for line in chunk.strip().split("\n"):
                if line.startswith("data: ") and "reasoning" in line:
                    d = json.loads(line[len("data: "):])
                    states.append(d)
        return states

    # fase di pensiero: modello che usa think (storia con </think>)
    set_partial("L'utente chiede chi sono. Rispondo breve.",
                messages=[{"role": "assistant", "content": "pensiero </think>risposta"}])
    states = harvest()
    assert states, "nessuno stream_state emesso"
    assert states[-1]["reasoning"].startswith("L'utente chiede")
    assert states[-1]["text"] == ""

    # arriva la chiusura del pensiero e la risposta inizia
    set_partial("L'utente chiede chi sono. Rispondo breve.</think>Sono Homun,")
    states = harvest()
    assert states[-1]["reasoning"].startswith("L'utente")
    assert states[-1]["text"] == "Sono Homun,"

    # modello senza think: il parziale è già risposta che si vede viva
    set_partial("Ecco la risposta diretta.", messages=[])
    states = harvest()
    assert states[-1]["reasoning"] == ""
    assert states[-1]["text"] == "Ecco la risposta diretta."
