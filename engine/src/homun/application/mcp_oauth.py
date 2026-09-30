"""Real OAuth2 token broker for MCP servers (H36).

at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Manages OAuth tokens for declared external MCP servers:
- Executes client credentials grant (grant_type=client_credentials)
- Executes refresh token grant (grant_type=refresh_token)
- In-memory token caching with expiration tracking
- Explicit refusal when credentials or endpoints are unavailable (code=backend_unavailable).
No invented or mocked tokens are returned.
"""
from __future__ import annotations

from dataclasses import dataclass
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from homun.domain.models import ExternalServer

logger = logging.getLogger(__name__)


@dataclass
class OAuthToken:
    """Acquired OAuth2 token with metadata and expiry."""

    access_token: str
    token_type: str = "Bearer"
    expires_at: Optional[float] = None
    refresh_token: Optional[str] = None
    scope: Optional[str] = None

    def is_expired(self, buffer_seconds: float = 30.0) -> bool:
        if self.expires_at is None:
            return False
        return time.time() + buffer_seconds >= self.expires_at


class MCPOAuthBroker:
    """Manages real OAuth2 access tokens for external MCP servers."""

    def __init__(self, cache: Optional[Dict[str, OAuthToken]] = None,
                 disk_dir: Optional["Path"] = None) -> None:
        self._cache: Dict[str, OAuthToken] = cache if cache is not None else {}
        self._disk_dir = disk_dir
        self._disk_lock = __import__("threading").Lock()

    def _disk_path(self, server_id: str) -> "Path":
        return self._disk_dir / f"{server_id}.json"

    def _token_to_disk(self, server_id: str, token: OAuthToken) -> None:
        if self._disk_dir is None:
            return
        import json as _json
        self._disk_dir.mkdir(parents=True, exist_ok=True)
        payload = {"access_token": token.access_token, "token_type": token.token_type,
                   "expires_at": token.expires_at, "refresh_token": token.refresh_token,
                   "scope": token.scope}
        self._disk_path(server_id).write_text(_json.dumps(payload), encoding="utf-8")
        try:
            os.chmod(self._disk_path(server_id), 0o600)
        except OSError:
            pass

    def _token_from_disk(self, server_id: str) -> Optional[OAuthToken]:
        if self._disk_dir is None:
            return None
        path = self._disk_path(server_id)
        if not path.is_file():
            return None
        import json as _json
        try:
            data = _json.loads(path.read_text(encoding="utf-8"))
            return OAuthToken(access_token=str(data["access_token"]),
                              token_type=str(data.get("token_type") or "Bearer"),
                              expires_at=data.get("expires_at"),
                              refresh_token=data.get("refresh_token"),
                              scope=data.get("scope"))
        except Exception:
            logger.warning("MCP OAuth token on disk unreadable for %s", server_id, exc_info=True)
            return None

    def forget_disk_token(self, server_id: str) -> None:
        if self._disk_dir is not None:
            with self._disk_lock:
                self._disk_path(server_id).unlink(missing_ok=True)

    def cache_key(self, server: ExternalServer) -> str:
        client_id = str(getattr(server, "oauth_client_id", "") or "").strip()
        token_url = str(getattr(server, "oauth_token_url", "") or "").strip()
        return f"{server.id}:{token_url}:{client_id}"

    def get_cached_token(self, server: ExternalServer) -> Optional[OAuthToken]:
        key = self.cache_key(server)
        token = self._cache.get(key)
        if token and not token.is_expired():
            return token
        with self._disk_lock:
            disk = self._token_from_disk(server.id)
        if disk:
            self._cache[key] = disk
            if not disk.is_expired():
                return disk
        return None

    def store_token(self, server: ExternalServer, token: OAuthToken) -> None:
        key = self.cache_key(server)
        self._cache[key] = token
        self._token_to_disk(server.id, token)

    def clear_token(self, server: ExternalServer) -> None:
        key = self.cache_key(server)
        self._cache.pop(key, None)

    def get_access_token(self, server: ExternalServer) -> str:
        """Retrieve a valid access token for the server or obtain one via OAuth."""
        # 1. Check cache
        cached = self.get_cached_token(server)
        if cached:
            return cached.access_token

        # 2. Check for pre-configured direct token
        direct = (
            str(os.environ.get("HOMUN_MCP_OAUTH_TOKEN") or "").strip()
            or str(server.env.get("HOMUN_MCP_OAUTH_TOKEN") or "").strip()
            or str(server.env.get("OAUTH_TOKEN") or "").strip()
        )
        if direct:
            token_obj = OAuthToken(access_token=direct)
            self.store_token(server, token_obj)
            return direct

        client_id = str(getattr(server, "oauth_client_id", "") or "").strip()
        token_url = str(getattr(server, "oauth_token_url", "") or "").strip()
        scopes = getattr(server, "oauth_scopes", None) or []

        if not token_url:
            raise RuntimeError(
                f"MCP OAuth declared for server '{server.name}' but oauth_token_url is empty "
                "(code=backend_unavailable)"
            )

        # 3. Check for client secret / credentials
        srv_prefix = server.id.replace("-", "_").upper()
        client_secret = (
            str(server.headers.get("client_secret") or "").strip()
            or str(server.env.get("OAUTH_CLIENT_SECRET") or "").strip()
            or str(os.environ.get(f"HOMUN_MCP_OAUTH_{srv_prefix}_CLIENT_SECRET") or "").strip()
            or str(os.environ.get("HOMUN_MCP_OAUTH_CLIENT_SECRET") or "").strip()
            or str(os.environ.get("MCP_OAUTH_CLIENT_SECRET") or "").strip()
        )

        # 4. Check for refresh token (cached or environment)
        refresh_token = (
            (self._cache.get(self.cache_key(server)) and self._cache[self.cache_key(server)].refresh_token)
            or str(server.env.get("OAUTH_REFRESH_TOKEN") or "").strip()
            or str(os.environ.get(f"HOMUN_MCP_OAUTH_{srv_prefix}_REFRESH_TOKEN") or "").strip()
            or str(os.environ.get("HOMUN_MCP_OAUTH_REFRESH_TOKEN") or "").strip()
        )

        # 4a. Refresh token grant flow
        if refresh_token:
            refresh_data: Dict[str, Any] = {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            }
            if client_id:
                refresh_data["client_id"] = client_id
            if client_secret:
                refresh_data["client_secret"] = client_secret
            try:
                with httpx.Client(timeout=15.0) as client:
                    resp = client.post(token_url, data=refresh_data)
                if resp.status_code < 400:
                    data = resp.json()
                    new_access = data.get("access_token")
                    if new_access:
                        expires_in = data.get("expires_in")
                        expires_at = (time.time() + float(expires_in)) if expires_in is not None else None
                        new_refresh = data.get("refresh_token") or refresh_token
                        token_obj = OAuthToken(
                            access_token=str(new_access),
                            token_type=str(data.get("token_type") or "Bearer"),
                            expires_at=expires_at,
                            refresh_token=str(new_refresh) if new_refresh else None,
                            scope=data.get("scope"),
                        )
                        self.store_token(server, token_obj)
                        return token_obj.access_token
                logger.warning(
                    "MCP OAuth refresh token grant failed for %s (HTTP %s): %s",
                    server.name,
                    resp.status_code,
                    resp.text,
                )
            except Exception as exc:
                logger.warning("MCP OAuth refresh token exception for %s: %s", server.name, exc)

        # 4b. Client credentials grant flow
        if client_secret:
            cred_data: Dict[str, Any] = {
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            }
            if scopes:
                cred_data["scope"] = " ".join(scopes)
            try:
                with httpx.Client(timeout=15.0) as client:
                    resp = client.post(token_url, data=cred_data)
                if resp.status_code >= 400:
                    raise RuntimeError(
                        f"MCP OAuth token request to {token_url} failed with HTTP {resp.status_code}: {resp.text} "
                        "(code=backend_unavailable)"
                    )
                data = resp.json()
                access_token = data.get("access_token")
                if not access_token:
                    raise RuntimeError(
                        f"MCP OAuth token endpoint {token_url} returned response without access_token "
                        "(code=backend_unavailable)"
                    )
                expires_in = data.get("expires_in")
                expires_at = (time.time() + float(expires_in)) if expires_in is not None else None
                token_obj = OAuthToken(
                    access_token=str(access_token),
                    token_type=str(data.get("token_type") or "Bearer"),
                    expires_at=expires_at,
                    refresh_token=data.get("refresh_token"),
                    scope=data.get("scope"),
                )
                self.store_token(server, token_obj)
                return token_obj.access_token
            except Exception as exc:
                if "backend_unavailable" in str(exc):
                    raise
                raise RuntimeError(
                    f"MCP OAuth token request failed for server '{server.name}': {exc} "
                    "(code=backend_unavailable)"
                ) from exc

        # 5. Neither credentials nor active grant exists
        raise RuntimeError(
            f"MCP OAuth declared for server '{server.name}' but no client secret, refresh token, "
            "or pre-authorized grant is available (code=backend_unavailable)"
        )

    @staticmethod
    def generate_pkce() -> tuple[str, str]:
        """Generate RFC 7636 compliant (code_verifier, code_challenge) with S256."""
        import base64
        import hashlib
        import secrets

        verifier = secrets.token_urlsafe(64)
        digest = hashlib.sha256(verifier.encode("ascii")).digest()
        challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
        return verifier, challenge

    def get_authorization_url(
        self,
        server: ExternalServer,
        redirect_uri: str,
        state: str,
        code_challenge: str,
    ) -> str:
        """Build interactive browser authorization URL with PKCE challenge."""
        import urllib.parse

        auth_url = str(
            getattr(server, "oauth_authorization_url", "")
            or getattr(server, "oauth_auth_url", "")
            or server.env.get("OAUTH_AUTH_URL")
            or ""
        ).strip()
        if not auth_url:
            raise RuntimeError(
                f"Interactive OAuth declared for server '{server.name}' but oauth_authorization_url is not configured "
                "(code=backend_unavailable)"
            )
        client_id = str(getattr(server, "oauth_client_id", "") or "").strip()
        scopes = getattr(server, "oauth_scopes", None) or []

        params = {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        if scopes:
            params["scope"] = " ".join(scopes)
        sep = "&" if "?" in auth_url else "?"
        return f"{auth_url}{sep}{urllib.parse.urlencode(params)}"

    def exchange_authorization_code(
        self,
        server: ExternalServer,
        code: str,
        code_verifier: str,
        redirect_uri: str,
    ) -> OAuthToken:
        """Exchange authorization code with code_verifier for access and refresh tokens."""
        token_url = str(getattr(server, "oauth_token_url", "") or "").strip()
        if not token_url:
            raise RuntimeError(
                f"MCP OAuth token_url is missing for server '{server.name}' (code=backend_unavailable)"
            )
        client_id = str(getattr(server, "oauth_client_id", "") or "").strip()
        srv_prefix = server.id.replace("-", "_").upper()
        client_secret = (
            str(server.headers.get("client_secret") or "").strip()
            or str(server.env.get("OAUTH_CLIENT_SECRET") or "").strip()
            or str(os.environ.get(f"HOMUN_MCP_OAUTH_{srv_prefix}_CLIENT_SECRET") or "").strip()
            or str(os.environ.get("HOMUN_MCP_OAUTH_CLIENT_SECRET") or "").strip()
        )

        data: Dict[str, Any] = {
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
        }
        if client_id:
            data["client_id"] = client_id
        if client_secret:
            data["client_secret"] = client_secret

        try:
            with httpx.Client(timeout=15.0) as client:
                resp = client.post(token_url, data=data)
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"OAuth authorization code exchange failed with HTTP {resp.status_code}: {resp.text} "
                    "(code=backend_unavailable)"
                )
            res_data = resp.json()
            access_token = res_data.get("access_token")
            if not access_token:
                raise RuntimeError(
                    f"OAuth token response from {token_url} missing access_token (code=backend_unavailable)"
                )
            expires_in = res_data.get("expires_in")
            expires_at = (time.time() + float(expires_in)) if expires_in is not None else None
            token_obj = OAuthToken(
                access_token=str(access_token),
                token_type=str(res_data.get("token_type") or "Bearer"),
                expires_at=expires_at,
                refresh_token=res_data.get("refresh_token"),
                scope=res_data.get("scope"),
            )
            self.store_token(server, token_obj)
            return token_obj
        except Exception as exc:
            if "backend_unavailable" in str(exc):
                raise
            raise RuntimeError(
                f"OAuth code exchange failed for server '{server.name}': {exc} (code=backend_unavailable)"
            ) from exc


