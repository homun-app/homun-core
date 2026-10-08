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

import pytest

from test_agent_runs import setup  # noqa: F401 — pytest fixture re-export

from homun.models.native_errors import NativeModelError, REPETITION
from homun.models.native_stream import NativeStream
from homun.models.repetition import is_runaway_repetition


def sse(value):
    return ("data: " + (value if isinstance(value, str) else json.dumps(value)) + "\n\n").encode()


def chunk(delta=None, reason=None):
    return {"choices": [{"index": 0, "delta": delta or {}, "finish_reason": reason}]}


# ---------------------------------------------------------------------------
# Gap 1 — live runaway guard during stream (not only after finish)
# ---------------------------------------------------------------------------

def test_p0_runaway_aborts_during_stream_before_finish():
    """Hermes checks is_runaway_repetition on raw content while streaming.

    Homun today only runs the guard in native_turn.parse_response after the
    provider stream has already finished assembling a complete message.
    """
    runaway = (
        "The model repeats this exact lengthy explanation without making any "
        "further progress.\n" * 30
    )
    assert is_runaway_repetition(runaway)

    stream = NativeStream()
    with pytest.raises(NativeModelError) as caught:
        for offset in range(0, len(runaway), 64):
            stream.feed(sse(chunk({"content": runaway[offset:offset + 64]})))
        # Desired: raised mid-feed. If feed silently accepts everything, the
        # gap is still open — force a failure rather than a false pass.
        raise AssertionError(
            "native stream accepted full runaway content without live guard"
        )

    assert caught.value.code == REPETITION
    assert caught.value.retryable is False


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


def test_p0_split_partial_promotes_untagged_provider_reasoning(setup_chat):
    """Models that think without <think> tags still fill the reasoning pane.

    When stream_partial carries a dedicated reasoning field (or scrubbed think
    text without tags), stream_state.reasoning must be non-empty — not dumped
    entirely into visible text.
    """
    import json as _json
    from homun.application import chat_agent, chat_events

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

def test_p0_stream_partial_keeps_commentary_tail_when_tools_arrive(setup, monkeypatch):
    """Hermes 167f0ef5fa: do not drop the last commentary tokens at tool-calls.

    Homun's agent_streaming.progress throttles writes to 4 Hz. Rapid content
    deltas immediately before tool_calls can leave stream_partial stuck on an
    earlier prefix, so the UI loses the tail when the tool round starts.
    """
    from homun.application.agent_runs import propose, approve
    from homun.application import agent_streaming
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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def setup_chat(tmp_path):
    from homun.application import chat_agent  # noqa: F401 — binding used by tests
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
