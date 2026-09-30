"""Approval relay: binding persona↔canale, notifica gate, decisione A/R da remoto."""
import re

import pytest

from homun.application import approval_relay
from homun.application.gateway_contracts import ChannelMessage
from homun.context import create_context
from homun.domain.models import Actor

PHONE = "393331234567@s.whatsapp.net"
OTHER_PHONE = "393339998877@s.whatsapp.net"

_propose_count = 0


def msg(text: str, user_id: str = PHONE, platform: str = "whatsapp",
        reply_to_id: str | None = None) -> ChannelMessage:
    return ChannelMessage(id="m1", platform=platform, channel_id=user_id,
                          user_id=user_id, text=text, reply_to_id=reply_to_id)


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


def new_work(ctx, actor, title: str) -> str:
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        conv = svc.apply(actor, f"conv-{title}", "conversation.create",
                         {"title": title})["conversation_id"]
        return svc.apply(actor, f"work-{title}", "work.create",
                         {"conversation_id": conv, "title": title,
                          "objective": "Fare"})["work_id"]


def propose_run(ctx, actor, work) -> str:
    global _propose_count
    from homun.application.agent_runs import propose
    _propose_count += 1
    store = ctx.repository.load()
    return propose(ctx, actor, work, {
        "command_id": f"relay-run-{work[-6:]}-{_propose_count}",
        "expected_version": store.works[work].version,
        "material_ids": []})["id"]


def notify(ctx, monkeypatch, message_id: str | None = None) -> str:
    """Notifica con adapter finto: cattura il testo e restituisce il codice."""
    sent = []
    monkeypatch.setattr(
        "homun.application.channel_delivery_recovery.send_with_media_dispatch",
        lambda adapter, channel_id, text, **kw: sent.append(text) or
        {"delivered": True, "intent_id": "del_test", "provider_message_id": message_id})
    assert approval_relay.notify_pending(ctx) == 1
    match = re.search(r"[AR] ([A-Z2-9]{6})", sent[0])
    assert match, sent[0]
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


def test_unbound_identity_is_not_claimed(setup, monkeypatch):
    """Il canale sconosciuto non è nemmeno preso in carico: resta conversazione."""
    ctx, actor, work = setup
    bind(ctx, actor)
    propose_run(ctx, actor, work)
    code = notify(ctx, monkeypatch)
    assert approval_relay.handle_inbound(ctx, msg(f"a {code}", user_id=OTHER_PHONE)) is None


def test_code_is_single_use(setup, monkeypatch):
    ctx, actor, work = setup
    bind(ctx, actor)
    propose_run(ctx, actor, work)
    code = notify(ctx, monkeypatch)
    approval_relay.handle_inbound(ctx, msg(f"a {code}"))
    again = approval_relay.handle_inbound(ctx, msg(f"a {code}"))
    assert "nessuna richiesta" in again.lower()


def test_notify_only_fires_once_per_gate(setup, monkeypatch):
    ctx, actor, work = setup
    bind(ctx, actor)
    propose_run(ctx, actor, work)
    sent = []
    monkeypatch.setattr(
        "homun.application.channel_delivery_recovery.send_with_media_dispatch",
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


def test_bare_word_decides_single_pending_gate(setup, monkeypatch):
    """Il caso comune: una sola richiesta → basta rispondere A, senza codice."""
    ctx, actor, work = setup
    bind(ctx, actor)
    run_id = propose_run(ctx, actor, work)
    notify(ctx, monkeypatch)
    reply = approval_relay.handle_inbound(ctx, msg("ok"))
    assert "approvato" in reply.lower()
    assert ctx.repository.load().commands[run_id].result["status"] == "queued"


def test_italian_reject_word_cancels(setup, monkeypatch):
    ctx, actor, work = setup
    bind(ctx, actor)
    run_id = propose_run(ctx, actor, work)
    notify(ctx, monkeypatch)
    reply = approval_relay.handle_inbound(ctx, msg("rifiuta"))
    assert "annullato" in reply.lower()
    assert ctx.repository.load().commands[run_id].result["status"] == "cancelled"


def test_reply_to_notification_decides_that_gate(setup, monkeypatch):
    """Più richieste in coda: la risposta citata identifica il gate giusto."""
    ctx, actor, work = setup
    bind(ctx, actor)
    work2 = new_work(ctx, actor, "Secondo")
    run1 = propose_run(ctx, actor, work)
    notify(ctx, monkeypatch)
    run2 = propose_run(ctx, actor, work2)
    code2 = notify(ctx, monkeypatch, message_id="wamid.SECONDA")
    state = approval_relay._load(ctx)
    assert state["msg_gates"]["wamid.SECONDA"] == code2
    reply = approval_relay.handle_inbound(ctx, msg("A", reply_to_id="wamid.SECONDA"))
    assert "approvato" in reply.lower()
    runs = ctx.repository.load().commands
    assert runs[run2].result["status"] == "queued"
    assert runs[run1].result["status"] == "pending_approval"


def test_multiple_pending_without_hint_asks_for_code(setup, monkeypatch):
    ctx, actor, work = setup
    bind(ctx, actor)
    work2 = new_work(ctx, actor, "Terzo")
    propose_run(ctx, actor, work)
    notify(ctx, monkeypatch)
    propose_run(ctx, actor, work2)
    notify(ctx, monkeypatch)
    reply = approval_relay.handle_inbound(ctx, msg("a"))
    assert "più richieste" in reply
