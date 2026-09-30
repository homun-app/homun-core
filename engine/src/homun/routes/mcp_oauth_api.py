"""OAuth endpoints for hosted MCP connectors (browser round trip)."""
from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import HTMLResponse

from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/mcp", tags=["mcp-oauth"])


@router.post("/connectors/{server_id}/oauth/start")
def start_oauth(workspace_id: str, server_id: str, request: Request,
                x_homun_actor_id: str | None = Header(default=None),
                x_homun_actor_name: str | None = Header(default=None)):
    """Discover + register + authorize URL; the caller opens it in a browser."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    base = str(request.base_url).rstrip("/")
    redirect_uri = f"{base}/v1/workspaces/{workspace_id}/mcp/oauth/callback"
    try:
        from homun.application.mcp_oauth import start_hosted_flow
        return start_hosted_flow(ctx, actor, server_id, redirect_uri)
    except RuntimeError as exc:
        raise _http_error(DomainError(str(exc))) from exc
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get("/oauth/callback", response_class=HTMLResponse)
def oauth_callback(workspace_id: str, request: Request,
                   state: str = Query(default=""), code: str = Query(default=""),
                   error: str = Query(default=""),
                   error_description: str = Query(default="")):
    """Browser landing: exchange the code and tell the human what happened."""
    ctx, _actor = request_context(workspace_id, "person_local", "OAuth callback")
    if error:
        return HTMLResponse(_page("❌ Autorizzazione negata",
                                  f"{error}: {error_description}" or error), status_code=200)
    if not state or not code:
        return HTMLResponse(_page("❌ Callback incompleta", "Mancano state o code."))
    try:
        from homun.application.mcp_oauth import complete_hosted_flow
        result = complete_hosted_flow(ctx, state, code)
        return HTMLResponse(_page(
            "✅ Connettore collegato",
            f"Il connettore {result['server_id']} è ora autorizzato. "
            "Puoi chiudere questa finestra e tornare su Homun."))
    except RuntimeError as exc:
        return HTMLResponse(_page("❌ Collegamento non riuscito", str(exc)))


@router.get("/connectors/{server_id}/oauth/status")
def oauth_status(workspace_id: str, server_id: str,
                 x_homun_actor_id: str | None = Header(default=None),
                 x_homun_actor_name: str | None = Header(default=None)):
    ctx, _actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.application.mcp_oauth import hosted_connection_status
    return hosted_connection_status(ctx, server_id)


def _page(title: str, message: str) -> str:
    return f"""<!doctype html><html lang="it"><head><meta charset="utf-8">
<title>{title}</title><style>
body{{font-family:-apple-system,system-ui,sans-serif;background:#edf2e7;margin:0;
display:grid;place-items:center;min-height:100vh;color:#1c2d22}}
.card{{background:#fff;border:1px solid #dce4d5;border-radius:14px;padding:32px 40px;
max-width:520px;text-align:center}} h1{{font-size:18px;margin:0 0 12px}} p{{font-size:14px;
color:#647a6d;line-height:1.5;margin:0}}
</style></head><body><div class="card"><h1>{title}</h1><p>{message}</p></div></body></html>"""


@router.get("/connectors")
def list_connectors(workspace_id: str,
                    x_homun_actor_id: str | None = Header(default=None),
                    x_homun_actor_name: str | None = Header(default=None)):
    """Catalogo dei connettori hosted + stato di collegamento nel workspace."""
    ctx, _actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.application.mcp_connectors_catalog import HOSTED_CONNECTORS
    from homun.application.mcp_oauth import hosted_connection_status
    store = ctx.repository.load()
    by_name = {s.name.lower(): s for s in store.external_servers.values()}
    items = []
    for entry in HOSTED_CONNECTORS:
        server = by_name.get(entry["name"].lower())
        status = hosted_connection_status(ctx, server.id) if server else None
        items.append({
            "name": entry["name"], "description": entry["description"],
            "url": entry["url"], "keywords": entry["keywords"],
            "server_id": server.id if server else None,
            "connected": bool(status and status.get("connected")),
            "declared": server is not None,
        })
    return {"items": items}


@router.post("/connectors/{name}/install")
def install_connector(workspace_id: str, name: str,
                      x_homun_actor_id: str | None = Header(default=None),
                      x_homun_actor_name: str | None = Header(default=None)):
    """Dichiara il server del connettore nel workspace (http + url del catalogo)."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.application.mcp_connectors_catalog import HOSTED_CONNECTORS
    entry = next((c for c in HOSTED_CONNECTORS if c["name"] == name), None)
    if entry is None:
        raise _http_error(DomainError(f"Connettore sconosciuto: {name}"))
    try:
        result = ctx.service.apply(actor, f"connector-install:{name}", "external.create", {
            "name": entry["name"], "transport": "http", "url": entry["url"],
            "args": [], "tools_include": [], "tools_exclude": [],
        })
        return {"server_id": result["server_id"], "name": name}
    except DomainError as exc:
        raise _http_error(exc) from exc
