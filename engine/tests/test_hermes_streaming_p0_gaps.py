"""Hermes streaming P0 gap battery (parity vs Homun main).

Contracts from docs/research/evidence/2026-10-07-parity-rc35/RIASSUNTO-TEST.md
and the Hermes commits Homun tracks for porting:

1. b6aae42c3b — anti-loop runaway while streaming
2. 572446308e — inline think / reasoning channel → reasoning pane
3. 167f0ef5fa — commentary tail at tool-call boundary
4. a2a19bcc77 — clean-EOF vs transport drop as distinct failures

These tests encode the desired Homun behavior. They fail while the gaps remain
open; green means the corresponding P0 gap is closed.
"""
from __future__ import annotations

import json
from contextlib import contextmanager

import pytest

from test_agent_runs import setup  # noqa: F401 — pytest fixture re-export
from test_native_stream_transport import server as _server

from homun.models.native_errors import NativeModelError, REPETITION
from homun.models.native_stream import NativeStream
from homun.models.repetition import (
    MIN_FRAGMENT_LENGTH, STOP_PATH_MIN_CHARS, STREAM_TAIL_CHARS, RunawayStreamWatch,
    is_runaway_repetition,
)


def sse(value):
    return ("data: " + (value if isinstance(value, str) else json.dumps(value)) + "\n\n").encode()


def chunk(delta=None, reason=None):
    return {"choices": [{"index": 0, "delta": delta or {}, "finish_reason": reason}]}


_RUNAWAY_LINE = (
    "The model repeats this exact lengthy explanation without making any "
    "further progress.\n"
)


def runaway_text(total_chars):
    """One degenerate repetition loop of ``total_chars`` (whole repeated lines)."""
    text = _RUNAWAY_LINE * (total_chars // len(_RUNAWAY_LINE) + 1)
    return text[:total_chars]


# ---------------------------------------------------------------------------
# Gap 1 — live runaway guard during stream (not only after finish)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("total_chars", [
    pytest.param(len(_RUNAWAY_LINE) * 30, id="short-2.6k"),
    pytest.param(len(_RUNAWAY_LINE) * 280, id="long-24k"),
])
@pytest.mark.parametrize("field", ["content", "reasoning"])
def test_p0_runaway_aborts_during_stream_before_finish(field, total_chars):
    """Hermes checks is_runaway_repetition on raw content AND reasoning while
    streaming, first at the turn-end floor (MIN_FRAGMENT_LENGTH) and then at
    every doubling. A short local-model loop (~2.6k chars) is cut mid-stream,
    long before the reply could grow to stop-path scale. A hit closes the
    stream immediately with a typed, non-retryable REPETITION failure —
    never silently.
    """
    runaway = runaway_text(total_chars)
    assert is_runaway_repetition(runaway)

    stream = NativeStream()
    with pytest.raises(NativeModelError) as caught:
        for offset in range(0, len(runaway), 256):
            stream.feed(sse(chunk({field: runaway[offset:offset + 256]})))
        # Desired: raised mid-feed. If feed silently accepts everything, the
        # gap is still open — force a failure rather than a false pass.
        raise AssertionError(
            "native stream accepted full runaway content without live guard"
        )

    assert caught.value.code == REPETITION
    assert caught.value.retryable is False


@pytest.mark.parametrize("field", ["content", "reasoning"])
def test_p0_asked_floor_raises_both_channels_first_check_to_16k(field):
    """The turn's ``runaway_floor`` reaches BOTH live watches: an asked
    repetition of a few KB streams through content and reasoning untouched
    (the normal floor would have cut it at 400), and the stream finishes.
    """
    asked = "Ciao mondo!\n" * 200
    assert len(asked) < STOP_PATH_MIN_CHARS

    stream = NativeStream(runaway_floor=STOP_PATH_MIN_CHARS)
    for offset in range(0, len(asked), 64):
        stream.feed(sse(chunk({field: asked[offset:offset + 64]})))
    stream.feed(sse(chunk({}, "stop")))
    stream.feed(sse("[DONE]"))
    finished = stream.finish()

    assert finished["choices"][0]["message"]["content"] == (asked if field == "content" else "")


