"""Unit tests for MCP OAuth Token Broker (H36)."""
import time
import pytest

from homun.domain.models import ExternalServer
from homun.application.mcp_oauth import MCPOAuthBroker, OAuthToken, get_mcp_oauth_broker


def test_mcp_oauth_refuses_without_credentials():
    broker = MCPOAuthBroker()
    server = ExternalServer(
        id="srv1",
        workspace_id="ws",
        name="test-server",
        transport="http",
        url="https://example.com/mcp",
        oauth_client_id="cid_123",
        oauth_token_url="https://example.com/oauth/token",
    )
    with pytest.raises(RuntimeError) as exc_info:
        broker.get_access_token(server)
    assert "code=backend_unavailable" in str(exc_info.value)
    assert "no client secret, refresh token, or pre-authorized grant" in str(exc_info.value)


def test_mcp_oauth_client_credentials_flow(monkeypatch):
    calls = []

    class FakeResp:
        status_code = 200

        def json(self):
            return {
                "access_token": "token_abc_123",
                "token_type": "Bearer",
                "expires_in": 3600,
            }

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, data=None):
            calls.append((url, data))
            return FakeResp()

    monkeypatch.setattr("homun.application.mcp_oauth.httpx.Client", FakeClient)

    broker = MCPOAuthBroker()
    server = ExternalServer(
        id="srv_cred",
        workspace_id="ws",
        name="cred-server",
        transport="http",
        url="https://example.com/mcp",
        oauth_client_id="my_client",
        oauth_token_url="https://auth.example.com/token",
        oauth_scopes=["read", "write"],
        env={"OAUTH_CLIENT_SECRET": "secret_xyz"},
    )

    token = broker.get_access_token(server)
    assert token == "token_abc_123"
    assert len(calls) == 1
    assert calls[0][0] == "https://auth.example.com/token"
    assert calls[0][1]["grant_type"] == "client_credentials"
    assert calls[0][1]["client_id"] == "my_client"
    assert calls[0][1]["client_secret"] == "secret_xyz"
    assert calls[0][1]["scope"] == "read write"

    # Second call uses cache, no second HTTP call
    token2 = broker.get_access_token(server)
    assert token2 == "token_abc_123"
    assert len(calls) == 1


def test_mcp_oauth_expired_token_refetches(monkeypatch):
    calls = []

    class FakeResp:
        status_code = 200

        def json(self):
            return {
                "access_token": f"token_call_{len(calls)}",
                "token_type": "Bearer",
                "expires_in": 1,  # 1 second
            }

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, data=None):
            calls.append((url, data))
            return FakeResp()

    monkeypatch.setattr("homun.application.mcp_oauth.httpx.Client", FakeClient)

    broker = MCPOAuthBroker()
    server = ExternalServer(
        id="srv_exp",
        workspace_id="ws",
        name="exp-server",
        transport="http",
        url="https://example.com/mcp",
        oauth_client_id="cid",
        oauth_token_url="https://auth.example.com/token",
        env={"OAUTH_CLIENT_SECRET": "sec"},
    )

    # First fetch: expires in 1s (and is_expired buffer is 30s so immediately considered expired on next check)
    t1 = broker.get_access_token(server)
    assert t1 == "token_call_1"

    # Next call sees it expired and refetches
    t2 = broker.get_access_token(server)
    assert t2 == "token_call_2"
    assert len(calls) == 2


def test_mcp_oauth_refresh_token_grant(monkeypatch):
    calls = []

    class FakeResp:
        status_code = 200

        def json(self):
            return {
                "access_token": "new_refreshed_token",
                "refresh_token": "rotated_refresh_token",
                "expires_in": 7200,
            }

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, data=None):
            calls.append((url, data))
            return FakeResp()

    monkeypatch.setattr("homun.application.mcp_oauth.httpx.Client", FakeClient)

    broker = MCPOAuthBroker()
    server = ExternalServer(
        id="srv_ref",
        workspace_id="ws",
        name="ref-server",
        transport="http",
        url="https://example.com/mcp",
        oauth_client_id="cid",
        oauth_token_url="https://auth.example.com/token",
        env={"OAUTH_REFRESH_TOKEN": "initial_refresh_token"},
    )

    token = broker.get_access_token(server)
    assert token == "new_refreshed_token"
    assert len(calls) == 1
    assert calls[0][1]["grant_type"] == "refresh_token"
    assert calls[0][1]["refresh_token"] == "initial_refresh_token"


def test_mcp_oauth_endpoint_http_error(monkeypatch):
    class FakeResp:
        status_code = 401
        text = "Unauthorized client credentials"

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, data=None):
            return FakeResp()

    monkeypatch.setattr("homun.application.mcp_oauth.httpx.Client", FakeClient)

    broker = MCPOAuthBroker()
    server = ExternalServer(
        id="srv_err",
        workspace_id="ws",
        name="err-server",
        transport="http",
        url="https://example.com/mcp",
        oauth_client_id="bad_client",
        oauth_token_url="https://auth.example.com/token",
        env={"OAUTH_CLIENT_SECRET": "bad_secret"},
    )

    with pytest.raises(RuntimeError) as exc_info:
        broker.get_access_token(server)
    assert "code=backend_unavailable" in str(exc_info.value)
    assert "HTTP 401" in str(exc_info.value)


def test_mcp_oauth_direct_bearer_env(monkeypatch):
    monkeypatch.setenv("HOMUN_MCP_OAUTH_TOKEN", "bearer_direct_123")
    broker = MCPOAuthBroker()
    server = ExternalServer(
        id="srv_direct",
        workspace_id="ws",
        name="direct-server",
        transport="http",
        url="https://example.com/mcp",
        oauth_client_id="any",
        oauth_token_url="https://auth.example.com/token",
    )
    assert broker.get_access_token(server) == "bearer_direct_123"