_DEFAULT_BROKER = MCPOAuthBroker()


def get_mcp_oauth_broker() -> MCPOAuthBroker:
    return _DEFAULT_BROKER



# ── Hosted remote-MCP connectors: discovery, DCR, interactive browser flow ──
# Mirrors the Hermes optional-mcps model: the vendor hosts the MCP, Homun
# only discovers its authorization server (RFC 8414), registers a public
# client via Dynamic Client Registration when allowed, and walks the person
# through an authorization-code + PKCE round trip in their browser.

PENDING_DIR_NAME = "mcp_oauth_pending"
TOKENS_DIR_NAME = "mcp_oauth_tokens"
METADATA_TIMEOUT = 15.0


def discover_oauth_metadata(server_url: str) -> Dict[str, str]:
    """RFC 8414 discovery for the authorization server behind an MCP URL."""
    from urllib.parse import urlsplit

    split = urlsplit(server_url)
    candidates = []
    for well_known in (
        f"{split.scheme}://{split.netloc}/.well-known/oauth-authorization-server{split.path}",
        f"{split.scheme}://{split.netloc}/.well-known/oauth-authorization-server",
    ):
        if well_known not in candidates:
            candidates.append(well_known.rstrip("/"))
    last_error = ""
    for candidate in candidates:
        try:
            with httpx.Client(timeout=METADATA_TIMEOUT, follow_redirects=True) as client:
                resp = client.get(candidate)
            if resp.status_code >= 400:
                last_error = f"{candidate} -> HTTP {resp.status_code}"
                continue
            data = resp.json()
            metadata = {
                "authorization_endpoint": str(data.get("authorization_endpoint") or ""),
                "token_endpoint": str(data.get("token_endpoint") or ""),
                "registration_endpoint": str(data.get("registration_endpoint") or ""),
            }
            if metadata["authorization_endpoint"] and metadata["token_endpoint"]:
                return metadata
            last_error = f"{candidate}: metadati incompleti"
        except Exception as exc:
            last_error = f"{candidate}: {exc}"
    raise RuntimeError(
        f"OAuth discovery fallita per {server_url} ({last_error}) (code=backend_unavailable)")