def _live_verdict(text, *, floor=MIN_FRAGMENT_LENGTH, chunk_chars=64):
    """Replay ``text`` through the live watch the way NativeStream feeds it."""
    watch = RunawayStreamWatch(min_chars=floor)
    for offset in range(0, len(text), chunk_chars):
        if watch.feed(text[offset:offset + chunk_chars]):
            return True
    return False


_SIMILAR_ROWS_TABLE = "\n".join(
    f"| Same heading and long shared explanatory prefix for each data row | {i} |"
    for i in range(60)
)
_NORMAL_LONG_TEXT = "\n".join(
    f"| {i:06d} | distinct status line kept for the live parity check |"
    for i in range(500)
)


@pytest.mark.parametrize("text", [
    pytest.param(_RUNAWAY_LINE * 30, id="short-loop-2.6k"),
    pytest.param(_RUNAWAY_LINE * 280, id="long-loop-24k"),
    pytest.param("Ciao mondo!\n" * 200, id="asked-repetition-2.4k"),
    pytest.param(_NORMAL_LONG_TEXT, id="normal-long-32k"),
    pytest.param(_SIMILAR_ROWS_TABLE, id="similar-rows-table"),
])
@pytest.mark.parametrize("mode,floor", [
    pytest.param("normal", MIN_FRAGMENT_LENGTH, id="normal-400"),
    pytest.param("asked", STOP_PATH_MIN_CHARS, id="asked-16k"),
])
def test_p0_live_watch_verdict_at_end_of_stream_matches_turn_end(text, mode, floor):
    """INVARIANT — the live watch and the turn-end check are ONE criterion,
    in BOTH modes. Whatever ``is_runaway_repetition`` says about the complete
    message at the turn's floor, the live watch must say the same by the time
    the stream ends: a reply the turn end would reject is cut as soon as the
    live cadence can prove it, and a reply the turn end would accept (asked
    repetition below 16k, long distinct text, tables with similar rows) is
    never cut live.
    """
    live = _live_verdict(text, floor=floor)
    turn_end = is_runaway_repetition(text, min_chars=floor)
    assert live == turn_end, (
        f"live verdict {live} != turn-end verdict {turn_end} "
        f"({mode} mode, {len(text)} chars)"
    )


def test_p0_live_watch_first_checks_at_turn_end_floor_then_doubles(monkeypatch):
    """Hermes b6aae42c3b CADENCE on the engine's own floor: the first
    evaluation runs at MIN_FRAGMENT_LENGTH — the same floor as the turn-end
    check, so the two guards are one criterion — the next each time the
    channel doubles, and the judged text never exceeds the bounded 64k tail
    (total work stays linear however long the reply grows).
    """
    import homun.models.repetition as repetition

    evaluated = []
    real = repetition.is_runaway_repetition

    def spy(text, **kwargs):
        evaluated.append(len(text))
        return real(text, **kwargs)

    monkeypatch.setattr(repetition, "is_runaway_repetition", spy)

    watch = repetition.RunawayStreamWatch()
    distinct = "\n".join(
        f"| {i:06d} | distinct status line kept for the live parity check |"
        for i in range(2_000)
    )
    # Feed past the doubling that exceeds the tail: the check observed at
    # 102,400 chars must judge only the last STREAM_TAIL_CHARS of them.
    for character in distinct[:102_400 + 1]:
        assert watch.feed(character) is False, "live watch cut distinct text"

    doublings = [MIN_FRAGMENT_LENGTH * 2 ** k for k in range(8)]  # 400 … 51,200
    assert evaluated[0] == MIN_FRAGMENT_LENGTH, (
        f"first live check at {evaluated[0]} chars, turn-end floor is "
        f"{MIN_FRAGMENT_LENGTH}"
    )
    assert evaluated == doublings + [STREAM_TAIL_CHARS], (
        f"live checks are not floor-then-doubling with a bounded tail: {evaluated}"
    )


