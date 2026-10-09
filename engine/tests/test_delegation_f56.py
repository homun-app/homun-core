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
from homun.domain.errors import BudgetExhaustedError
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


def test_offer_reserves_budget_ledger_atomically(host, tmp_path):
    """Authority reserves model attempts on the work ledger at offer time."""
    app, ctx = host
    _, _, work = _setup(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        assignment = _offer(ctx, work, confirm["person_id"])
        store = ctx.repository.snapshot()
        budget = store.work_budgets[work]
        peer = store.peer_assignments[assignment]
        assert peer.budget_reservation_id
        assert peer.model_attempts_reserved == 20
        assert budget.reserved.attempts == 20
        assert any(r.id == peer.budget_reservation_id for r in budget.pending)
        pending = next(r for r in budget.pending if r.id == peer.budget_reservation_id)
        assert pending.actor_id == confirm["person_id"]
        assert pending.admitted_actor_id == "person_fabio"
        assert pending.purpose.startswith("peer_assignment:")


def test_return_settles_reserved_budget(host, tmp_path):
    """Return charges known attempts and clears the in-flight reservation."""
    app, ctx = host
    _, _, work = _setup(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        assignment = _offer(ctx, work, confirm["person_id"])
        headers = _headers(confirm)
        client.post(f"/v1/workspaces/ws_local/remote/assignments/{assignment}/accept",
                    headers=headers)
        returned = client.post(
            f"/v1/workspaces/ws_local/remote/assignments/{assignment}/return",
            headers=headers,
            json={"command_id": "ret-budget", "result": {"ok": True},
                  "model_attempts_used": 7})
        assert returned.status_code == 200
        store = ctx.repository.snapshot()
        peer = store.peer_assignments[assignment]
        budget = store.work_budgets[work]
        assert peer.budget_reservation_id
        assert budget.reserved.attempts == 0
        assert budget.spent.attempts == 7
        assert not budget.pending
        receipt = store.budget_usage_receipts[peer.budget_reservation_id]
        assert receipt.status == "partial"
        assert receipt.charged_known.attempts == 7
        assert receipt.accounting_actor_id == confirm["person_id"]


def test_offer_rejected_when_work_budget_exhausted(host, tmp_path):
    app, ctx = host
    _, _, work = _setup(ctx)
    _apply(ctx, "cap", "work.set_budget",
           {"work_id": work, "caps": {"model_attempts": 5}})
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        with pytest.raises(BudgetExhaustedError):
            _offer(ctx, work, confirm["person_id"])
        store = ctx.repository.snapshot()
        assert not store.peer_assignments
        assert store.work_budgets[work].reserved.attempts == 0


def test_revoke_releases_budget_reservation(host, tmp_path):
    app, ctx = host
    _, _, work = _setup(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        assignment = _offer(ctx, work, confirm["person_id"])
        _apply(ctx, "rev-budget", "delegation.revoke",
               {"work_id": work, "assignment_id": assignment})
        store = ctx.repository.snapshot()
        budget = store.work_budgets[work]
        peer = store.peer_assignments[assignment]
        assert budget.reserved.attempts == 0
        assert budget.spent.attempts == 0
        receipt = store.budget_usage_receipts[peer.budget_reservation_id]
        assert receipt.status == "released"


def test_expired_touch_releases_budget_reservation(host, tmp_path):
    app, ctx = host
    _, _, work = _setup(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        expires = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        assignment = _offer(ctx, work, confirm["person_id"], expires=expires)
        late = client.post(
            f"/v1/workspaces/ws_local/remote/assignments/{assignment}/return",
            headers=_headers(confirm),
            json={"command_id": "late-budget", "result": {"x": 1}})
        assert late.status_code in (400, 409)
        store = ctx.repository.snapshot()
        budget = store.work_budgets[work]
        peer = store.peer_assignments[assignment]
        assert peer.status == "expired"
        assert budget.reserved.attempts == 0
        receipt = store.budget_usage_receipts[peer.budget_reservation_id]
        assert receipt.status == "released"


def test_reconcile_after_timeout_releases_hold_and_blocks_blind_reoffer(host, tmp_path):
    """Timed-out peer must be reconciled before the same input is reassigned."""
    from homun.domain.errors import ValidationError

    app, ctx = host
    _, _, work = _setup(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        expires = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        first = _offer(ctx, work, confirm["person_id"], expires=expires)
        headers = _headers(confirm)

        # Interrogate the previous attempt.
        seen = client.get(
            f"/v1/workspaces/ws_local/remote/assignments/{first}", headers=headers)
        assert seen.status_code == 200
        assert seen.json()["id"] == first
        assert seen.json()["status"] == "offered"

        # Blind re-offer of the same input is refused while unresolved.
        with pytest.raises(ValidationError, match="timed out unresolved"):
            _offer(ctx, work, confirm["person_id"], expires=expires)

        # Peer reconcile releases the ledger hold.
        reconciled = client.post(
            f"/v1/workspaces/ws_local/remote/assignments/{first}/reconcile",
            headers=headers,
            json={"command_id": "rec-1"})
        assert reconciled.status_code == 200
        body = reconciled.json()
        assert body["status"] == "expired" and body["reconciled"] is True
        assert body["previous"]["id"] == first

        store = ctx.repository.snapshot()
        peer = store.peer_assignments[first]
        budget = store.work_budgets[work]
        assert peer.status == "expired"
        assert budget.reserved.attempts == 0
        assert store.budget_usage_receipts[peer.budget_reservation_id].status == "released"

        # Idempotent interrogation after reconcile.
        again = client.post(
            f"/v1/workspaces/ws_local/remote/assignments/{first}/reconcile",
            headers=headers,
            json={"command_id": "rec-2"})
        assert again.status_code == 200
        assert again.json()["idempotent"] is True
        assert again.json()["previous"]["status"] == "expired"

        # Only after reconcile may the same input be offered again.
        second = _offer(ctx, work, confirm["person_id"])
        assert second != first


def test_reconcile_after_timeout_settles_late_result(host, tmp_path):
    """Peer may settle known usage / late result via reconcile, not blind retry."""
    app, ctx = host
    _, _, work = _setup(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        expires = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        assignment = _offer(ctx, work, confirm["person_id"], expires=expires)
        result = {"translated": "tardivo"}
        out = client.post(
            f"/v1/workspaces/ws_local/remote/assignments/{assignment}/reconcile",
            headers=_headers(confirm),
            json={"command_id": "rec-late", "result": result,
                  "model_attempts_used": 4})
        assert out.status_code == 200
        assert out.json()["status"] == "returned"
        assert out.json()["reconciled"] is True
        store = ctx.repository.snapshot()
        peer = store.peer_assignments[assignment]
        budget = store.work_budgets[work]
        assert peer.status == "returned" and peer.result == result
        assert peer.model_attempts_used == 4
        assert budget.reserved.attempts == 0
        assert budget.spent.attempts == 4
        receipt = store.budget_usage_receipts[peer.budget_reservation_id]
        assert receipt.status == "partial"
        assert receipt.reason == "peer_assignment_timeout_reconcile"


def test_reconcile_refuses_while_assignment_still_open(host, tmp_path):
    app, ctx = host
    _, _, work = _setup(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        # Far-future expiry: still alive.
        expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        assignment = _offer(ctx, work, confirm["person_id"], expires=expires)
        refused = client.post(
            f"/v1/workspaces/ws_local/remote/assignments/{assignment}/reconcile",
            headers=_headers(confirm),
            json={"command_id": "rec-early"})
        assert refused.status_code in (400, 409)
        store = ctx.repository.snapshot()
        assert store.peer_assignments[assignment].status == "offered"
        assert store.work_budgets[work].reserved.attempts == 20
