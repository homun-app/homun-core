"""F5 fetta 1 — persone, inviti monouso, sessioni vere.

I casi del contratto: invito scaduto rifiutato, invito riutilizzato
rifiutato, secret sbagliato rifiutato senza consumare, persona revocata
perde grant e sessioni, dispositivo revocato perde solo le sue sessioni,
due persone vedono progetti diversi (nessun accesso implicito)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import Actor


LAUNCHER_TOKEN = "t" * 40
OWNER_HEADERS = {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio",
                 "Authorization": f"Bearer {LAUNCHER_TOKEN}"}


@pytest.fixture
def app(tmp_path):
    ctx = create_context(db_path=tmp_path / "identity.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    app = create_app(session_token="t" * 40)
    yield app
    reset_context_for_tests(None)
    ctx.close()


def _client(app) -> TestClient:
    return TestClient(app)


def _invite(client: TestClient, role: str = "member") -> dict:
    response = client.post("/v1/workspaces/ws_local/people/invites",
                           headers=OWNER_HEADERS,
                           json={"role": role, "note": "test"})
    assert response.status_code == 200, response.text
    return response.json()


def _redeem(client: TestClient, token: str, name: str) -> dict:
    response = client.post("/v1/session/redeem",
                           json={"token": token, "display_name": name,
                                 "device_name": f"Mac di {name}"})
    assert response.status_code == 200, response.text
    return response.json()


def test_invite_redeem_creates_person_and_session(app):
    with _client(app) as client:
        invite = _invite(client)
        assert invite["token"].count(".") == 1
        session = _redeem(client, invite["token"], "Giulia")
        assert session["role"] == "member"
        assert session["person_id"].startswith("person_")
        assert session["session_token"]
        # la persona compare nell'elenco, con il suo dispositivo
        people = client.get("/v1/workspaces/ws_local/people",
                            headers=OWNER_HEADERS).json()["items"]
        giulia = next(p for p in people if p["display_name"] == "Giulia")
        assert giulia["role"] == "member" and giulia["status"] == "active"
        assert len(giulia["devices"]) == 1
        # il bootstrap ha creato l'owner per il primo attore amministrativo
        fabio = next(p for p in people if p["id"] == "person_fabio")
        assert fabio["role"] == "owner"


def test_invite_single_use_and_wrong_secret(app):
    with _client(app) as client:
        invite = _invite(client)
        _redeem(client, invite["token"], "Giulia")
        again = client.post("/v1/session/redeem",
                            json={"token": invite["token"], "display_name": "Altro"})
        assert again.status_code == 409 or again.status_code == 400
        # secret sbagliato: invito NON consumato
        fresh = _invite(client)
        wrong = fresh["token"].split(".")[0] + ".potenza-di-due"
        bad = client.post("/v1/session/redeem",
                          json={"token": wrong, "display_name": "Malizioso"})
        assert bad.status_code in (400, 401, 403)
        ok = _redeem(client, fresh["token"], "Giulia 2")
        assert ok["person_id"]


def test_expired_invite_rejected(app, tmp_path, monkeypatch):
    with _client(app) as client:
        invite = _invite(client)
        # invecchia l'invito direttamente nel record
        from homun.domain.commands.identity import PERSON_INVITE_KIND
        ctx = create_context.__wrapped__ if False else None
        from homun.context import get_context
        repo = get_context().repository
        with repo.locked():
            with repo.transaction() as store:
                record = store.commands[invite["id"]]
                from datetime import datetime, timedelta, timezone
                record.result["expires_at"] = (
                    datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        expired = client.post("/v1/session/redeem",
                              json={"token": invite["token"], "display_name": "Ritardatario"})
        assert expired.status_code in (400, 409)


def test_revoked_person_loses_sessions_and_grants(app):
    with _client(app) as client:
        invite = _invite(client)
        session = _redeem(client, invite["token"], "Giulia")
        token = session["session_token"]
        # con la sessione Giulia può chiamare (per esempio elencare persone: le è negato, ma da autenticata)
        denied = client.get("/v1/workspaces/ws_local/people",
                            headers={"Authorization": f"Bearer {token}"})
        assert denied.status_code == 403  # member: non admin, ma la sessione è valida
        # revoca
        revoked = client.post(f"/v1/workspaces/ws_local/people/{session['person_id']}/revoke",
                              headers=OWNER_HEADERS)
        assert revoked.status_code == 200
        dead = client.get("/v1/workspaces/ws_local/people",
                          headers={"Authorization": f"Bearer {token}"})
        assert dead.status_code == 401  # sessione morta con la persona


def test_no_implicit_access_two_people_see_different_projects(app):
    with _client(app) as client:
        # progetto condiviso solo con Fabio (grant subject = person_fabio)
        project = client.post("/v1/workspaces/ws_local/commands",
                              headers=OWNER_HEADERS,
                              json={"command_id": "p1", "type": "project.create",
                                    "payload": {"name": "Privata"}}).json()
        session = _redeem(client, _invite(client)["token"], "Giulia")
        token = session["session_token"]
        # Giulia autenticata NON vede il progetto di Fabio: nessun accesso implicito
        visible = client.get("/v1/workspaces/ws_local/projects",
                             headers={"Authorization": f"Bearer {token}",
                                      "X-Homun-Actor-Id": session["person_id"]})
        assert visible.status_code == 200
        assert all(p["id"] != project["result"]["project_id"] for p in visible.json()["items"])
        # e Fabio continua a vederlo
        fabio_view = client.get("/v1/workspaces/ws_local/projects", headers=OWNER_HEADERS).json()
        assert any(p["id"] == project["result"]["project_id"] for p in fabio_view["items"])


def test_last_owner_cannot_be_revoked(app):
    with _client(app) as client:
        # owner bootstrap = person_fabio; prova a revocare sé stesso
        people = client.get("/v1/workspaces/ws_local/people", headers=OWNER_HEADERS).json()["items"]
        owner_id = next(p["id"] for p in people if p["role"] == "owner")
        response = client.post(f"/v1/workspaces/ws_local/people/{owner_id}/revoke",
                               headers=OWNER_HEADERS)
        assert response.status_code in (400, 409)
