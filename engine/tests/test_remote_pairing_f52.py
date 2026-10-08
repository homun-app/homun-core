"""F5 fetta 2 — pairing remoto con prova di possesso della chiave.

L'host è l'app di test; il peer è la libreria reale (chiave Ed25519
generata in una directory temporanea, due passaggi HTTP). Casi del
contratto: firma sbagliata non consuma né l'invito né la sfida; versione
protocollo incompatibile rifiutata esplicitamente; sfida scaduta rifiutata;
il token del dispositivo autentica le chiamate e muore con la revoca del
dispositivo; l'invito resta monouso anche via pairing."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, get_context, reset_context_for_tests

LAUNCHER_TOKEN = "t" * 40
OWNER = {"X-Homun-Actor-Id": "person_fabio",
         "Authorization": f"Bearer {LAUNCHER_TOKEN}"}


@pytest.fixture
def app(tmp_path):
    ctx = create_context(db_path=tmp_path / "host.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    application = create_app(session_token=LAUNCHER_TOKEN)
    yield application
    reset_context_for_tests(None)
    ctx.close()


def _invite(client: TestClient) -> str:
    response = client.post("/v1/workspaces/ws_local/people/invites",
                           headers=OWNER, json={"role": "member"})
    assert response.status_code == 200, response.text
    return response.json()["token"]


def _pair(client: TestClient, invite: str, key_path, name: str = "Giulia"):
    from homun.peers import pair_with_host
    with client:
        # il client reale parla HTTP verso l'app di test
        return pair_with_host("http://testhost", invite, name, f"Mac di {name}", key_path)


class _TestHostAdapter:
    """Il pairing_client chiama http://testhost:instrada sull'app di test."""

    def __init__(self, app):
        self._client = TestClient(app)

    def __enter__(self):
        import homun.peers.pairing_client as pc
        self._original_post, self._original_get = pc._post, pc._get
        client = self._client

        def post(url, payload, bearer=None, timeout=15.0):
            path = url.split("testhost", 1)[1]
            headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
            response = client.post(path, json=payload, headers=headers)
            import json as _json
            if response.status_code >= 400:
                raise RuntimeError(f"HTTP {response.status_code}: {response.text}")
            return _json.loads(response.content)

        def get(url, bearer, timeout=15.0):
            path = url.split("testhost", 1)[1]
            response = client.get(path, headers={"Authorization": f"Bearer {bearer}"})
            import json as _json
            if response.status_code >= 400:
                raise RuntimeError(f"HTTP {response.status_code}: {response.text}")
            return _json.loads(response.content)

        pc._post, pc._get = post, get
        return self

    def __exit__(self, *exc):
        import homun.peers.pairing_client as pc
        pc._post, pc._get = self._original_post, self._original_get


def test_pairing_happy_path_and_remote_call(app, tmp_path):
    with _TestHostAdapter(app) as adapter:
        invite = _invite(adapter._client)
        connection = _pair(adapter._client, invite, tmp_path / "peer_key.json")
        assert connection.person_id.startswith("person_")
        assert connection.device_token
        # il token del dispositivo autentica una chiamata remota reale
        projects = adapter._client.get(
            "/v1/workspaces/ws_local/projects",
            headers={"Authorization": f"Bearer {connection.device_token}"})
        assert projects.status_code == 200
        # la persona è in elenco con dispositivo confermato e fingerprint
        people = adapter._client.get("/v1/workspaces/ws_local/people",
                                     headers=OWNER).json()["items"]
        giulia = next(p for p in people if p["id"] == connection.person_id)
        assert giulia["status"] == "active" and len(giulia["devices"]) == 1


