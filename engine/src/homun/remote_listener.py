"""Listener remoto separato: l'unica superficie del motore che sta in rete.

Il listener principale (``application/ops/server.py``) resta legato al solo
loopback: il traffico di rete arriva QUI, su un secondo socket dello stesso
processo (stesso contesto, stesso store). Tre regole, in quest'ordine:

1. l'attore nasce SOLO dal token di persona/dispositivo del registro
   sessioni (``PersonSessionStore``): ogni header ``X-Homun-Actor-Id`` /
   ``X-Homun-Actor-Name`` inviato dal client è rifiutato, anche «corretto»;
2. il token launcher del desktop NON è nel registro: sulla rete non vale
   nulla, e non esiste una modalità senza autenticazione;
3. si raggiungono solo le rotte dell'allowlist (``routes/remote_scope.py``)
   più il pairing, che si autentica da solo con l'invito nel corpo.

L'app NON ha lifespan: il contesto appartiene all'app principale nello
stesso processo, qui si legge ``get_context()`` a ogni richiesta.
"""
from __future__ import annotations

import sqlite3
import socket as _socket_module

from fastapi import FastAPI
from starlette.responses import JSONResponse

from homun import __version__
from homun.routes.errors import storage_error_handler
from homun.routes.remote_scope import is_remote_scope_allowed, scope_denied_response
from homun.routes.session_auth import resolve_person_bearer

# Il client non dichiara mai l'attore sul listener remoto: l'identità viene
# dal token, gli header cosmetici compresi.
ACTOR_HEADER_NAMES = frozenset({b"x-homun-actor-id", b"x-homun-actor-name"})

# Le rotte che si autenticano da sole con l'invito nel corpo: non accettano
# né il token launcher né sessioni, e non leggono header attore.
PAIRING_ROUTES = frozenset({
    ("POST", "/v1/remote/pair"),
    ("POST", "/v1/remote/pair/confirm"),
})


def _actor_header_forbidden_response() -> JSONResponse:
    return JSONResponse(status_code=403, content={"detail": {
        "code": "permission_denied",
        "reason": "remote.actor_header_forbidden",
        "message": "The remote listener does not accept client actor headers; "
                   "identity comes from the session token",
    }})


class RemoteListenerMiddleware:
    """L'unico punto d'ingresso della rete: identità dal token, nulla dal client."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = scope["headers"]
        if any(name.lower() in ACTOR_HEADER_NAMES for name, _value in headers):
            response = _actor_header_forbidden_response()
        elif (scope["method"], scope["path"]) in PAIRING_ROUTES:
            return await self.app(scope, receive, send)
        else:
            bearer = next((value for name, value in headers
                           if name.lower() == b"authorization"), b"")
            actor_id = resolve_person_bearer(bearer)
            if actor_id is None:
                response = JSONResponse(status_code=401, content={"detail": {
                    "code": "session_required",
                    "message": "A valid person or device session is required"}})
            elif not is_remote_scope_allowed(scope["method"], scope["path"]):
                response = scope_denied_response()
            else:
                trusted = [(name, value) for name, value in headers
                           if name.lower() not in ACTOR_HEADER_NAMES]
                trusted.append((b"x-homun-actor-id", actor_id.encode("ascii")))
                trusted.append((b"x-homun-actor-name", actor_id.encode("ascii")))
                return await self.app({**scope, "headers": trusted}, receive, send)
        await response(scope, receive, send)


def create_remote_app() -> FastAPI:
    """L'app del listener remoto: pairing + allowlist, nessuna superficie docs."""
    app = FastAPI(
        title="Homun Engine — remote listener",
        version=__version__,
        description="Network-facing surface of the Homun engine: device pairing "
                    "plus the remote allowlist. No owner access, no unauthenticated mode.",
        # niente lifespan: il contesto è dell'app principale nello stesso processo
        docs_url=None, redoc_url=None, openapi_url=None,
    )
    app.add_exception_handler(sqlite3.Error, storage_error_handler)
    app.add_exception_handler(OSError, storage_error_handler)
    app.add_middleware(RemoteListenerMiddleware)
    # I router che contengono le rotte dell'allowlist e il pairing. Montare
    # ≠ aprire: tutto ciò che non è in remote_scope.py resta 403 PRIMA del
    # gestore (la passeggiata in tests/test_remote_listener.py lo pinna).
    from homun.routes import domain, identity_api, object_transfer_api
    app.include_router(identity_api.router)         # pairing + remote/* + assignments
    app.include_router(object_transfer_api.router)  # remote/objects
    app.include_router(domain.router)               # GET …/projects (il resto: ambito)
    return app


class RemoteListenError(ValueError):
    """--remote-listen malformato o jolly: serve un indirizzo ESPPLICITO di
    questa macchina (per esempio l'IP Tailscale 100.x.y.z), mai 0.0.0.0."""


def parse_remote_listen(value: str) -> tuple[str, int]:
    """HOST:PORT esplicito per il listener remoto (IPv6 tra parentesi quadre)."""
    raw = (value or "").strip()
    if not raw:
        raise RemoteListenError("empty address")
    if raw.startswith("["):
        host, bracket, rest = raw.partition("]")
        host = host.removeprefix("[")
        if not bracket or not rest.startswith(":"):
            raise RemoteListenError("use [address]:port for IPv6")
        port_part = rest[1:]
    else:
        host, colon, port_part = raw.rpartition(":")
        if not colon:
            raise RemoteListenError("use HOST:PORT, e.g. 100.64.0.1:8765")
        if ":" in host:
            raise RemoteListenError("bare IPv6 is ambiguous: use [address]:port")
    if host in {"", "0.0.0.0", "::"}:
        raise RemoteListenError("an explicit address of this machine is required, "
                                "not a wildcard (e.g. the Tailscale IP 100.x.y.z)")
    if not port_part.isdigit():
        raise RemoteListenError(f"port must be a number, got {port_part!r}")
    port = int(port_part)
    if not 1 <= port <= 65535:
        raise RemoteListenError(f"port out of range: {port}")
    return host, port


def run_linked_servers(bound: list[tuple[object, _socket_module.socket]]) -> None:
    """Più app uvicorn su un solo event loop, spegnimento collegato.

    Quando UN server esce (Ctrl-C, errore di avvio) tutti ricevono
    ``should_exit`` e chiudono in modo grazioso; la prima eccezione viene
    rilanciata. I signal handler li installa uvicorn nel thread principale."""
    import asyncio

    import uvicorn

    servers = [uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
               for app, _sock in bound]

    async def _linked() -> None:
        tasks = [asyncio.ensure_future(server.serve(sockets=[sock]))
                 for server, (_app, sock) in zip(servers, bound)]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for server in servers:
                server.should_exit = True
        await asyncio.gather(*tasks, return_exceptions=True)
        for task in tasks:
            if not task.cancelled() and task.exception() is not None:
                task.result()

    asyncio.run(_linked())