def dynamic_client_register(registration_endpoint: str, *, client_name: str,
                            redirect_uri: str) -> Dict[str, str]:
    """RFC 7591 Dynamic Client Registration for a public PKCE client."""
    payload = {
        "client_name": client_name,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "code_challenge_method": "S256",
    }
    try:
        with httpx.Client(timeout=METADATA_TIMEOUT, follow_redirects=True) as client:
            resp = client.post(registration_endpoint, json=payload)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"DCR rifiutata da {registration_endpoint} (HTTP {resp.status_code}): "
                f"{resp.text[:200]} (code=backend_unavailable)")
        data = resp.json()
        client_id = str(data.get("client_id") or "")
        if not client_id:
            raise RuntimeError("DCR senza client_id (code=backend_unavailable)")
        return {"client_id": client_id,
                "client_secret": str(data.get("client_secret") or "")}
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"DCR fallita: {exc} (code=backend_unavailable)") from exc


def _pending_dir(ctx) -> Path:
    path = ctx.data_dir / PENDING_DIR_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def _tokens_dir(ctx) -> Path:
    path = ctx.data_dir / TOKENS_DIR_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def start_hosted_flow(ctx, actor, server_id: str, redirect_uri: str) -> Dict[str, Any]:
    """Begin the browser flow for a hosted connector: discover, register, authorize URL."""
    import json as _json
    import secrets

    store = ctx.repository.load()
    server = store.external_servers.get(server_id)
    if server is None:
        raise RuntimeError(f"Server esterno non trovato: {server_id}")
    if getattr(actor, "kind", "person") != "person":
        raise RuntimeError("Solo una persona può collegare un connettore")

    metadata = discover_oauth_metadata(server.url)
    client_id = str(getattr(server, "oauth_client_id", "") or "").strip()
    client_secret = ""
    if not client_id:
        if not metadata.get("registration_endpoint"):
            raise RuntimeError(
                "Il server non espone la registrazione dinamica e il client_id non è "
                "configurato: serve un'app OAuth manuale (code=backend_unavailable)")
        registered = dynamic_client_register(
            metadata["registration_endpoint"], client_name=f"Homun ({server.name})",
            redirect_uri=redirect_uri)
        client_id = registered["client_id"]
        client_secret = registered["client_secret"]

    # aggiorna il record con gli endpoint scoperti/registrati (external.update)
    with ctx.repository.locked():
        with ctx.repository.transaction() as write_store:
            ctx.service.for_store(write_store).apply(actor, f"oauth-start:{server_id}:{secrets.token_hex(4)}",
                "external.update", {
                    "server_id": server_id, "expected_version": server.revision,
                    "oauth_client_id": client_id,
                    "oauth_authorization_url": metadata["authorization_endpoint"],
                    "oauth_token_url": metadata["token_endpoint"],
                })
        ctx.service.store = write_store

    code_verifier, code_challenge = MCPOAuthBroker.generate_pkce()
    state = secrets.token_urlsafe(24)
    pending = {
        "server_id": server_id, "state": state,
        "code_verifier": code_verifier, "redirect_uri": redirect_uri,
        "client_id": client_id, "client_secret": client_secret,
        "token_endpoint": metadata["token_endpoint"],
        "started_at": time.time(),
    }
    (_pending_dir(ctx) / f"{state}.json").write_text(_json.dumps(pending), encoding="utf-8")

    from urllib.parse import urlencode
    params = {
        "response_type": "code", "client_id": client_id,
        "redirect_uri": redirect_uri, "state": state,
        "code_challenge": code_challenge, "code_challenge_method": "S256",
    }
    sep = "&" if "?" in metadata["authorization_endpoint"] else "?"
    return {"authorize_url": f"{metadata['authorization_endpoint']}{sep}{urlencode(params)}",
            "server_id": server_id, "state": state}