def test_wrong_signature_keeps_invite_alive(app, tmp_path):
    with _TestHostAdapter(app) as adapter:
        invite = _invite(adapter._client)
        client = adapter._client
        from homun.peers import load_device_identity
        import base64
        honest = load_device_identity(tmp_path / "honest.json")
        imposter = load_device_identity(tmp_path / "imposter.json")
        present = client.post("/v1/remote/pair", json={
            "invite_token": invite, "display_name": "Giulia",
            "device_name": "Mac", "public_key": honest.public_b64,
            "protocol_version": 1}).json()
        # l'impostore firma con la sua chiave: rifiutato
        bad = client.post("/v1/remote/pair/confirm", json={
            "pairing_id": present["pairing_id"], "invite_token": invite,
            "signature": imposter.sign(present["nonce"])})
        assert bad.status_code in (401, 403)
        # la firma giusta riesce: invito e sfida erano intatti
        good = client.post("/v1/remote/pair/confirm", json={
            "pairing_id": present["pairing_id"], "invite_token": invite,
            "signature": honest.sign(present["nonce"])})
        assert good.status_code == 200, good.text
        assert good.json()["device_token"]


def test_protocol_version_mismatch_is_explicit(app, tmp_path):
    with _TestHostAdapter(app) as adapter:
        client = adapter._client
        invite = _invite(client)
        from homun.peers import load_device_identity
        identity = load_device_identity(tmp_path / "k.json")
        response = client.post("/v1/remote/pair", json={
            "invite_token": invite, "display_name": "Futuro",
            "device_name": "Mac", "public_key": identity.public_b64,
            "protocol_version": 99})
        assert response.status_code in (400, 409)
        assert "protocol" in response.json()["detail"]["message"].lower()


def test_expired_challenge_rejected(app, tmp_path):
    with _TestHostAdapter(app) as adapter:
        client = adapter._client
        invite = _invite(client)
        from homun.peers import load_device_identity
        identity = load_device_identity(tmp_path / "k.json")
        present = client.post("/v1/remote/pair", json={
            "invite_token": invite, "display_name": "Lento",
            "device_name": "Mac", "public_key": identity.public_b64,
            "protocol_version": 1}).json()
        repo = get_context().repository
        with repo.locked():
            with repo.transaction() as store:
                record = store.commands[present["pairing_id"]]
                record.result["expires_at"] = (
                    datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        late = client.post("/v1/remote/pair/confirm", json={
            "pairing_id": present["pairing_id"], "invite_token": invite,
            "signature": identity.sign(present["nonce"])})
        assert late.status_code in (401, 403)
        # e l'invito non è stato consumato
        retry = client.post("/v1/remote/pair", json={
            "invite_token": invite, "display_name": "Lento",
            "device_name": "Mac", "public_key": identity.public_b64,
            "protocol_version": 1})
        assert retry.status_code == 200


def test_device_revocation_kills_transport_token(app, tmp_path):
    with _TestHostAdapter(app) as adapter:
        invite = _invite(adapter._client)
        connection = _pair(adapter._client, invite, tmp_path / "peer.json")
        client = adapter._client
        ok = client.get("/v1/workspaces/ws_local/projects",
                        headers={"Authorization": f"Bearer {connection.device_token}"})
        assert ok.status_code == 200
        revoked = client.post(f"/v1/workspaces/ws_local/devices/{connection.device_id}/revoke",
                              headers=OWNER)
        assert revoked.status_code == 200
        dead = client.get("/v1/workspaces/ws_local/projects",
                          headers={"Authorization": f"Bearer {connection.device_token}"})
        assert dead.status_code == 401


def test_invite_still_single_use_via_pairing(app, tmp_path):
    with _TestHostAdapter(app) as adapter:
        invite = _invite(adapter._client)
        _pair(adapter._client, invite, tmp_path / "first.json", "Giulia")
        # il secondo pairing con lo stesso invito muore alla conferma:
        # la presentazione non consuma, il consumo avviene una volta sola
        with pytest.raises(RuntimeError):
            _pair(adapter._client, invite, tmp_path / "second.json", "Intruso")
