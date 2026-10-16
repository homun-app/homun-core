"""Listener remoto separato: il traffico di rete NON entra mai dal loopback.

Il listener principale resta su 127.0.0.1/::1 (test_session_auth); la rete
arriva SOLO all'app di ``remote_listener.py``, dove:
- l'attore nasce ESCLUSIVAMENTE dal token di persona/dispositivo (registro
  sessioni): ogni header ``X-Homun-Actor-Id``/``X-Homun-Actor-Name`` inviato
  dal client è rifiutato, anche «corretto»;
- il token launcher del desktop NON è accettato (non è nel registro);
- si raggiungono solo le rotte dell'allowlist (routes/remote_scope.py) più
  il pairing, che si autentica da solo con l'invito;
- non esiste alcuna modalità senza autenticazione.

Qui l'app remota è provata direttamente via TestClient: nessun socket reale.
"""
from __future__ import annotations

import argparse
import re

import pytest
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from starlette.middleware import Middleware

from homun.context import create_context, reset_context_for_tests
from homun.remote_listener import (
    RemoteListenError,
    create_remote_app,
    parse_remote_listen,
)
from homun.routes.remote_scope import is_remote_scope_allowed
from object_transfer_f55_support import LAUNCHER_TOKEN, _grant, _setup_shared
from homun.peers.device_identity import load_device_identity

WS = "/v1/workspaces/ws_local"

# Le due rotte che si autenticano da sole con l'invito nel corpo.
PAIRING_ROUTES = {("POST", "/v1/remote/pair"), ("POST", "/v1/remote/pair/confirm")}


