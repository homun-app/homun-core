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

    def __init__(self, cache: Optional[Dict[str, OAuthToken]] = None) -> None:
        self._cache: Dict[str, OAuthToken] = cache if cache is not None else {}

    def cache_key(self, server: ExternalServer) -> str:
        client_id = str(getattr(server, "oauth_client_id", "") or "").strip()
        token_url = str(getattr(server, "oauth_token_url", "") or "").strip()
        return f"{server.id}:{token_url}:{client_id}"

    def get_cached_token(self, server: ExternalServer) -> Optional[OAuthToken]:
        key = self.cache_key(server)
        token = self._cache.get(key)
        if token and not token.is_expired():
            return token
        return None

    def store_token(self, server: ExternalServer, token: OAuthToken) -> None:
        key = self.cache_key(server)
        self._cache[key] = token

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


_DEFAULT_BROKER = MCPOAuthBroker()


def get_mcp_oauth_broker() -> MCPOAuthBroker:
    return _DEFAULT_BROKER