def _streaming_chat_model(text, *, chunk_chars=256, deliver=False):
    """Replace the models port: drive the REAL NativeStream parser with the
    turn's ``runaway_floor`` (the kwarg the run loop computes from the ask),
    either expecting the live cut or delivering a terminal ``stop``.
    """
    from types import SimpleNamespace

    from homun.models.native_turn import NativeMessage

    def model(messages, *, stream=None, on_delta=None, **kwargs):
        assert stream is True
        assert kwargs.get("runaway_floor") is not None
        parser = NativeStream(on_delta=on_delta,
                              runaway_floor=kwargs["runaway_floor"])
        for offset in range(0, len(text), chunk_chars):
            parser.feed(sse(chunk({"content": text[offset:offset + chunk_chars]})))
        if deliver:
            parser.feed(sse(chunk({}, "stop")))
            parser.feed(sse("[DONE]"))
            return SimpleNamespace(
                message=NativeMessage(role="assistant", content=text),
                usage=None,
            )
        raise AssertionError("repetition stream was not cut live")

    return model


def _streamed_repetition_fails_turn_typed_and_visible(setup_chat, text, *, chunk_chars=256, ask="chi sei"):
    """Drive a chat turn whose model streams ``text`` through the real
    NativeStream parser: the live REPETITION cut must fail the run with the
    typed ``agent_model_repetition`` and deliver an engine notice to the
    conversation — never a silent cut.
    """
    from homun.application.agent import chat_agent
    from homun.application.agent.runs.run_execution import advance

    ctx, actor, conv = setup_chat
    ctx.models.set_active("openai_compatible")
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    run_id = chat_agent.start_chat_turn(ctx, actor, conv, ask)["agent_run_id"]

    ctx.models.complete_tools = _streaming_chat_model(text, chunk_chars=chunk_chars)
    assert advance(ctx, run_id) == "failed"

    run = ctx.repository.load().commands[run_id].result
    assert run["error_code"] == "agent_model_repetition"
    assert run.get("recovery") is None or run["recovery"].get("status") != "waiting"

    assert chat_agent.deliver_chat_answers(ctx) >= 1
    store = ctx.repository.load()
    notices = [m for m in store.messages.values()
               if m.conversation_id == conv
               and "agent_model_repetition" in (m.text or "")]
    assert notices, "no visible typed outcome in the conversation"


def test_p0_asked_for_repetition_is_delivered_to_the_conversation(setup_chat):
    """Repetition the user ASKED for (Hermes #121600 scale, a few KB) is
    DELIVERED whole: the ask raises the single criterion's floor to Hermes's
    stop-path scale (16k) for both guards, so the 200 asked lines (~2.4k
    chars) that the normal floor rejects now complete the turn and reach the
    conversation. Same text without the ask stays rejected (test below).
    """
    from homun.application.agent import chat_agent
    from homun.application.agent.runs.run_execution import advance

    ctx, actor, conv = setup_chat
    ctx.models.set_active("openai_compatible")
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    ask = 'Scrivi "Ciao mondo" 200 volte, una per riga'
    run_id = chat_agent.start_chat_turn(ctx, actor, conv, ask)["agent_run_id"]

    asked = "Ciao mondo!\n" * 200
    assert len(asked) < STOP_PATH_MIN_CHARS
    assert is_runaway_repetition(asked)  # the normal floor still rejects it

    ctx.models.complete_tools = _streaming_chat_model(asked, chunk_chars=64, deliver=True)
    assert advance(ctx, run_id) == "completed"

    assert chat_agent.deliver_chat_answers(ctx) >= 1
    store = ctx.repository.load()
    answers = [m for m in store.messages.values()
               if m.conversation_id == conv and (m.text or "").count("Ciao mondo!") == 200]
    assert answers, "the asked repetition was not delivered whole to the conversation"


def test_p0_asked_repetition_looping_past_16k_is_cut_typed_and_visible(setup_chat):
    """The raised floor is a CEILING, not immunity: in an asked turn a real
    loop that grows past Hermes's stop-path scale (16k chars) is still cut
    live with the typed ``agent_model_repetition`` and a visible notice.
    """
    _streamed_repetition_fails_turn_typed_and_visible(
        setup_chat, runaway_text(len(_RUNAWAY_LINE) * 280),
        chunk_chars=256, ask='Scrivi "Ciao mondo" 200 volte, una per riga')


def test_p0_runaway_cut_ends_turn_typed_and_visible(setup_chat):
    """The interrupted turn ends with a typed, visible outcome — never silent.

    The live REPETITION cut must fail the run with ``agent_model_repetition``
    and deliver an engine notice to the conversation.
    """
    _streamed_repetition_fails_turn_typed_and_visible(
        setup_chat, runaway_text(len(_RUNAWAY_LINE) * 280))


