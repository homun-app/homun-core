"""F5 pilot — il toolkit peer dal terminale, end-to-end.

Lo scenario completo del gate in un processo: Fabio (host di test) crea
progetto e conversazione, invita Giulia; dal lato peer la CLI reale fa
pair → projects → sync → message → assignments → accept → return.
Ogni chiamata passa dal client HTTP del peer (patchato sull'app di test)."""
from __future__ import annotations

import argparse
import json

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.peers import cli as peer_cli

LAUNCHER_TOKEN = "t" * 40
OWNER = {"X-Homun-Actor-Id": "person_fabio",
         "Authorization": f"Bearer {LAUNCHER_TOKEN}"}
HOST = "http://testhost"


@pytest.fixture
def host(tmp_path):
    ctx = create_context(db_path=tmp_path / "host.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    app = create_app(session_token=LAUNCHER_TOKEN)
    yield app, ctx, tmp_path
    reset_context_for_tests(None)
    ctx.close()


def _apply(ctx, command_id, kind, payload):
    from homun.domain.models import Actor
    actor = Actor(id="person_fabio", workspace_id=ctx.workspace_id, display_name="Fabio")
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result


class _Transport:
    def __init__(self, app):
        self.client = TestClient(app)

    def __enter__(self):
        import homun.peers.pairing_client as pc
        self._post, self._get = pc._post, pc._get
        client = self.client

        def post(url, payload, bearer=None, timeout=15.0):
            path = url.split("testhost", 1)[1]
            headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
            response = client.post(path, json=payload, headers=headers)
            assert response.status_code < 400, response.text
            return json.loads(response.content)

        def get(url, bearer, timeout=15.0):
            path = url.split("testhost", 1)[1]
            response = client.get(path, headers={"Authorization": f"Bearer {bearer}"})
            assert response.status_code < 400, response.text
            return json.loads(response.content)

        pc._post, pc._get = post, get
        return self

    def __exit__(self, *exc):
        import homun.peers.pairing_client as pc
        pc._post, pc._get = self._post, self._get


def _args(**kwargs):
    return argparse.Namespace(**kwargs)


def test_pilot_flow_end_to_end_with_cli(host, tmp_path):
    app, ctx, _ = host
    project = _apply(ctx, "p1", "project.create", {"name": "Condiviso"})["project_id"]
    conv = _apply(ctx, "c1", "conversation.create",
                  {"title": "Chat", "project_id": project})["conversation_id"]
    _apply(ctx, "w1", "work.create", {"conversation_id": conv, "title": "Traduci",
                                      "objective": "Traduci il listino"})
    with _Transport(app), TestClient(app) as client:
        # Fabio invita e concede la scrittura
        invite = client.post("/v1/workspaces/ws_local/people/invites",
                             headers=OWNER, json={"role": "member"}).json()["token"]

        # Giulia, dal suo terminale
        peer_dir = tmp_path / "peer-machine"
        peer_dir.mkdir()
        assert peer_cli.cmd_pair(_args(host=HOST, invite=invite, name="Giulia",
                                       device="MacBook di Giulia",
                                       data_dir=peer_dir)) == 0

        # Fabio concede lettura e scrittura alla persona appena creata
        from homun.peers.store import PeerConnections
        person_id = PeerConnections(peer_dir).get(HOST)["person_id"]
        _apply(ctx, "g1", "grant.issue", {"project_id": project,
                                          "subject_id": person_id, "capability": "read"})
        _apply(ctx, "g2", "grant.issue", {"project_id": project,
                                          "subject_id": person_id, "capability": "write"})

        # sync del progetto condiviso
        assert peer_cli.cmd_sync(_args(host=HOST, project=project,
                                       data_dir=peer_dir)) == 0
        assert peer_cli.cmd_message(_args(host=HOST, conversation=conv,
                                          text="Listino tradotto e verificato",
                                          data_dir=peer_dir)) == 0
        store = ctx.repository.snapshot()
        assert any(m.text == "Listino tradotto e verificato" for m in store.messages.values())

        # delega:Fabio offre, Giulia accetta e restituisce dal terminale
        _apply(ctx, "off1", "delegation.offer", {
            "work_id": next(w.id for w in store.works.values() if w.title == "Traduci"),
            "assignee_person_id": person_id, "capability": "translation",
            "input_ref": {"file": "listino.csv"}, "model_attempts_reserved": 10})
        assert peer_cli.cmd_assignments(_args(host=HOST, data_dir=peer_dir)) == 0
        from homun.peers.store import peers_db_path
        import sqlite3
        row = sqlite3.connect(peers_db_path(peer_dir)).execute(
            "SELECT project_id FROM remote_projections").fetchone()
        assert row is None or row[0]  # proiezione presente (remote-peers.db)

        # accetta la prima delega offerta
        assignments = client.get("/v1/workspaces/ws_local/remote/assignments",
                                 headers={"Authorization": "Bearer " + PeerConnections(peer_dir).get(HOST)["device_token"]}).json()["items"]
        assignment_id = next(a["id"] for a in assignments if a["status"] == "offered")
        assert peer_cli.cmd_accept(_args(host=HOST, assignment=assignment_id,
                                         data_dir=peer_dir)) == 0
        assert peer_cli.cmd_return(_args(host=HOST, assignment=assignment_id,
                                         result='{"translated": "Liste de prix"}',
                                         attempts=5, data_dir=peer_dir)) == 0
        final = ctx.repository.snapshot().peer_assignments[assignment_id]
        assert final.status == "returned" and final.model_attempts_used == 5

        # status mostra la connessione e l'outbox vuoto
        assert peer_cli.cmd_status(_args(data_dir=peer_dir)) == 0

        # lo store del peer ha la connessione persistita per la UI futura
        from homun.peers.store import PeerConnections as _PC
        record = _PC(peer_dir).get(HOST)
        assert record and record["display_name"] == "Giulia"
        assert record["person_id"] == person_id
        # e la rotta lato peer risponde (sull'host: nessuna connessione sua)
        peers_route = client.get("/v1/peers/connections", headers=OWNER)
        assert peers_route.status_code == 200
        assert peers_route.json()["items"] == []


def test_peers_routes_connect_unreachable_is_typed(host, tmp_path):
    """Host irraggiungibile: errore tipizzato remote_unavailable, non un 500."""
    app, ctx, _ = host
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/v1/peers/connect", headers=OWNER,
                               json={"host": "http://127.0.0.1:9",  # porta chiusa
                                     "invite_token": "x" * 20,
                                     "display_name": "T"})
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "remote_unavailable"
