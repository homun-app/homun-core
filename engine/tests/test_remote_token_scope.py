"""Ambito dei token remoti — un dispositivo abbinato non è il proprietario.

Il token launcher del desktop mantiene l'accesso completo; qualunque token
di persona (dispositivo abbinato con /v1/remote/pair oppure sessione
riscattata con /v1/session/redeem) raggiunge SOLO l'allowlist esplicita di
``routes/remote_scope.py``: tutto il resto risponde 403
``session.scope_denied`` prima del gestore della rotta. Una rotta nuova è
chiusa per impostazione predefinita.
"""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient
from fastapi.responses import JSONResponse
from starlette.middleware import Middleware

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.routes.remote_scope import is_remote_scope_allowed
from object_transfer_f55_support import (
    OWNER,
    _apply_host,
    _grant,
    _pair_giulia,
    _setup_shared,
    host,
)

WS = "/v1/workspaces/ws_local"


def _member(client: TestClient, tmp_path) -> dict[str, str]:
    """Giulia, membro senza alcun grant: solo il suo token di dispositivo."""
    confirm, _identity = _pair_giulia(client, tmp_path)
    return {"Authorization": f"Bearer {confirm['device_token']}"}, confirm


def _scope_denied(response) -> bool:
    return (
        response.status_code == 403
        and response.json()["detail"].get("reason") == "session.scope_denied"
    )


# --- I quattro casi riprodotti dalla verifica di sicurezza -------------------


def test_member_cannot_register_stdio_mcp_server(host, tmp_path):
    """POST mcp/servers con command arbitrario = esecuzione codice sull'host:
    il membro deve ricevere 403 di ambito prima del gestore. Il server viene
    solo registrato (/usr/bin/true, innocuo) e /test non è mai chiamato."""
    app, _ctx, _ = host
    with TestClient(app, raise_server_exceptions=False) as client:
        member, _confirm = _member(client, tmp_path)
        body = {"command_id": "srv_intruso", "name": "intruso",
                "transport": "stdio", "command": "/usr/bin/true"}
        denied = client.post(f"{WS}/mcp/servers", headers=member, json=body)
        assert _scope_denied(denied), denied.text
        # invariante 1: il launcher registra lo stesso server senza problemi
        allowed = client.post(f"{WS}/mcp/servers", headers=OWNER, json=body)
        assert allowed.status_code == 200, allowed.text


def test_member_cannot_read_owner_personal_memories(host, tmp_path):
    """GET memories e memories/export restituivano le memorie PERSONALI del
    proprietario a un membro senza grant."""
    app, ctx, _ = host
    ctx.memory.add_approved(text="Segreto del proprietario", actor_id="person_fabio",
                            scope="person", subject_id="person_fabio")
    with TestClient(app, raise_server_exceptions=False) as client:
        member, _confirm = _member(client, tmp_path)
        for path in (f"{WS}/memories", f"{WS}/memories/export"):
            denied = client.get(path, headers=member)
            assert _scope_denied(denied), f"{path}: {denied.text}"
        # invariante 1: il launcher vede le proprie memorie personali
        own = client.get(f"{WS}/memories", headers=OWNER)
        assert own.status_code == 200
        assert "Segreto del proprietario" in {m["text"] for m in own.json()["memories"]}


def test_member_cannot_create_or_list_backups(host, tmp_path):
    """POST/GET backups = copia dell'intero workspace e percorsi su disco."""
    app, _ctx, _ = host
    with TestClient(app, raise_server_exceptions=False) as client:
        member, _confirm = _member(client, tmp_path)
        denied_post = client.post(f"{WS}/backups", headers=member)
        assert _scope_denied(denied_post), denied_post.text
        denied_get = client.get(f"{WS}/backups", headers=member)
        assert _scope_denied(denied_get), denied_get.text
        # invariante 1: il launcher crea e elenca i propri backup
        assert client.post(f"{WS}/backups", headers=OWNER).status_code == 200
        assert client.get(f"{WS}/backups", headers=OWNER).status_code == 200


def test_member_cannot_submit_forbidden_commands(host, tmp_path):
    """POST commands con project.create è vietato dal perimetro remoto
    (REMOTE_ALLOWED_COMMANDS): il 403 di ambito arriva prima del gestore."""
    app, ctx, _ = host
    with TestClient(app, raise_server_exceptions=False) as client:
        member, _confirm = _member(client, tmp_path)
        denied = client.post(f"{WS}/commands", headers=member, json={
            "command_id": "p_intruso", "type": "project.create",
            "payload": {"name": "Intruso"}})
        assert _scope_denied(denied), denied.text
        # invariante 1: il launcher crea il progetto
        allowed = client.post(f"{WS}/commands", headers=OWNER, json={
            "command_id": "p_owner", "type": "project.create",
            "payload": {"name": "Del proprietario"}})
        assert allowed.status_code == 200, allowed.text