def complete_hosted_flow(ctx, state: str, code: str) -> Dict[str, Any]:
    """Browser callback: exchange the code (PKCE) and persist the tokens."""
    import json as _json

    pending_path = _pending_dir(ctx) / f"{state}.json"
    if not pending_path.is_file():
        raise RuntimeError("Flusso OAuth sconosciuto o scaduto (state non riconosciuto)")
    pending = _json.loads(pending_path.read_text(encoding="utf-8"))
    store = ctx.repository.load()
    server = store.external_servers.get(pending["server_id"])
    if server is None:
        raise RuntimeError("Il connettore non esiste più")

    data = {
        "grant_type": "authorization_code", "code": code,
        "code_verifier": pending["code_verifier"],
        "redirect_uri": pending["redirect_uri"], "client_id": pending["client_id"],
    }
    if pending.get("client_secret"):
        data["client_secret"] = pending["client_secret"]
    with httpx.Client(timeout=METADATA_TIMEOUT) as client:
        resp = client.post(pending["token_endpoint"], data=data)
    if resp.status_code >= 400:
        raise RuntimeError(
            f"Scambio del codice fallito (HTTP {resp.status_code}): {resp.text[:200]} "
            "(code=backend_unavailable)")
    payload = resp.json()
    access = payload.get("access_token")
    if not access:
        raise RuntimeError("Risposta token senza access_token (code=backend_unavailable)")
    expires_in = payload.get("expires_in")
    token = OAuthToken(
        access_token=str(access), token_type=str(payload.get("token_type") or "Bearer"),
        expires_at=(time.time() + float(expires_in)) if expires_in is not None else None,
        refresh_token=payload.get("refresh_token"), scope=payload.get("scope"))
    broker = get_mcp_oauth_broker()
    broker._disk_dir = _tokens_dir(ctx)
    broker.store_token(server, token)
    pending_path.unlink(missing_ok=True)
    return {"server_id": server.id, "connected": True,
            "expires_at": token.expires_at, "scope": token.scope}


def hosted_connection_status(ctx, server_id: str) -> Dict[str, Any]:
    store = ctx.repository.load()
    server = store.external_servers.get(server_id)
    if server is None:
        return {"server_id": server_id, "connected": False, "declared": False}
    broker = get_mcp_oauth_broker()
    broker._disk_dir = _tokens_dir(ctx)
    token = broker.get_cached_token(server)
    return {"server_id": server_id, "declared": True, "connected": token is not None,
            "expires_at": token.expires_at if token else None,
            "interactive": bool(server.oauth_authorization_url or server.oauth_client_id)}
