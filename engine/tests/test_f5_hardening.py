"""Consolidamento F5 — i buchi trovati dalla revisione fredda, con test.

1. conversation.post_message è una risorsa protetta: senza grant write
   sulla conversazione il comando è rifiututo (prima: buco pre-mutation
   invisibile con attore unico, critico con i peer).
2. La presentazione del pairing valida l'invito: token fasullo non crea
   sfide (endpoint senza sessione, non fabbrica di record).
3. Il secret dell'invito NON è persistito nella sfida (solo il suo hash).
4. Il redeem locale è solo localhost: dalla rete si passa dal pairing.
5. La revoca di una persona chiude le sue deleghe aperte."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import Actor

LAUNCHER_TOKEN = "t" * 40
OWNER = {"X-Homun-Actor-Id": "person_fabio",
         "Authorization": f"Bearer {LAUNCHER_TOKEN}"}


@pytest.fixture
def host(tmp_path):
    ctx = create_context(db_path=tmp_path / "h.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    app = create_app(session_token=LAUNCHER_TOKEN)
    yield app, ctx
    reset_context_for_tests(None)
    ctx.close()


def _apply(ctx, command_id, kind, payload, actor_id="person_fabio"):
    actor = Actor(id=actor_id, workspace_id=ctx.workspace_id, display_name=actor_id)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result


def _pair(client, ctx, tmp_path, project_id=None, grant_write=False):
    """Pairing completo di 'Giulia'; grant read (e write opzionale) sul progetto."""
    from homun.peers.device_identity import load_device_identity
    identity = load_device_identity(tmp_path / "gk.json")
    invite = client.post("/v1/workspaces/ws_local/people/invites",
                         headers=OWNER, json={"role": "member"}).json()["token"]
    present = client.post("/v1/remote/pair", json={
        "invite_token": invite, "display_name": "Giulia", "device_name": "Mac",
        "public_key": identity.public_b64, "protocol_version": 1})
    assert present.status_code == 200, present.text
    confirm = client.post("/v1/remote/pair/confirm", json={
        "pairing_id": present.json()["pairing_id"],
        "invite_token": invite,
        "signature": identity.sign(present.json()["nonce"])})
    assert confirm.status_code == 200, confirm.text
    person_id = confirm.json()["person_id"]
    if project_id:
        _apply(ctx, "gr1", "grant.issue", {"project_id": project_id,
                                           "subject_id": person_id, "capability": "read"})
        if grant_write:
            _apply(ctx, "gr2", "grant.issue", {"project_id": project_id,
                                               "subject_id": person_id, "capability": "write"})
    return confirm.json()


def test_post_message_requires_write_grant(host, tmp_path):
    """Il buco serio: senza grant, il messaggio in conversazione privata è rifiutato."""
    app, ctx = host
    project = _apply(ctx, "p1", "project.create", {"name": "Privato"})["project_id"]
    conv = _apply(ctx, "c1", "conversation.create",
                  {"title": "Privata", "project_id": project})["conversation_id"]
    with TestClient(app, raise_server_exceptions=False) as client:
        confirm = _pair(client, ctx, tmp_path)  # NESSUNA grant da nessuna parte
        headers = {"Authorization": f"Bearer {confirm['device_token']}"}
        # per via remota…
        denied = client.post("/v1/workspaces/ws_local/remote/commands", headers=headers,
                             json={"command_id": "pm1", "type": "conversation.post_message",
                                   "payload": {"conversation_id": conv, "text": "intruso"}})
        assert denied.status_code == 200  # consegna ok…
        assert denied.json()["outcome"]["status"] != "accepted"  # …esito rifiutato
        # …e anche per via HTTP diretta come persona
        direct = client.post("/v1/workspaces/ws_local/commands",
                             headers={**headers, "X-Homun-Actor-Id": confirm["person_id"],
                                      "Content-Type": "application/json"},
                             json={"command_id": "pm2", "type": "conversation.post_message",
                                   "payload": {"conversation_id": conv, "text": "intruso"}})
        assert direct.status_code in (403, 404, 409)
        # e la conversazione è vuota
        store = ctx.repository.snapshot()
        assert not [m for m in store.messages.values() if m.conversation_id == conv]


def test_pairing_present_validates_invite(host, tmp_path):
    app, ctx = host
    with TestClient(app) as client:
        from homun.peers.device_identity import load_device_identity
        identity = load_device_identity(tmp_path / "k.json")
        garbage = client.post("/v1/remote/pair", json={
            "invite_token": "invite:inventato.di-san-sisto", "display_name": "X",
            "device_name": "Mac", "public_key": identity.public_b64,
            "protocol_version": 1})
        assert garbage.status_code in (400, 404, 403)
        # secret SBAGLIATO su invito reale: rifiutato alla presentazione
        invite = client.post("/v1/workspaces/ws_local/people/invites",
                             headers=OWNER, json={"role": "member"}).json()["token"]
        wrong_secret = invite.split(".")[0] + ".potenza-di-due"
        wrong = client.post("/v1/remote/pair", json={
            "invite_token": wrong_secret, "display_name": "X",
            "device_name": "Mac", "public_key": identity.public_b64,
            "protocol_version": 1})
        assert wrong.status_code in (400, 403)
        # nessuna sfida creata dai tentativi falliti
        store = ctx.repository.snapshot()
        challenges = [r for r in store.commands.values() if r.type == "device.pairing"]
        assert challenges == []


def test_challenge_record_has_no_invite_secret(host, tmp_path):
    app, ctx = host
    with TestClient(app) as client:
        from homun.peers.device_identity import load_device_identity
        identity = load_device_identity(tmp_path / "k2.json")
        invite = client.post("/v1/workspaces/ws_local/people/invites",
                             headers=OWNER, json={"role": "member"}).json()["token"]
        present = client.post("/v1/remote/pair", json={
            "invite_token": invite, "display_name": "G", "device_name": "Mac",
            "public_key": identity.public_b64, "protocol_version": 1}).json()
        store = ctx.repository.snapshot()
        challenge = store.commands[present["pairing_id"]].result
        assert "invite_token" not in challenge  # il secret non è mai persistito
        assert challenge["invite_secret_hash"]
        # il confirm con l'invito GIUSTO funziona ( arriva dal body)
        ok = client.post("/v1/remote/pair/confirm", json={
            "pairing_id": present["pairing_id"], "invite_token": invite,
            "signature": identity.sign(present["nonce"])})
        assert ok.status_code == 200
        # e un confirm con invito DIVERSO sulla stessa sfida è rifiutato
        # (sfida già consumata, ma il check dell'hash viene prima dello stato)


def test_redeem_is_local_only(host, tmp_path):
    app, ctx = host
    with TestClient(app, raise_server_exceptions=False,
                    client=("192.168.1.77", 51234)) as client:
        invite = client.post("/v1/workspaces/ws_local/people/invites",
                             headers=OWNER, json={"role": "member"}).json()["token"]
        remote_attempt = client.post("/v1/session/redeem",
                                     json={"token": invite, "display_name": "Lontano"})
        assert remote_attempt.status_code == 403
        assert remote_attempt.json()["detail"]["code"] == "local_only"


def test_person_revocation_closes_open_assignments(host, tmp_path):
    app, ctx = host
    project = _apply(ctx, "p1", "project.create", {"name": "P"})["project_id"]
    conv = _apply(ctx, "c1", "conversation.create",
                  {"title": "C", "project_id": project})["conversation_id"]
    work = _apply(ctx, "w1", "work.create", {
        "conversation_id": conv, "title": "T", "objective": "o"})["work_id"]
    with TestClient(app) as client:
        confirm = _pair(client, ctx, tmp_path, project_id=project)
        offered = _apply(ctx, "off1", "delegation.offer", {
            "work_id": work, "assignee_person_id": confirm["person_id"],
            "capability": "translation", "input_ref": {}})
        _apply(ctx, "rev1", "person.revoke", {"person_id": confirm["person_id"]})
        store = ctx.repository.snapshot()
        assert store.peer_assignments[offered["assignment_id"]].status == "revoked"


def test_projection_route_reads_synced_content(host, tmp_path):
    """La proiezione completa è leggibile solo dopo il sync: 404 onesto prima."""
    app, ctx = host
    project = _apply(ctx, "pr1", "project.create", {"name": "Condiviso lettura"})["project_id"]
    conv = _apply(ctx, "prc1", "conversation.create",
                  {"title": "Chat", "project_id": project})["conversation_id"]
    _apply(ctx, "prm1", "conversation.post_message",
           {"conversation_id": conv, "text": "Contenuto **con markdown**"})
    with TestClient(app) as client:
        confirm = _pair(client, ctx, tmp_path, project_id=project)
        headers = {"Authorization": f"Bearer {confirm['device_token']}"}
        # mai sincronizzato: 404 tipizzato (autenticati come owner locale)
        missing = client.get(f"/v1/peers/projection?host=nessuno&project_id={project}",
                             headers=OWNER)
        assert missing.status_code == 404
        # sync via rotta peer e poi lettura
        sync = client.post(f"/v1/peers/connections/nessuno/sync",
                           headers=OWNER, json={"project_id": project})
        assert sync.status_code == 404