def test_redeemed_session_is_scope_limited_too(host, tmp_path):
    """Anche la sessione riscattata con /v1/session/redeem (non solo il
    dispositivo abbinato) è limitata all'allowlist."""
    app, _ctx, _ = host
    with TestClient(app, raise_server_exceptions=False) as client:
        invite = client.post(f"{WS}/people/invites", headers=OWNER,
                             json={"role": "member"}).json()["token"]
        session = client.post("/v1/session/redeem",
                              json={"token": invite, "display_name": "Redenta"}).json()
        redeemed = {"Authorization": f"Bearer {session['session_token']}"}
        denied = client.get(f"{WS}/memories", headers=redeemed)
        assert _scope_denied(denied), denied.text


def test_dev_insecure_person_bearer_is_scope_limited(tmp_path):
    """Senza middleware di sessione (dev-insecure) il Bearer di persona è
    risolto da PersonBearerHeaderMiddleware: stesso ambito, anche in dev."""
    ctx = create_context(db_path=tmp_path / "insecure.db", data_dir=tmp_path,
                         for_tests=True)
    reset_context_for_tests(ctx)
    app = create_app()  # nessun session_token
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            member, _confirm = _member(client, tmp_path)
            denied = client.get(f"{WS}/memories", headers=member)
            assert _scope_denied(denied), denied.text
            # le rotte dell'allowlist continuano a funzionare per il peer
            allowed = client.get(f"{WS}/projects", headers=member)
            assert allowed.status_code == 200, allowed.text
            assert allowed.json()["items"] == []
    finally:
        reset_context_for_tests(None)
        ctx.close()


# --- L'allowlist: i modelli di metodo e percorso -----------------------------


def test_allowlist_matches_exactly_the_remote_routes():
    """I modelli coprono le rotte dei client reali (peers/*) e null'altro."""
    allowed = [
        ("GET", "/v1/workspaces/ws_local/remote/snapshot"),
        ("GET", "/v1/workspaces/altro-spazio/remote/events"),
        ("POST", "/v1/workspaces/ws_local/remote/commands"),
        ("GET", "/v1/workspaces/ws_local/projects"),
        ("GET", "/v1/workspaces/ws_local/remote/assignments"),
        ("GET", "/v1/workspaces/ws_local/remote/assignments/asg_1"),
        ("POST", "/v1/workspaces/ws_local/remote/assignments/asg_1/accept"),
        ("POST", "/v1/workspaces/ws_local/remote/assignments/asg_1/return"),
        ("POST", "/v1/workspaces/ws_local/remote/assignments/asg_1/reconcile"),
        ("POST", "/v1/workspaces/ws_local/remote/objects"),
        ("GET", "/v1/workspaces/ws_local/remote/objects"),
        ("GET", "/v1/workspaces/ws_local/remote/objects/obj_1/versions/2"),
        ("PUT", "/v1/workspaces/ws_local/remote/objects/obj_1/versions/2/chunks/0"),
        ("GET", "/v1/workspaces/ws_local/remote/objects/obj_1/versions/2/chunks/0"),
    ]
    for method, path in allowed:
        assert is_remote_scope_allowed(method, path), (method, path)
    denied = [
        ("GET", "/v1/health"),
        ("POST", "/v1/workspaces/ws_local/mcp/servers"),
        ("GET", "/v1/workspaces/ws_local/memories"),
        ("POST", "/v1/workspaces/ws_local/commands"),
        ("POST", "/v1/workspaces/ws_local/backups"),
        ("POST", "/v1/workspaces/ws_local/projects"),            # solo GET è remoto
        ("GET", "/v1/workspaces/ws_local/remote/assignments/asg_1/accept"),  # solo POST
        ("POST", "/v1/workspaces/ws_local/remote/commands/extra"),  # segmento in più
        ("GET", "/v1/workspaces//remote/snapshot"),              # segmento vuoto
        ("GET", "/v1/workspaces/ws_local/remote/../memories"),   # traversal: un
        # placeholder è UN segmento, «..» non allarga il modello
    ]
    for method, path in denied:
        assert not is_remote_scope_allowed(method, path), (method, path)


# --- La passeggiata: OGNI rotta fuori dall'allowlist è chiusa -----------------

# Rotte che si autenticano da sole con l'invito nel corpo: il middleware di
# sessione le esclude prima di leggere il Bearer, non fanno parte della
# superficie autenticata con token di persona.
SELF_AUTHENTICATED = {
    ("POST", "/v1/contribution-portal/read"),
    ("POST", "/v1/contribution-portal/respond"),
    ("POST", "/v1/session/redeem"),
    ("POST", "/v1/remote/pair"),
    ("POST", "/v1/remote/pair/confirm"),
}