@pytest.fixture
def remote_host(tmp_path):
    ctx = create_context(db_path=tmp_path / "host.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    app = create_remote_app()
    yield app, ctx, tmp_path
    reset_context_for_tests(None)
    ctx.close()


def _invite(ctx) -> str:
    from homun.domain.models import Actor
    from homun.identity import issue_person_invite

    actor = Actor(id="person_fabio", workspace_id=ctx.workspace_id, display_name="Fabio")
    return issue_person_invite(ctx, actor, {"role": "member"})["token"]


def _pair_on_remote(ctx, client: TestClient, tmp_path, name="Giulia"):
    """Pairing completo ATTRAVERSO il listener remoto: invito creato dal
    proprietario sul listener locale (qui via servizio), i due passaggi di
    /v1/remote/pair dal network client."""
    identity = load_device_identity(tmp_path / f"{name.lower()}_key.json")
    invite = _invite(ctx)
    present = client.post("/v1/remote/pair", json={
        "invite_token": invite,
        "display_name": name,
        "device_name": f"MacBook di {name}",
        "public_key": identity.public_b64,
        "protocol_version": 1,
    })
    assert present.status_code == 200, present.text
    confirm = client.post("/v1/remote/pair/confirm", json={
        "pairing_id": present.json()["pairing_id"],
        "invite_token": invite,
        "signature": identity.sign(present.json()["nonce"]),
    })
    assert confirm.status_code == 200, confirm.text
    return confirm.json()


def _member(remote_host, tmp_path):
    """Giulia abbinata SUL listener remoto: il suo token di dispositivo."""
    app, ctx, _ = remote_host
    with TestClient(app, raise_server_exceptions=False) as client:
        confirm = _pair_on_remote(ctx, client, tmp_path)
    return {"Authorization": f"Bearer {confirm['device_token']}"}, confirm


def _scope_denied(response) -> bool:
    return (
        response.status_code == 403
        and response.json()["detail"].get("reason") == "session.scope_denied"
    )


def _actor_header_forbidden(response) -> bool:
    return (
        response.status_code in (400, 403)
        and response.json()["detail"].get("reason") == "remote.actor_header_forbidden"
    )


# --- Header attore: MAI accettati dal client ---------------------------------


def test_forged_actor_header_without_token_is_rejected(remote_host):
    """La riproduzione del problema: sul listener remoto l'header attore non
    autentica nessuno, nemmeno senza token."""
    app, _ctx, _ = remote_host
    with TestClient(app, raise_server_exceptions=False) as client:
        for path in (f"{WS}/projects", f"{WS}/memories", f"{WS}/mcp/servers"):
            response = client.get(path, headers={"X-Homun-Actor-Id": "person_fabio"})
            assert _actor_header_forbidden(response), f"{path}: {response.text}"


def test_actor_name_header_alone_is_rejected(remote_host):
    app, _ctx, _ = remote_host
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get(f"{WS}/projects", headers={"X-Homun-Actor-Name": "Fabio"})
        assert _actor_header_forbidden(response), response.text


def test_valid_token_with_any_actor_header_is_rejected(remote_host, tmp_path):
    """Token valido + header attore: rifiutato sia con l'id di un'altra
    persona (impersonazione) sia con il proprio (il client non dichiara mai
    l'attore sul listener remoto)."""
    app, _ctx, _ = remote_host
    member, confirm = _member(remote_host, tmp_path)
    with TestClient(app, raise_server_exceptions=False) as client:
        for actor_id in ("person_fabio", confirm["person_id"]):
            headers = {**member, "X-Homun-Actor-Id": actor_id}
            response = client.get(f"{WS}/projects", headers=headers)
            assert _actor_header_forbidden(response), f"{actor_id}: {response.text}"


# --- Token: solo sessioni di persona/dispositivo del registro ----------------


def test_launcher_token_is_not_accepted(remote_host):
    """Il token del desktop non è nel registro sessioni: sulla rete non vale."""
    app, _ctx, _ = remote_host
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get(f"{WS}/projects",
                              headers={"Authorization": f"Bearer {LAUNCHER_TOKEN}"})
        assert response.status_code == 401, response.text
        assert response.json()["detail"]["code"] == "session_required"


def test_request_without_token_is_unauthorized(remote_host):
    """Non esiste modalità senza autenticazione: nessun header, nessuna rotta
    (allowlist inclusa) risponde 200."""
    app, _ctx, _ = remote_host
    with TestClient(app, raise_server_exceptions=False) as client:
        for method, path in (("GET", f"{WS}/projects"),
                             ("GET", f"{WS}/remote/snapshot"),
                             ("POST", f"{WS}/commands"),
                             ("GET", "/v1/health")):
            response = client.request(method, path)
            assert response.status_code == 401, f"{method} {path}: {response.text}"


# --- Ambito: solo l'allowlist + pairing --------------------------------------


def test_route_outside_allowlist_is_denied(remote_host, tmp_path):
    """Rotte fuori elenco → 403 di ambito PRIMA del routing, montate o no che
    siano (il 403 uniforme non rivela nemmeno quali rotte esistono)."""
    app, _ctx, _ = remote_host
    member, _confirm = _member(remote_host, tmp_path)
    with TestClient(app, raise_server_exceptions=False) as client:
        for path in (f"{WS}/people",                                   # montata, non remota
                     f"{WS}/memories",                                 # mai montata
                     f"{WS}/mcp/servers"):                             # mai montata
            denied = client.get(path, headers=member)
            assert _scope_denied(denied), f"{path}: {denied.text}"
        denied = client.post(f"{WS}/commands", headers=member, json={
            "command_id": "p_intruso", "type": "project.create",
            "payload": {"name": "Intruso"}})
        assert _scope_denied(denied), denied.text
        docs = client.get("/openapi.json")                            # niente superficie docs
        assert docs.status_code in (401, 403, 404), docs.text


def test_allowlist_route_with_grant_works(remote_host, tmp_path):
    """Snapshot del progetto condiviso con grant read: il 200 dimostra anche
    che l'attore iniettato dal middleware è la persona della sessione (il
    feed filtra sui grant REALI di quell'attore)."""
    app, ctx, _ = remote_host
    shared, private = _setup_shared(ctx)
    member, confirm = _member(remote_host, tmp_path)
    _grant(ctx, "gr_g1", confirm["person_id"], shared)
    with TestClient(app, raise_server_exceptions=False) as client:
        got = client.get(f"{WS}/remote/snapshot",
                         params={"project_id": shared}, headers=member)
        assert got.status_code == 200, got.text
        assert got.json()["project"]["name"] == "Condiviso"
        denied = client.get(f"{WS}/remote/snapshot",
                            params={"project_id": private}, headers=member)
        assert denied.status_code == 403, denied.text  # permesso della risorsa reale


def test_pairing_works_on_remote_listener(remote_host, tmp_path):
    """Il flusso completo del pilot: invito (proprietario, locale) + due
    passaggi di pairing dal peer sul listener remoto + primo uso del token."""
    app, ctx, _ = remote_host
    with TestClient(app, raise_server_exceptions=False) as client:
        confirm = _pair_on_remote(ctx, client, tmp_path)
    assert confirm["person_id"] and confirm["device_token"]
    with TestClient(app, raise_server_exceptions=False) as client:
        projects = client.get(f"{WS}/projects", headers={
            "Authorization": f"Bearer {confirm['device_token']}"})
        assert projects.status_code == 200, projects.text
        assert projects.json()["items"] == []


# --- La passeggiata: ogni rotta montata fuori elenco è chiusa -----------------


class _InnerGuard:
    """Middleware più interna: 418 = la richiesta ha superato il listener.
    Nessun gestore eseguito (pattern di test_remote_token_scope)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            await JSONResponse(status_code=418, content={"guard": True})(scope, receive, send)
            return
        await self.app(scope, receive, send)


def test_every_remote_route_outside_allowlist_is_closed(remote_host, tmp_path):
    app, ctx, _ = remote_host
    member, _confirm = _member(remote_host, tmp_path)
    guarded = create_remote_app()
    guarded.user_middleware.append(Middleware(_InnerGuard))
    with TestClient(guarded, raise_server_exceptions=False) as client:
        checked = 0
        for path, operations in sorted(guarded.openapi()["paths"].items()):
            concrete = re.sub(r"\{[^/{}]+\}", "campione", path)
            for method in sorted(operations):
                if method not in {"get", "put", "post", "patch", "delete"}:
                    continue
                checked += 1
                response = client.request(method.upper(), concrete, headers=member)
                if (method.upper(), path) in PAIRING_ROUTES:
                    # pairing: passa sempre (l'invito nel corpo si valida dopo)
                    assert response.status_code == 418, (method.upper(), path)
                elif is_remote_scope_allowed(method.upper(), concrete):
                    assert response.status_code == 418, (method.upper(), path)
                else:
                    assert _scope_denied(response), (method.upper(), path, response.text)
        assert checked > 40, "la passeggiata deve coprire le rotte montate sul remoto"


def test_main_listener_still_binds_loopback_only(tmp_path, monkeypatch, capsys):
    """Invarianti del listener principale: loopback sempre, e --remote-listen
    con --dev-insecure non parte MAI (né apre socket)."""
    from homun.application.ops.server import serve

    class _NoSockets:
        AF_INET = 2
        AF_INET6 = 10

        def socket(self, *args, **kwargs):
            raise AssertionError("serve() non deve aprire socket in questi test")

    monkeypatch.setattr("homun.application.ops.server.socket", _NoSockets())
    monkeypatch.delenv("HOMUN_SESSION_TOKEN", raising=False)
    monkeypatch.delenv("HOMUN_PARENT_WATCHDOG", raising=False)
    args = argparse.Namespace(host="127.0.0.1", port=8765, dev_insecure=True,
                              remote_listen="127.0.0.2:18765")
    assert serve(args) != 0
    assert "remote" in capsys.readouterr().err.lower()
    # il listener principale resta SOLO su loopback, con o senza listener remoto
    args = argparse.Namespace(host="0.0.0.0", port=8765, dev_insecure=True,
                              remote_listen=None)
    assert serve(args) != 0
    assert "loopback" in capsys.readouterr().err.lower()


def test_serve_rejects_wildcard_remote_listen(tmp_path, monkeypatch, capsys):
    """0.0.0.0 / [::] sono jolly: serve un indirizzo esplicito (es. IP di
    Tailscale); formati incompleti sono rifiutati con codice ≠ 0."""
    from homun.application.ops.server import serve

    class _NoSockets:
        AF_INET = 2
        AF_INET6 = 10

        def socket(self, *args, **kwargs):
            raise AssertionError("serve() non deve aprire socket in questi test")

    monkeypatch.setattr("homun.application.ops.server.socket", _NoSockets())
    monkeypatch.setenv("HOMUN_SESSION_TOKEN", "t" * 40)
    monkeypatch.delenv("HOMUN_PARENT_WATCHDOG", raising=False)
    for bad in ("0.0.0.0:18765", "[::]:18765", "18765", "127.0.0.2", "127.0.0.2:0",
                "127.0.0.2:70000"):
        args = argparse.Namespace(host="127.0.0.1", port=8765, dev_insecure=False,
                                  remote_listen=bad)
        assert serve(args) != 0, bad
        assert "remote" in capsys.readouterr().err.lower(), bad


def test_parse_remote_listen_accepts_explicit_addresses():
    assert parse_remote_listen("127.0.0.2:18765") == ("127.0.0.2", 18765)
    assert parse_remote_listen("100.64.12.34:8765") == ("100.64.12.34", 8765)
    assert parse_remote_listen("[2001:db8::1]:8765") == ("2001:db8::1", 8765)
    for bad in ("0.0.0.0:8765", "[::]:8765", ":8765", "127.0.0.2", "127.0.0.2:",
                "127.0.0.2:port", "127.0.0.2:0", "127.0.0.2:70000", "  "):
        with pytest.raises(RemoteListenError):
            parse_remote_listen(bad)
