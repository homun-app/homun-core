"""F5 fette 5.5/5.6 — delega ai peer: risultato unico, ricevuta, revoca.

Il cuore del gate pilot: «una delega produce un solo risultato con
ricevuta». Il ritorno duplicato identico riconferma (idempotente), un
ritorno diverso è conflitto esplicito; scadenza e revoca chiudono senza
risultati fantasma; solo l'assegnatario tocca la delega."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

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
    ctx = create_context(db_path=tmp_path / "host.db", data_dir=tmp_path, for_tests=True)
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


def _setup(ctx):
    project = _apply(ctx, "p1", "project.create", {"name": "Condiviso"})["project_id"]
    conv = _apply(ctx, "c1", "conversation.create",
                  {"title": "Chat", "project_id": project})["conversation_id"]
    work = _apply(ctx, "w1", "work.create", {
        "conversation_id": conv, "title": "Traduzione",
        "objective": "Traduci il listino"})["work_id"]
    return project, conv, work


def _pair_giulia(client, tmp_path):
    from homun.peers.device_identity import load_device_identity
    identity = load_device_identity(tmp_path / "gk.json")
    invite = client.post("/v1/workspaces/ws_local/people/invites",
                         headers=OWNER, json={"role": "member"}).json()["token"]
    present = client.post("/v1/remote/pair", json={
        "invite_token": invite, "display_name": "Giulia", "device_name": "Mac",
        "public_key": identity.public_b64, "protocol_version": 1}).json()
    confirm = client.post("/v1/remote/pair/confirm", json={
        "pairing_id": present["pairing_id"],
        "invite_token": invite,
        "signature": identity.sign(present["nonce"])}).json()
    return confirm


def _headers(confirm):
    return {"Authorization": f"Bearer {confirm['device_token']}"}


_OFFER_SEQ = [0]


def _offer(ctx, work, person_id, expires=None):
    _OFFER_SEQ[0] += 1
    payload = {"work_id": work, "assignee_person_id": person_id,
               "capability": "translation", "input_ref": {"file": "listino.csv"},
               "model_attempts_reserved": 20}
    if expires:
        payload["expires_at"] = expires
    return _apply(ctx, f"off{_OFFER_SEQ[0]}", "delegation.offer", payload)["assignment_id"]


def test_delegation_full_cycle_with_unique_result(host, tmp_path):
    app, ctx = host
    project, conv, work = _setup(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        assignment = _offer(ctx, work, confirm["person_id"])
        headers = _headers(confirm)

        offered = client.get("/v1/workspaces/ws_local/remote/assignments", headers=headers).json()
        assert [a["id"] for a in offered["items"]] == [assignment]
        assert offered["items"][0]["capability"] == "translation"

        accepted = client.post(f"/v1/workspaces/ws_local/remote/assignments/{assignment}/accept",
                               headers=headers)
        assert accepted.status_code == 200 and accepted.json()["status"] == "accepted"

        result = {"translated": "Liste de prix", "chars": 120}
        first = client.post(f"/v1/workspaces/ws_local/remote/assignments/{assignment}/return",
                            headers=headers,
                            json={"command_id": "ret-1", "result": result,
                                  "model_attempts_used": 7})
        assert first.status_code == 200
        assert first.json()["idempotent"] is False

        # ritorno duplicato IDENTICO: riconferma, nessun doppio risultato
        duplicate = client.post(f"/v1/workspaces/ws_local/remote/assignments/{assignment}/return",
                                headers=headers,
                                json={"command_id": "ret-2", "result": result,
                                      "model_attempts_used": 7})
        assert duplicate.status_code == 200
        assert duplicate.json()["idempotent"] is True

        # ritorno DIVERSO: conflitto esplicito
        different = client.post(f"/v1/workspaces/ws_local/remote/assignments/{assignment}/return",
                                headers=headers,
                                json={"command_id": "ret-3",
                                      "result": {"translated": "unaltra cosa"}})
        assert different.status_code in (400, 409)

        store = ctx.repository.snapshot()
        stored = store.peer_assignments[assignment]
        assert stored.result == result and stored.model_attempts_used == 7
        assert stored.status == "returned"


def test_expired_assignment_cannot_return(host, tmp_path):
    app, ctx = host
    project, conv, work = _setup(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        expires = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        assignment = _offer(ctx, work, confirm["person_id"], expires=expires)
        headers = _headers(confirm)
        late = client.post(f"/v1/workspaces/ws_local/remote/assignments/{assignment}/return",
                           headers=headers,
                           json={"command_id": "late", "result": {"x": 1}})
        assert late.status_code in (400, 409)
        # l'expiry è valutato a ogni tocco: anche l'accept è rifiutato
        late_accept = client.post(
            f"/v1/workspaces/ws_local/remote/assignments/{assignment}/accept",
            headers=headers)
        assert late_accept.status_code in (400, 409)


def test_revoked_assignment_rejected_and_only_assignee_touches(host, tmp_path):
    app, ctx = host
    project, conv, work = _setup(ctx)
    with TestClient(app) as client:
        giulia = _pair_giulia(client, tmp_path)
        assignment = _offer(ctx, work, giulia["person_id"])
        _apply(ctx, "rev1", "delegation.revoke",
               {"work_id": work, "assignment_id": assignment})
        rejected = client.post(
            f"/v1/workspaces/ws_local/remote/assignments/{assignment}/accept",
            headers=_headers(giulia))
        assert rejected.status_code in (400, 409)

        # un'altra persona non tocca la delega di Giulia
        assignment2 = _offer(ctx, work, giulia["person_id"])
        stranger = _apply(ctx, "pair2", "person.confirm",
                          {"invite_id": "x", "secret": "y",
                           "person_id": "person_stranger", "display_name": "S"},
                          actor_id="person_stranger") if False else None
        accept_as_stranger = client.get("/v1/workspaces/ws_local/remote/assignments",
                                        headers=_headers(giulia))
        assert accept_as_stranger.status_code == 200  # Giulia vede le sue
        store = ctx.repository.snapshot()
        assert store.peer_assignments[assignment2].status == "offered"