# ---------------------------------------------------------------------------
# Gap 2 — reasoning / think channel → live reasoning pane
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("field", ["reasoning", "reasoning_content", "thinking"])
def test_p0_reasoning_channel_deltas_surface_for_reasoning_pane(field):
    """Hermes scrubber feeds inline think / reasoning into the live pane.

    Homun NativeStream only accumulates delta.content. Provider reasoning
    fields (already recognized in non-stream openai_compat) must reach the
    stream progress payload so chat_events can put them in stream_state.reasoning.
    """
    events = []
    stream = NativeStream(on_delta=events.append)
    stream.feed(sse(chunk({field: "Plan: inspect the material first."})))
    stream.feed(sse(chunk({"content": "Done."}, "stop")))
    stream.feed(sse("[DONE]"))
    finished = stream.finish()

    assert finished["choices"][0]["message"]["content"] == "Done."
    # Desired parity: reasoning text is visible to on_delta (and thus stream_partial).
    surfaced = " ".join(
        str(event.get("reasoning") or event.get("text") or "") for event in events
    )
    assert "Plan: inspect the material first." in surfaced


def test_p0_inline_think_text_streams_to_reasoning_pane_not_answer(setup_chat):
    """Hermes 572446308e: il testo strippato dai blocchi <think> in content
    alimenta il pane del ragionamento live e non compare MAI nella risposta.

    I modelli che ragionano senza il canale nativo inline-ano <think>…</think>
    nel contenuto: lo split deve mandare il testo interno (senza markup) nel
    pane e tenere pulito il testo visibile, anche a metà risposta e con più
    blocchi.
    """
    import json as _json
    from homun.application.agent import chat_agent
    from homun.application.sessions import chat_events

    ctx, actor, conv = setup_chat
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    run_id = chat_agent.start_chat_turn(ctx, actor, conv, "chi sei")["agent_run_id"]

    def collect_states_and_deltas():
        states, deltas = [], []
        for chunk_sse in chat_events.conversation_events(ctx, actor, conv, max_idle_cycles=2):
            for line in chunk_sse.strip().split("\n"):
                if not line.startswith("data: "):
                    continue
                payload = _json.loads(line[len("data: "):])
                if "reasoning" in payload:
                    states.append(payload)
                if "delta" in payload:
                    deltas.append(payload)
        return states, deltas

    def set_partial(text):
        with ctx.repository.transaction() as store:
            store.commands[run_id].result["stream_partial"] = {"text": text}

    # 1. blocco aperto a inizio: il pane ragiona, la risposta è vuota
    set_partial("<think>Let me check the config first. ")
    states, deltas = collect_states_and_deltas()
    assert states, "nessuno stream_state per il blocco think aperto"
    assert "check the config" in states[-1]["reasoning"]
    assert "<think>" not in states[-1]["reasoning"]
    assert states[-1]["text"] == ""
    assert not deltas

    # 2. blocco chiuso + risposta che cresce
    set_partial("<think>Let me check the config first.</think>Sono Homun, ")
    states, deltas = collect_states_and_deltas()
    assert states[-1]["reasoning"] == "Let me check the config first."
    assert states[-1]["text"] == "Sono Homun, "

    # 3. secondo blocco a metà risposta, ancora aperto: mai nella risposta
    set_partial("<think>plan one</think>Sono Homun, un assistente<think>second thought")
    states, _ = collect_states_and_deltas()
    assert states[-1]["reasoning"].splitlines() == ["plan one", "second thought"]
    assert states[-1]["text"] == "Sono Homun, un assistente"

    # 4. risposta consegnata: il testo think non è mai nell'answer finale
    with ctx.repository.transaction() as store:
        run = store.commands[run_id].result
        run["stream_partial"] = {}
        run["_messages"] = [
            {"role": "user", "content": "chi sei"},
            {"role": "assistant",
             "content": "<think>plan one</think>Sono Homun."
                        "<think>trailing thought never closed"},
        ]
        run["status"] = "completed"
    _, deltas = collect_states_and_deltas()
    streamed_answer = "".join(d["delta"] for d in deltas)
    assert streamed_answer == "Sono Homun."
    assert "think" not in streamed_answer
    assert "trailing" not in streamed_answer


