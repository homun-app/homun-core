"""Channel messages bridge into supervised conversations instead of echoing."""
import json
import time

import pytest

from homun.application.channel_conversation_bridge import channel_reply
from homun.application.gateway_contracts import ChannelMessage
from homun.context import create_context, reset_context_for_tests


def _message(text, *, msg_id="m1", user_id="8205578468", username="fabio"):
    return ChannelMessage(
        id=msg_id,
        platform="telegram",
        channel_id=user_id,
        user_id=user_id,
        username=username,
        text=text,
        is_direct=True,
        timestamp=time.time(),
    )


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    yield ctx
    reset_context_for_tests(None)


def test_channel_message_runs_a_supervised_turn(ctx):
    reply = channel_reply(_message("Che tempo fa oggi?"))
    assert reply.strip()
    assert not reply.startswith("Echo from Homun")
    store = ctx.repository.load()
    assert len(store.messages) == 2
    authors = sorted(m.author_id for m in store.messages.values())
    assert authors == ["homun_engine", "person_telegram_8205578468"]


def test_second_message_reuses_the_bound_conversation(ctx):
    channel_reply(_message("prima domanda", msg_id="m1"))
    channel_reply(_message("seconda domanda", msg_id="m2"))
    bindings = json.loads((ctx.data_dir / "channel_conversations.json").read_text(encoding="utf-8"))
    assert len(bindings) == 1
    store = ctx.repository.load()
    conversations = {m.conversation_id for m in store.messages.values()}
    assert len(conversations) == 1
    assert len(store.messages) == 4


def test_provider_failure_surfaces_typed_code(ctx, monkeypatch):
    def unavailable(*args, **kwargs):
        raise RuntimeError("Provider offline")

    monkeypatch.setattr(ctx.models, "interpret", unavailable)
    reply = channel_reply(_message("ciao"))
    assert "provider_unavailable" in reply
    store = ctx.repository.load()
    assert len(store.messages) == 1  # user message committed, no assistant reply


def test_redelivered_update_returns_committed_reply(ctx):
    first = channel_reply(_message("dimmi qualcosa", msg_id="m1"))
    second = channel_reply(_message("dimmi qualcosa", msg_id="m1"))
    assert first == second
    assert len(ctx.repository.load().messages) == 2  # no duplicate turn


def test_command_in_progress_maps_to_typed_notice(ctx, monkeypatch):
    from homun.domain.errors import CommandInProgressError
    import homun.application.channel_conversation_bridge as bridge

    def busy(*args, **kwargs):
        raise CommandInProgressError("another turn is running")

    monkeypatch.setattr(bridge, "admit", busy)
    reply = channel_reply(_message("ciao"))
    assert "command_in_progress" in reply