class _InnerGuard:
    """La middleware PIÙ INTERNA: risponde 418 quando la richiesta ha
    superato la middleware di sessione. Così la passeggiata prova l'ambito
    su ogni rotta senza mai eseguire un gestore (nessun processo, nessuna
    rete, nessun effetto collaterale)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            await JSONResponse(status_code=418, content={"guard": True})(scope, receive, send)
            return
        await self.app(scope, receive, send)


def test_every_route_outside_allowlist_denies_member_and_keeps_owner(host, tmp_path):
    app, _ctx, _ = host
    # Il pairing avviene su un client senza guard (la guard 418 fermerebbe
    # anche le chiamate launcher del flusso di invito).
    with TestClient(app, raise_server_exceptions=False) as plain:
        member, _confirm = _member(plain, tmp_path)
    # La passeggiata gira su una seconda app (stesso contesto globale) con
    # la guard come middleware più interna: ogni 418 prova che la richiesta
    # ha superato la sessione, senza eseguire nessun gestore.
    from object_transfer_f55_support import LAUNCHER_TOKEN

    guarded = create_app(session_token=LAUNCHER_TOKEN)
    guarded.user_middleware.append(Middleware(_InnerGuard))
    with TestClient(guarded, raise_server_exceptions=False) as client:
        checked = 0
        for path, operations in sorted(guarded.openapi()["paths"].items()):
            concrete = re.sub(r"\{[^/{}]+\}", "campione", path)
            for method in sorted(operations):
                if method not in {"get", "put", "post", "patch", "delete"}:
                    continue
                checked += 1
                # invariante 1: il launcher non riceve MAI 403 di ambito
                owner_response = client.request(method.upper(), concrete, headers=OWNER)
                assert owner_response.status_code == 418, (method.upper(), path)
                if (method.upper(), path) in SELF_AUTHENTICATED:
                    continue
                member_response = client.request(method.upper(), concrete, headers=member)
                if is_remote_scope_allowed(method.upper(), concrete):
                    assert member_response.status_code == 418, (method.upper(), path)
                else:
                    assert _scope_denied(member_response), (method.upper(), path)
        assert checked > 250, "la passeggiata deve coprire tutte le rotte del motore"


# --- Difesa in profondità sulle memorie (routes/memory.py) -------------------


def _seed_memories(ctx, giulia_person_id: str, shared: str, private: str):
    ctx.memory.add_approved(text="Personale di Giulia", actor_id=giulia_person_id,
                            scope="person", subject_id=giulia_person_id)
    ctx.memory.add_approved(text="Personale di Fabio", actor_id="person_fabio",
                            scope="person", subject_id="person_fabio")
    ctx.memory.add_approved(text="Lezione del progetto condiviso",
                            actor_id="person_fabio", project_id=shared,
                            scope="project")
    ctx.memory.add_approved(text="Lezione del progetto privato",
                            actor_id="person_fabio", project_id=private,
                            scope="project")
    ctx.memory.add_approved(text="Mestiere condiviso del workspace",
                            actor_id="person_fabio", scope="global")


def test_memories_never_return_another_persons_notes(host, tmp_path):
    """Anche chiamate dal launcher: le memorie scope=person di altri non si
    restituiscono MAI, su list e su export."""
    app, ctx, _ = host
    shared, private = _setup_shared(ctx)
    with TestClient(app, raise_server_exceptions=False) as client:
        _member, confirm = _member(client, tmp_path)
        _seed_memories(ctx, confirm["person_id"], shared, private)
        for path in (f"{WS}/memories", f"{WS}/memories/export"):
            got = client.get(path, headers=OWNER)
            assert got.status_code == 200, got.text
            texts = {m["text"] for m in got.json()["memories"]}
            assert "Personale di Giulia" not in texts, path
            assert "Personale di Fabio" in texts, path


def test_memories_project_notes_require_read_grant(tmp_path):
    """Le memorie di progetto si restituiscono solo con grant read sul
    progetto REALE della nota: Giulia (read sul condiviso) vede la lezione
    condivisa, mai quella del progetto privato né le note personali altrui."""
    ctx = create_context(db_path=tmp_path / "mem.db", data_dir=tmp_path,
                         for_tests=True)
    reset_context_for_tests(ctx)
    app = create_app()  # dev-insecure: attore fidato dall'header
    try:
        shared, private = _setup_shared(ctx)
        with TestClient(app, raise_server_exceptions=False) as client:
            _member, confirm = _member(client, tmp_path)
            giulia = confirm["person_id"]
            _grant(ctx, "gr_giulia", giulia, shared, capability="read")
            _seed_memories(ctx, giulia, shared, private)
            as_giulia = {"X-Homun-Actor-Id": giulia}
            for path in (f"{WS}/memories", f"{WS}/memories/export"):
                got = client.get(path, headers=as_giulia)
                assert got.status_code == 200, got.text
                texts = {m["text"] for m in got.json()["memories"]}
                assert "Lezione del progetto condiviso" in texts, path
                assert "Personale di Giulia" in texts, path  # le proprie sì
                assert "Lezione del progetto privato" not in texts, path
                assert "Personale di Fabio" not in texts, path
                assert "Mestiere condiviso del workspace" in texts, path
    finally:
        reset_context_for_tests(None)
        ctx.close()