def test_p0_split_partial_promotes_untagged_provider_reasoning(setup_chat):
    """Models that think without <think> tags still fill the reasoning pane.

    When stream_partial carries a dedicated reasoning field (or scrubbed think
    text without tags), stream_state.reasoning must be non-empty — not dumped
    entirely into visible text.
    """
    import json as _json
    from homun.application.agent import chat_agent
    from homun.application.sessions import chat_events

    ctx, actor, conv = setup_chat
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    run_id = chat_agent.start_chat_turn(ctx, actor, conv, "chi sei")["agent_run_id"]

    with ctx.repository.transaction() as store:
        run = store.commands[run_id].result
        # Desired shape after the Hermes scrubber port: reasoning separated
        # even when the model never emitted <think> tags in content.
        run["stream_partial"] = {
            "text": "Sono Homun.",
            "reasoning": "The user asks who I am; answer briefly in Italian.",
        }

    states = []
    for chunk_sse in chat_events.conversation_events(ctx, actor, conv, max_idle_cycles=2):
        for line in chunk_sse.strip().split("\n"):
            if line.startswith("data: ") and "reasoning" in line:
                states.append(_json.loads(line[len("data: "):]))

    assert states, "expected stream_state with reasoning"
    assert "user asks who I am" in states[-1]["reasoning"]
    assert states[-1]["text"] == "Sono Homun."


# ---------------------------------------------------------------------------
# Gap 3 — commentary tail retained at tool-call boundary
# ---------------------------------------------------------------------------

def test_p0_commentary_tail_reaches_the_sse_stream_at_tool_boundary(setup_chat):
    """Verifica 167f0ef5fa sul nostro percorso: NON riproducibile, e il test
    lo dimostra.

    Il difetto di Hermes viveva nel verdetto ``already_streamed`` basato su
    prefisso del gateway interim (il prefisso parziale veniva scambiato per
    completo e il resend del testo pieno saltato). Il motore non ha alcun
    punto decisionale equivalente: ``stream_partial`` è solo la vista live e
    la risposta consegnata deriva sempre dal messaggio completo. Qui il
    prefisso troncato al confine tool-call viene esteso fino alla coda
    completa via text_delta — la coda arriva sempre al client.
    """
    import json as _json
    from homun.application.agent import chat_agent
    from homun.application.sessions import chat_events

    ctx, actor, conv = setup_chat
    chat_agent.bind(ctx, actor, conv, "agent_chat")
    run_id = chat_agent.start_chat_turn(ctx, actor, conv, "cerca")["agent_run_id"]

    full = "Checking the queue to pick it up."

    def collect_visible():
        """(ultimo stream_state.text, testo cumulato dai text_delta)."""
        live_text, delta_text = None, ""
        for chunk_sse in chat_events.conversation_events(ctx, actor, conv, max_idle_cycles=2):
            for line in chunk_sse.strip().split("\n"):
                if not line.startswith("data: "):
                    continue
                payload = _json.loads(line[len("data: "):])
                if "reasoning" in payload and "delta" not in payload:
                    live_text = payload.get("text")
                if "delta" in payload:
                    delta_text = payload["delta"] if payload.get("reset") \
                        else delta_text + payload["delta"]
        return live_text, delta_text

    # il confine tool-call congela il parziale su un prefisso troncato:
    # in live la vista arriva come stream_state.text
    with ctx.repository.transaction() as store:
        run = store.commands[run_id].result
        run["status"] = "running"
        run["stream_partial"] = {"text": full[:22]}  # "Checking the queue to "
    live_prefix, _ = collect_visible()

    # il turno completa: la risposta consegnata porta la coda per intero
    with ctx.repository.transaction() as store:
        run = store.commands[run_id].result
        run["stream_partial"] = {}
        run["_messages"] = [
            {"role": "user", "content": "cerca"},
            {"role": "assistant", "content": full},
        ]
        run["status"] = "completed"
    _, final_delta = collect_visible()

    assert live_prefix == full[:22]
    assert final_delta == full, (
        f"commentary tail lost at the tool-call boundary: {final_delta!r}"
    )


