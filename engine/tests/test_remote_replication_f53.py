"""F5 fetta 3 — replica selettiva in lettura tra due installazioni.

Lo scenario del gate pilot, in un processo: Fabio (host) con due progetti,
Giulia (peer, chiave propria) invitata e con grant di lettura SOLO sul
progetto condiviso. La sincronizzazione porta la proiezione read-only sul
suo lato; la revoca del grant interrompe lo stream con errore tipizzato;
il cursor riprende senza gap né duplicati dopo una pausa."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, get_context, reset_context_for_tests

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


def _apply_host(ctx, command_id, kind, payload):
    from homun.domain.models import Actor
    actor = Actor(id="person_fabio", workspace_id=ctx.workspace_id, display_name="Fabio")
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result


def _setup_host(ctx):
    shared = _apply_host(ctx, "p1", "project.create", {"name": "Condiviso"})["project_id"]
    private = _apply_host(ctx, "p2", "project.create", {"name": "Privato"})["project_id"]
    conv = _apply_host(ctx, "c1", "conversation.create",
                       {"title": "Chat condivisa", "project_id": shared})["conversation_id"]
    _apply_host(ctx, "m1", "conversation.post_message",
                {"conversation_id": conv, "text": "Primo messaggio del progetto"})
    return shared, private, conv


def _pair_giulia(client: TestClient, tmp_path):
    from homun.peers.device_identity import load_device_identity
    identity = load_device_identity(tmp_path / "giulia_key.json")
    invite = client.post("/v1/workspaces/ws_local/people/invites",
                         headers=OWNER, json={"role": "member"}).json()["token"]
    present = client.post("/v1/remote/pair", json={
        "invite_token": invite, "display_name": "Giulia",
        "device_name": "MacBook di Giulia", "public_key": identity.public_b64,
        "protocol_version": 1}).json()
    confirm = client.post("/v1/remote/pair/confirm", json={
        "pairing_id": present["pairing_id"],
        "signature": identity.sign(present["nonce"])}).json()
    assert confirm["person_id"]
    return confirm


def _grant(ctx, command_id, person_id, project_id):
    _apply_host(ctx, command_id, "grant.issue", {
        "project_id": project_id, "subject_id": person_id, "capability": "read"})


def _grant_id(ctx, person_id, project_id):
    store = ctx.repository.snapshot()
    for grant in store.grants.values():
        if grant.subject_id == person_id and grant.resource_id == project_id:
            return grant.id
    raise AssertionError("grant non trovato")


def test_peer_sees_only_shared_project_and_cursor_resumes(host, tmp_path):
    app, ctx = host
    shared, private, conv = _setup_host(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", confirm["person_id"], shared)
        headers = {"Authorization": f"Bearer {confirm['device_token']}"}

        denied = client.get(f"/v1/workspaces/ws_local/remote/snapshot?project_id={private}",
                            headers=headers)
        assert denied.status_code == 403

        snapshot = client.get(f"/v1/workspaces/ws_local/remote/snapshot?project_id={shared}",
                              headers=headers).json()
        assert snapshot["project"]["name"] == "Condiviso"
        assert snapshot["cursor"] > 0
        assert any(m["text"] == "Primo messaggio del progetto"
                   for c in snapshot["conversations"] for m in c["messages"])

        _apply_host(ctx, "m2", "conversation.post_message",
                    {"conversation_id": conv, "text": "Secondo messaggio"})
        page = client.get(f"/v1/workspaces/ws_local/remote/events"
                          f"?project_id={shared}&cursor={snapshot['cursor']}",
                          headers=headers).json()
        assert len(page["items"]) == 1  # solo il nuovo messaggio: niente gap né duplicati
        assert page["cursor"] > snapshot["cursor"]
        again = client.get(f"/v1/workspaces/ws_local/remote/events"
                           f"?project_id={shared}&cursor={page['cursor']}",
                           headers=headers).json()
        assert again["items"] == []


def test_revoked_grant_stops_the_stream(host, tmp_path):
    app, ctx = host
    shared, private, conv = _setup_host(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", confirm["person_id"], shared)
        headers = {"Authorization": f"Bearer {confirm['device_token']}"}
        ok = client.get(f"/v1/workspaces/ws_local/remote/snapshot?project_id={shared}",
                        headers=headers)
        assert ok.status_code == 200
        _apply_host(ctx, "g2", "grant.revoke",
                    {"grant_id": _grant_id(ctx, confirm["person_id"], shared)})
        stopped = client.get(f"/v1/workspaces/ws_local/remote/events"
                             f"?project_id={shared}&cursor=0", headers=headers)
        assert stopped.status_code == 403


def test_peer_side_projection_is_readonly_and_separate(host, tmp_path):
    app, ctx = host
    shared, private, conv = _setup_host(ctx)
    with TestClient(app) as client:
        confirm = _pair_giulia(client, tmp_path)
        _grant(ctx, "g1", confirm["person_id"], shared)

        from homun.peers.pairing_client import RemoteConnection
        import homun.peers.pairing_client as pc
        connection = RemoteConnection(
            host="http://testhost", workspace_id="ws_local",
            person_id=confirm["person_id"], device_id=confirm["device_id"],
            device_token=confirm["device_token"], key_fingerprint="sha256:x")

        import json as _json
        original_get = pc._get

        def fake_get(url, bearer, timeout=15.0):
            path = url.split("testhost", 1)[1]
            response = client.get(path, headers={"Authorization": f"Bearer {bearer}"})
            assert response.status_code == 200, response.text
            return _json.loads(response.content)

        pc._get = fake_get
        try:
            from homun.peers import sync_remote_project
            view = sync_remote_project(connection, tmp_path / "peer_proj.db", shared)
        finally:
            pc._get = original_get
        assert view["source"] == "remote-engine"
        assert view["snapshot"]["project"]["name"] == "Condiviso"
        assert view["cursor"] > 0
        assert "Privato" not in str(view)  # il privato non esiste sul lato peer
