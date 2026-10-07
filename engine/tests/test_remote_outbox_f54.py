"""F5 fetta 4 — contributi remoti e outbox onesto.

Contratto: comando duplicato senza doppio effetto; conflitto di versione
esplicito al peer (consegnato sì, accettato no); host assente = tutto
resta pending in ordine, mai «salvato»; alla riconnessione la coda si
svuota in ordine; perimetro dei tipi di comando ammessi da remoto."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.peers.outbox import RemoteOutbox
from homun.peers.pairing_client import RemoteConnection

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


def _setup(ctx):
    project = _apply_host(ctx, "p1", "project.create", {"name": "Condiviso"})["project_id"]
    conv = _apply_host(ctx, "c1", "conversation.create",
                       {"title": "Chat", "project_id": project})["conversation_id"]
    return project, conv


def _pair_and_grant(client: TestClient, ctx, tmp_path, project_id) -> RemoteConnection:
    from homun.peers.device_identity import load_device_identity
    identity = load_device_identity(tmp_path / "g_key.json")
    invite = client.post("/v1/workspaces/ws_local/people/invites",
                         headers=OWNER, json={"role": "member"}).json()["token"]
    present = client.post("/v1/remote/pair", json={
        "invite_token": invite, "display_name": "Giulia", "device_name": "Mac",
        "public_key": identity.public_b64, "protocol_version": 1}).json()
    confirm = client.post("/v1/remote/pair/confirm", json={
        "pairing_id": present["pairing_id"],
        "signature": identity.sign(present["nonce"])}).json()
    _apply_host(ctx, "g1", "grant.issue", {
        "project_id": project_id, "subject_id": confirm["person_id"], "capability": "write"})
    return RemoteConnection(
        host="http://testhost", workspace_id="ws_local",
        person_id=confirm["person_id"], device_id=confirm["device_id"],
        device_token=confirm["device_token"], key_fingerprint="sha256:x")


class _Adapter:
    """Instrada remote_request sull'app di test; `up=False` simula host assente."""

    def __init__(self, app):
        self.client = TestClient(app)
        self.up = True

    def __enter__(self):
        import homun.peers.pairing_client as pc
        self._orig_post = pc._post
        adapter = self

        def post(url, payload, bearer=None, timeout=15.0):
            if not adapter.up:
                raise ConnectionError("host irraggiungibile")
            path = url.split("testhost", 1)[1]
            headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
            response = adapter.client.post(path, json=payload, headers=headers)
            import json as _json
            if response.status_code >= 400:
                raise RuntimeError(f"HTTP {response.status_code}: {response.text}")
            return _json.loads(response.content)

        pc._post = post
        return self

    def __exit__(self, *exc):
        import homun.peers.pairing_client as pc
        pc._post = self._orig_post


def test_outbox_honest_when_host_down_and_ordered_flush(host, tmp_path):
    app, ctx = host
    project, conv = _setup(ctx)
    with _Adapter(app) as adapter:
        connection = _pair_and_grant(adapter.client, ctx, tmp_path, project)
        outbox = RemoteOutbox(tmp_path / "peer_outbox.db")
        adapter.up = False  # host assente: niente consegna
        outbox.enqueue(host=connection.host, command_id="peer-m1",
                       type_="conversation.post_message",
                       payload={"conversation_id": conv, "text": "Primo da remoto"})
        outbox.enqueue(host=connection.host, command_id="peer-m2",
                       type_="conversation.post_message",
                       payload={"conversation_id": conv, "text": "Secondo da remoto"})
        result = outbox.flush(connection)
        assert result == {"delivered": 0, "conflicts": 0, "pending": 2}  # onesto
        assert [e["status"] for e in outbox.pending()] == ["pending", "pending"]

        adapter.up = True
        result = outbox.flush(connection)
        assert result["delivered"] == 2 and result["pending"] == 0
        # doppio flush: deduplica per command_id, nessun doppio effetto
        again = outbox.flush(connection)
        assert again["pending"] == 0
        store = ctx.repository.snapshot()
        texts = [m.text for m in store.messages.values() if "da remoto" in m.text]
        assert texts == ["Primo da remoto", "Secondo da remoto"]  # ordine e unicità


def test_version_conflict_is_delivered_not_accepted(host, tmp_path):
    app, ctx = host
    project, conv = _setup(ctx)
    with _Adapter(app) as adapter:
        connection = _pair_and_grant(adapter.client, ctx, tmp_path, project)
        headers = {"Authorization": f"Bearer {connection.device_token}"}
        # expected_version sbagliato: consegna ok, esito conflict visibile
        response = adapter.client.post("/v1/workspaces/ws_local/remote/commands",
                                       headers=headers,
                                       json={"command_id": "peer-x1",
                                             "type": "conversation.rename",
                                             "payload": {"conversation_id": conv,
                                                         "expected_version": 999,
                                                         "name": "Mai applicato"}})
        assert response.status_code == 200  # ricevuto
        body = response.json()
        assert body["received"] is True
        assert body["outcome"]["status"] != "accepted"

        outbox = RemoteOutbox(tmp_path / "peer_outbox.db")
        outbox.enqueue(host=connection.host, command_id="peer-x2",
                       type_="conversation.rename",
                       payload={"conversation_id": conv, "expected_version": 999,
                                "name": "Mai applicato"})
        result = outbox.flush(connection)
        assert result["conflicts"] == 1
        statuses = {e["command_id"]: e["status"] for e in outbox.pending()}
        # x2 è conflict (consegnato, rifiutato); non resta pending
        assert outbox.pending() == []


def test_remote_command_perimeter(host, tmp_path):
    app, ctx = host
    project, conv = _setup(ctx)
    with _Adapter(app) as adapter:
        connection = _pair_and_grant(adapter.client, ctx, tmp_path, project)
        headers = {"Authorization": f"Bearer {connection.device_token}"}
        forbidden = adapter.client.post("/v1/workspaces/ws_local/remote/commands",
                                        headers=headers,
                                        json={"command_id": "peer-evil",
                                              "type": "grant.issue",
                                              "payload": {"project_id": project,
                                                          "subject_id": "person_fabio",
                                                          "capability": "admin"}})
        assert forbidden.status_code == 400
        assert "may not" in forbidden.json()["detail"]["message"]