def test_p0_stream_partial_keeps_commentary_tail_when_tools_arrive(setup, monkeypatch):
    """Hermes 167f0ef5fa: do not drop the last commentary tokens at tool-calls.

    Homun's agent_streaming.progress throttles writes to 4 Hz. Rapid content
    deltas immediately before tool_calls can leave stream_partial stuck on an
    earlier prefix, so the UI loses the tail when the tool round starts.
    """
    from homun.application.agent.runs.runs import propose, approve
    from homun.application.agent.runs import streaming as agent_streaming
    from homun.models.native_turn import NativeMessage
    from types import SimpleNamespace

    ctx, actor, work, material = setup
    ctx.models.set_active("openai_compatible")
    run = propose(ctx, actor, work, {
        "command_id": "stream", "expected_version": 1,
        "material_ids": [material], "native_stream": True,
    })
    approve(ctx, actor, work, run["id"], {
        "command_id": "approve", "digest": run["digest"],
        "expected_version": run["expected_version"],
    })

    # Compress wall-clock so every progress event falls inside the 0.25s window
    # after the first — reproducing the tool-boundary race.
    clock = {"t": 1000.0}

    def fake_monotonic():
        return clock["t"]

    monkeypatch.setattr(agent_streaming, "monotonic", fake_monotonic)

    full = "I will read the config file now. Checking path."

    def model(*_a, **kw):
        assert kw.get("stream") is True
        on_delta = kw["on_delta"]
        # First progress accepted.
        on_delta({
            "type": "native_stream_progress", "chunks": 1,
            "text_chars": 16, "tool_calls": 0, "text": full[:16],
        })
        clock["t"] += 0.05
        # Tail + tool_calls within the throttle window — must still persist.
        on_delta({
            "type": "native_stream_progress", "chunks": 2,
            "text_chars": len(full), "tool_calls": 1, "text": full,
        })
        return SimpleNamespace(
            message=NativeMessage(
                role="assistant", content=full,
                tool_calls=[],  # no execution needed for this contract
            ),
            usage=None,
        )

    ctx.models.complete_tools = model
    # Drive only the streaming wrapper: build a running lease-shaped run dict.
    with ctx.repository.transaction() as store:
        stored = store.commands[run["id"]].result
        stored["status"] = "running"
        stored["_lease_token"] = "lease-p0"
        stored["_actor"] = actor.model_dump()
        stored["_run_version"] = store.works[work].version
        stored["_steering"] = []
        run_view = dict(stored)

    agent_streaming.complete(ctx, run_view, [])
    partial = ctx.repository.load().commands[run["id"]].result.get("stream_partial") or {}
    assert partial.get("text") == full, (
        f"commentary tail lost at tool boundary; stream_partial={partial!r}"
    )


# ---------------------------------------------------------------------------
# Gap 4 — clean-EOF vs transport drop are distinct typed failures
# ---------------------------------------------------------------------------

def test_p0_clean_eof_without_finish_reason_differs_from_transport_drop():
    """Hermes a2a19bcc77: [DONE] without finish_reason ≠ abrupt socket close.

    Homun maps both to agent_model_truncated today. Parity requires distinct
    typed codes (or an equivalent non-colliding classifier) so callers can
    choose continuation vs retry.
    """
    clean = NativeStream()
    with pytest.raises(NativeModelError) as clean_err:
        clean.feed(sse(chunk({"content": "partial answer"})))
        clean.feed(sse("[DONE]"))
        clean.finish()

    drop = NativeStream()
    with pytest.raises(NativeModelError) as drop_err:
        drop.feed(sse(chunk({"content": "partial answer"})))
        drop.finish()

    assert clean_err.value.code != drop_err.value.code, (
        f"clean-EOF and transport drop share code {clean_err.value.code!r}; "
        "Hermes distinguishes them"
    )


def test_p0_clean_eof_never_enters_the_network_retry_ladder():
    """La fine pulita è una classe a sé: codice proprio, mai ritentata, con
    un'etichetta che esclude esplicitamente l'errore di rete (#102766), e il
    marcatore diagnostico finish_reason_seen che resta falso."""
    from homun.models.native_errors import CLEAN_EOF, RETRYABLE_CODES, _LABELS

    assert CLEAN_EOF not in RETRYABLE_CODES
    assert "not a network error" in _LABELS[CLEAN_EOF]

    clean = NativeStream()
    with pytest.raises(NativeModelError) as caught:
        clean.feed(sse(chunk({"content": "partial answer"})))
        clean.feed(sse("[DONE]"))
    assert caught.value.code == CLEAN_EOF
    assert caught.value.retryable is False
    assert clean.finish_reason_seen is False

    completed = NativeStream()
    completed.feed(sse(chunk({"content": "answer"})))
    completed.feed(sse(chunk({}, "stop")))
    completed.feed(sse("[DONE]"))
    completed.finish()
    assert completed.finish_reason_seen is True


