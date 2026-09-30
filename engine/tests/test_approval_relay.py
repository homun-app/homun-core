"""Approval relay: binding persona↔canale, notifica gate, decisione A/R da remoto."""
import re

import pytest

from homun.application import approval_relay
from homun.application.gateway_contracts import ChannelMessage
from homun.context import create_context
from homun.domain.models import Actor

PHONE = "393331234567@s.whatsapp.net"
OTHER_PHONE = "393339998877@s.whatsapp.net"


def msg(text: str, user_id: str = PHONE, platform: str = "whatsapp") -> ChannelMessage:
    return ChannelMessage(id="m1", platform=platform, channel_id=user_id,
                          user_id=user_id, text=text)


@pytest.fixture
def setup(tmp_path):
    approval_relay.reset_for_tests()
    approval_relay.set_registry_provider(
        lambda: type("R", (), {"get_adapter": staticmethod(lambda p: object())})())
    ctx = create_context(db_path=tmp_path / "ctx.db", data_dir=tmp_path, for_tests=True)
    actor = Actor(id="person_owner", workspace_id=ctx.workspace_id, display_name="Owner")
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        conv = svc.apply(actor, "conv", "conversation.create", {"title": "Relay"})["conversation_id"]
        work = svc.apply(actor, "work", "work.create",
                         {"conversation_id": conv, "title": "Lavoro relay",
                          "objective": "Fare"})["work_id"]
    yield ctx, actor, work
    approval_relay.set_registry_provider(None)
    approval_relay.reset_for_tests()
    ctx.close()


def bind(ctx, actor, user_id: str = PHONE) -> None:
    """Enroll dal desktop + COLLEGA dal canale: il flusso reale, senza scorciatoie."""
    enroll = approval_relay.start_enroll(ctx, actor)
    reply = approval_relay.handle_inbound(ctx, msg(f"collega {enroll['code']}", user_id=user_id))
    assert reply and "collegato" in reply.lower()


def propose_run(ctx, actor, work) -> str:
    from homun.application.agent_runs import propose
    store = ctx.repository.load()
    return propose(ctx, actor, work, {
        "command_id": f"relay-run-{work[-6:]}", "expected_version": store.works[work].version,
        "material_ids": []})["id"]


def notify(ctx, monkeypatch) -> str:
    """Notifica con adapter finto: cattura il testo e restituisce il codice."""
    sent = []
    monkeypatch.setattr("homun.application.channel_delivery_recovery.send_with_media_dispatch",
                        lambda adapter, channel_id, text, **kw: sent.append(text) or
                        {"delivered": True, "intent_id": "del_test"})
    assert approval_relay.notify_pending(ctx) == 1
    text = sent[0]
    match = re.search(r"[AR] ([A-Z2-9]{6})", text)
    assert match, text
    return match.group(1)


def test_enroll_binds_channel_identity(setup):
    ctx, actor, work = setup
    assert approval_relay.bindings(ctx) == {}
    bind(ctx, actor)
    binding = approval_relay.bindings(ctx)["person_owner"]
    assert binding["platform"] == "whatsapp" and binding["user_id"] == PHONE


def test_expired_enroll_code_is_refused(setup):
    ctx, actor, work = setup
    enroll = approval_relay.start_enroll(ctx, actor)
    state = approval_relay._load(ctx)
    state["enroll"][enroll["code"]]["expires_at"] = "2020-01-01T00:00:00+00:00"
    reply = approval_relay.handle_inbound(ctx, msg(f"collega {enroll['code']}"))
    assert "scaduto" in reply
    assert approval_relay.bindings(ctx) == {}


def test_notify_sends_code_and_a_approves_run(setup, monkeypatch):
    ctx, actor, work = setup
    bind(ctx, actor)
    run_id = propose_run(ctx, actor, work)
    code = notify(ctx, monkeypatch)
    reply = approval_relay.handle_inbound(ctx, msg(f"a {code}"))
    assert "approvato" in reply.lower()
    run = ctx.repository.load().commands[run_id].result
    assert run["status"] == "queued"
    assert run["_approval_channel"] == "relay:whatsapp"


def test_r_cancels_the_run(setup, monkeypatch):
    ctx, actor, work = setup
    bind(ctx, actor)
    run_id = propose_run(ctx, actor, work)
    code = notify(ctx, monkeypatch)
    reply = approval_relay.handle_inbound(ctx, msg(f"r {code}"))
    assert "annullato" in reply.lower()
    assert ctx.repository.load().commands[run_id].result["status"] == "cancelled"


def test_unbound_identity_cannot_decide(setup, monkeypatch):
    ctx, actor, work = setup
    bind(ctx, actor)
    propose_run(ctx, actor, work)
    code = notify(ctx, monkeypatch)
    reply = approval_relay.handle_inbound(ctx, msg(f"a {code}", user_id=OTHER_PHONE))
    assert "non è collegato" in reply


def test_code_is_single_use(setup, monkeypatch):
    ctx, actor, work = setup
    bind(ctx, actor)
    run_id = propose_run(ctx, actor, work)
    code = notify(ctx, monkeypatch)
    approval_relay.handle_inbound(ctx, msg(f"a {code}"))
    again = approval_relay.handle_inbound(ctx, msg(f"a {code}"))
    assert "sconosciuto" in again


def test_notify_only_fires_once_per_gate(setup, monkeypatch):
    ctx, actor, work = setup
    bind(ctx, actor)
    propose_run(ctx, actor, work)
    sent = []
    monkeypatch.setattr("homun.application.channel_delivery_recovery.send_with_media_dispatch",
                        lambda adapter, channel_id, text, **kw: sent.append(text) or
                        {"delivered": True, "intent_id": "del_test"})
    assert approval_relay.notify_pending(ctx) == 1
    assert approval_relay.notify_pending(ctx) == 0
    assert len(sent) == 1


def test_gates_without_binding_are_not_notified(setup, monkeypatch):
    ctx, actor, work = setup
    propose_run(ctx, actor, work)
    monkeypatch.setattr("homun.application.channel_delivery_recovery.send_with_media_dispatch",
                        lambda *a, **kw: {"delivered": True, "intent_id": "x"})
    assert approval_relay.notify_pending(ctx) == 0


def test_normal_conversation_text_is_not_claimed(setup):
    ctx, actor, work = setup
    bind(ctx, actor)
    assert approval_relay.handle_inbound(ctx, msg("Ciao, come va il catalogo?")) is None
    assert approval_relay.handle_inbound(ctx, msg("a")) is None
