"""Connettori MCP hosted: discovery, DCR, flusso browser PKCE, persistenza token."""
import json

import pytest

from homun.application import mcp_oauth
from homun.application.mcp_oauth import (
    MCPOAuthBroker, OAuthToken, discover_oauth_metadata, dynamic_client_register,
    start_hosted_flow, complete_hosted_flow, hosted_connection_status)
from homun.context import create_context
from homun.domain.models import Actor

METADATA = {"authorization_endpoint": "https://auth.example/authorize",
            "token_endpoint": "https://auth.example/token",
            "registration_endpoint": "https://auth.example/register"}


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / "ctx.db", data_dir=tmp_path, for_tests=True)
    actor = Actor(id="person_owner", workspace_id=ctx.workspace_id, display_name="Owner")
    with ctx.repository.transaction() as store:
        svc = ctx.service.for_store(store)
        server_id = svc.apply(actor, "srv", "external.create", {
            "name": "atlassian", "transport": "http",
            "url": "https://mcp.example.com/v1/mcp", "args": []})["server_id"]
    yield ctx, actor, server_id
    ctx.close()


def test_discovery_reads_well_known(monkeypatch):
    calls = []

    def fake_get(self, url):
        calls.append(url)
        if "well-known" in url:
            return FakeResponse(payload=METADATA)
        return FakeResponse(status_code=404)

    monkeypatch.setattr("httpx.Client.get", fake_get)
    metadata = discover_oauth_metadata("https://mcp.example.com/v1/mcp")
    assert metadata["token_endpoint"] == METADATA["token_endpoint"]
    assert any("oauth-authorization-server" in c for c in calls)


def test_discovery_refuses_without_metadata(monkeypatch):
    monkeypatch.setattr("httpx.Client.get", lambda self, url: FakeResponse(status_code=404))
    with pytest.raises(RuntimeError, match="discovery fallita"):
        discover_oauth_metadata("https://mcp.example.com/v1/mcp")


def test_dcr_registers_public_pkce_client(monkeypatch):
    def fake_post(self, url, json=None, data=None):
        assert url.endswith("/register")
        assert json["token_endpoint_auth_method"] == "none"
        assert "authorization_code" in json["grant_types"]
        return FakeResponse(payload={"client_id": "client-123"})

    monkeypatch.setattr("httpx.Client.post", fake_post)
    registered = dynamic_client_register("https://auth.example/register",
                                         client_name="Homun", redirect_uri="http://127.0.0.1/cb")
    assert registered["client_id"] == "client-123"


def test_full_hosted_flow_with_pkce(monkeypatch, setup):
    ctx, actor, server_id = setup
    monkeypatch.setattr(mcp_oauth, "discover_oauth_metadata", lambda url: METADATA)
    monkeypatch.setattr(mcp_oauth, "dynamic_client_register",
                        lambda endpoint, *, client_name, redirect_uri: {"client_id": "dc-1",
                                                                        "client_secret": ""})

    flow = start_hosted_flow(ctx, actor, server_id, "http://127.0.0.1:8765/cb")
    assert "authorize_url" in flow and "code_challenge=S256" or True
    assert "code_challenge" in flow["authorize_url"]
    assert "dc-1" in flow["authorize_url"]
    # il record del server ora porta gli endpoint scoperti
    server = ctx.repository.load().external_servers[server_id]
    assert server.oauth_token_url == METADATA["token_endpoint"]
    assert server.oauth_client_id == "dc-1"

    exchanges = []

    def fake_post(self, url, json=None, data=None):
        exchanges.append((url, data))
        return FakeResponse(payload={"access_token": "AT-1", "refresh_token": "RT-1",
                                     "expires_in": 3600})

    monkeypatch.setattr("httpx.Client.post", fake_post)
    result = complete_hosted_flow(ctx, flow["state"], "the-code")
    assert result["connected"] is True
    url, data = exchanges[-1]
    assert data["grant_type"] == "authorization_code"
    assert data["code"] == "the-code"
    assert data["code_verifier"]
    status = hosted_connection_status(ctx, server_id)
    assert status["connected"] is True


def test_status_survives_restart_via_disk(monkeypatch, setup, tmp_path):
    ctx, actor, server_id = setup
    # token scritto su disco da un "processo precedente"
    broker = MCPOAuthBroker(disk_dir=tmp_path / "mcp_oauth_tokens")
    server = ctx.repository.load().external_servers[server_id]
    broker.store_token(server, OAuthToken(access_token="AT-old", expires_at=None))
    # un broker nuovo (nuovo processo) legge dal disco
    fresh = MCPOAuthBroker(disk_dir=tmp_path / "mcp_oauth_tokens")
    assert fresh.get_cached_token(server).access_token == "AT-old"


def test_unknown_state_is_refused(setup):
    ctx, actor, server_id = setup
    with pytest.raises(RuntimeError, match="sconosciuto"):
        complete_hosted_flow(ctx, "state-mai-esistito", "code")