@contextmanager
def _dropping_server(parts):
    """Endpoint che promette più byte di quanti ne scrive: la connessione
    cade A METÀ corpo, senza chiusura pulita e senza [DONE]."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    body = b"".join(parts)
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body) + 1024))
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{http.server_port}", requests
    finally:
        http.shutdown()
        http.server_close()
        thread.join()


def test_p0_transport_drop_mid_stream_stays_typed_network(tmp_path, monkeypatch):
    """Una caduta di trasporto vera (corpo incompleto, eccezione) resta un
    errore tipizzato di rete secondo le regole attuali del motore: mai
    confusa con la fine pulita, mai replayata come se niente fosse (uno
    stream che ha consumato output non si ripete)."""
    from homun.models.registry import ModelRegistry
    from homun.models.secrets import MemorySecretStore
    from homun.models.native_turn import NativeMessage
    from homun.models.native_errors import NETWORK

    with _dropping_server([sse(chunk({"content": "partial"}))]) as (url, requests):
        registry = ModelRegistry(data_dir=tmp_path, secrets=MemorySecretStore())
        registry.upsert_connection(
            connection_id="openai_compatible", kind="openai_compatible",
            display_name="Fixture", model_id="fixture", base_url=url + "/v1")
        with pytest.raises(NativeModelError) as caught:
            registry.complete_tools([NativeMessage(role="user", content="go")],
                                    tools=[], stream=True)

    assert caught.value.code == NETWORK
    assert caught.value.retryable is False, (
        "current rule: a stream is never replayed after possibly consuming output"
    )
    assert caught.value.code != "agent_model_clean_eof"
    assert len(requests) == 1


def test_p0_clean_eof_fails_the_run_once_without_network_retry(setup_chat, tmp_path, monkeypatch):
    """A livello di turno: la fine pulita senza finish_reason chiude il run
    con l'esito tipizzato agent_model_clean_eof, senza schedulare alcun
    tentativo e senza una seconda chiamata al modello."""
    from homun.application.agent import chat_agent
    from homun.application.agent.runs.run_execution import advance

    ctx, actor, conv = setup_chat
    with _server([sse(chunk({"content": "partial answer"})), sse("[DONE]")]) as (url, requests):
        ctx.models.upsert_connection(
            connection_id="openai_compatible", kind="openai_compatible",
            display_name="Fixture", model_id="fixture", base_url=url + "/v1")
        ctx.models.set_active("openai_compatible")
        chat_agent.bind(ctx, actor, conv, "agent_chat")
        run_id = chat_agent.start_chat_turn(ctx, actor, conv, "chi sei")["agent_run_id"]

        assert advance(ctx, run_id) == "failed"
        assert len(requests) == 1, "a clean EOF must not be retried"

    run = ctx.repository.load().commands[run_id].result
    assert run["error_code"] == "agent_model_clean_eof"
    recovery = run.get("recovery") or {}
    assert recovery.get("status") != "waiting", (
        f"clean EOF scheduled a retry: {recovery!r}"
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def setup_chat(tmp_path):
    from homun.application.agent import chat_agent  # noqa: F401 — binding used by tests
    from homun.context import create_context
    from homun.domain.models import Actor, AgentProfile

    ctx = create_context(db_path=tmp_path / "ctx.db", data_dir=tmp_path, for_tests=True)
    actor = Actor(id="person_owner", workspace_id=ctx.workspace_id, display_name="Owner")
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        conv = svc.apply(actor, "conv", "conversation.create", {"title": "Chat"})[
            "conversation_id"
        ]
        store.agents["agent_chat"] = AgentProfile(
            id="agent_chat", workspace_id=ctx.workspace_id, name="ChatBot"
        )
    yield ctx, actor, conv
    ctx.close()
