"""Ambito dei token remoti: cosa una persona abbinata PUÒ raggiungere.

Un dispositivo abbinato (``/v1/remote/pair``) o una sessione riscattata
(``/v1/session/redeem``) NON è il proprietario del desktop: la sua sessione
arriva solo alle rotte di questo elenco, tutto il resto risponde 403
``session.scope_denied`` nella middleware di sessione, PRIMA del gestore.
Una rotta nuova è quindi chiusa per impostazione predefinita.

Ogni voce continua a controllare i permessi sulla risorsa REALE (grant sul
progetto, comandi ammessi, firma del publisher): l'elenco dice solo che la
rotta fa parte del perimetro remoto, non che è fidata. Per aprirne una
nuova serve aggiungerla qui INSIEME a un test di autorizzazione
(docs/development/2026-10-16-remote-token-scope.md).
"""
from __future__ import annotations

import re

from starlette.responses import JSONResponse

SCOPE_DENIED_REASON = "session.scope_denied"

# (metodo, modello di percorso con i placeholder delle rotte FastAPI).
# L'elenco è di ciò che è PERMESSO: niente scorciatoie «blocco solo le
# pericolose».
REMOTE_SCOPE_ALLOWLIST: tuple[tuple[str, str], ...] = (
    # Replica del progetto condiviso (peers/replication.py: snapshot + eventi)
    ("GET", "/v1/workspaces/{workspace_id}/remote/snapshot"),
    ("GET", "/v1/workspaces/{workspace_id}/remote/events"),
    # Outbox dei comandi remoti (peers/outbox.py); i tipi ammessi li limita
    # identity/remote_commands.py REMOTE_ALLOWED_COMMANDS
    ("POST", "/v1/workspaces/{workspace_id}/remote/commands"),
    # Progetti visibili alla persona (peers/cli.py): filtrati dai grant reali
    ("GET", "/v1/workspaces/{workspace_id}/projects"),
    # Deleghe assegnate a questa persona (peers/cli.py)
    ("GET", "/v1/workspaces/{workspace_id}/remote/assignments"),
    ("GET", "/v1/workspaces/{workspace_id}/remote/assignments/{assignment_id}"),
    ("POST", "/v1/workspaces/{workspace_id}/remote/assignments/{assignment_id}/accept"),
    ("POST", "/v1/workspaces/{workspace_id}/remote/assignments/{assignment_id}/return"),
    ("POST", "/v1/workspaces/{workspace_id}/remote/assignments/{assignment_id}/reconcile"),
    # Trasferimento oggetti cifrati fra peer (identity/object_transfer.py):
    # grant + recipient wrap + firma del publisher verificate dalla rotta
    ("POST", "/v1/workspaces/{workspace_id}/remote/objects"),
    ("GET", "/v1/workspaces/{workspace_id}/remote/objects"),
    ("GET", "/v1/workspaces/{workspace_id}/remote/objects/{object_id}/versions/{version}"),
    ("PUT", "/v1/workspaces/{workspace_id}/remote/objects/{object_id}/versions/{version}/chunks/{index}"),
    ("GET", "/v1/workspaces/{workspace_id}/remote/objects/{object_id}/versions/{version}/chunks/{index}"),
)

# Un placeholder corrisponde a UN segmento di percorso, niente di più.
_SEGMENT = r"[^/]+"


def _compile(template: str) -> re.Pattern[str]:
    pattern = "/".join(
        _SEGMENT if part.startswith("{") and part.endswith("}") else re.escape(part)
        for part in template.split("/")
    )
    return re.compile(f"^{pattern}$")


_COMPILED = tuple(
    (method, _compile(template)) for method, template in REMOTE_SCOPE_ALLOWLIST
)


def is_remote_scope_allowed(method: str, path: str) -> bool:
    """True se (metodo, percorso) è nell'elenco delle rotte remote."""
    return any(m == method and p.fullmatch(path) for m, p in _COMPILED)


def scope_denied_response() -> JSONResponse:
    """Il 403 neutro dell'ambito: la frase per la persona arriva dal catalogo
    condiviso (contracts/i18n), chiave ``session.scope_denied``."""
    return JSONResponse(
        status_code=403,
        content={"detail": {
            "code": "permission_denied",
            "reason": SCOPE_DENIED_REASON,
            "message": "This session may only access the shared remote routes",
        }},
    )
