"""Tests for D2 (MCP/plugins/providers: interactive OAuth, elicitation, pre-tool hooks, provider catalog)."""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from homun.application.mcp_client import (
    install_product_elicitation,
    set_elicitation_callback,
)
from homun.application.mcp_oauth import MCPOAuthBroker, OAuthToken
from homun.application.plugin_manager import PluginManager, reset_plugin_manager
from homun.domain.models import ExternalServer
from homun.models.registry import ModelRegistry


class MockOAuthTokenServer:
    def __init__(self):
        self.requests = []
        self.server = None
        self.thread = None

    def start(self, handler_fn):
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length) if length > 0 else b""
                parent.requests.append({
                    "method": "POST",
                    "path": self.path,
                    "headers": dict(self.headers),
                    "body": body,
                })
                status, headers, resp_body = handler_fn("POST", self.path, dict(self.headers), body)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp_body)

            def log_message(self, *a):
                return None

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        port = self.server.server_address[1]
        return f"http://127.0.0.1:{port}"

    def stop(self):
        if self.server:
            self.server.shutdown()
        if self.thread:
            self.thread.join(timeout=2)


@pytest.fixture
def mock_oauth_server():
    srv = MockOAuthTokenServer()
    yield srv
    srv.stop()


# ---------------------------------------------------------------------------
# 1. Interactive OAuth2 with PKCE
# ---------------------------------------------------------------------------

def test_pkce_generation_and_authorization_url():
    broker = MCPOAuthBroker()
    verifier, challenge = broker.generate_pkce()
    assert len(verifier) >= 43
    assert len(challenge) >= 43
    assert verifier != challenge

    server = ExternalServer(
        id="srv-github",
        workspace_id="ws_test",
        name="GitHub MCP",
        transport="sse",
        url="https://api.example.com",
        oauth_client_id="client_123",
        oauth_authorization_url="https://auth.example.com/oauth/authorize",
        oauth_scopes=["read:user", "repo"],
    )

    auth_url = broker.get_authorization_url(
        server,
        redirect_uri="http://localhost:8765/callback",
        state="xyz_state",
        code_challenge=challenge,
    )
    assert "https://auth.example.com/oauth/authorize?" in auth_url
    assert "client_id=client_123" in auth_url
    assert "response_type=code" in auth_url
    assert "redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fcallback" in auth_url
    assert "state=xyz_state" in auth_url
    assert f"code_challenge={challenge}" in auth_url
    assert "code_challenge_method=S256" in auth_url
    assert "scope=read%3Auser+repo" in auth_url


def test_authorization_url_missing_url_raises_backend_unavailable():
    broker = MCPOAuthBroker()
    server = ExternalServer(
        id="srv-no-auth",
        workspace_id="ws_test",
        name="No Auth URL",
        transport="sse",
        url="https://api.example.com",
    )
    with pytest.raises(RuntimeError, match="code=backend_unavailable"):
        broker.get_authorization_url(server, "http://localhost/cb", "state", "challenge")


def test_authorization_code_exchange(mock_oauth_server):
    def handle_token(method, path, headers, body):
        import urllib.parse
        data = urllib.parse.parse_qs(body.decode("utf-8"))
        assert data["grant_type"] == ["authorization_code"]
        assert data["code"] == ["test_auth_code"]
        assert data["code_verifier"] == ["test_code_verifier"]
        assert data["redirect_uri"] == ["http://localhost:8765/cb"]
        assert data["client_id"] == ["cid_456"]
        resp = {
            "access_token": "acc_tok_999",
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": "ref_tok_999",
        }
        return 200, {"Content-Type": "application/json"}, json.dumps(resp).encode("utf-8")

    token_url = mock_oauth_server.start(handle_token)

    server = ExternalServer(
        id="srv-exchange",
        workspace_id="ws_test",
        name="Exchange Server",
        transport="sse",
        url="https://api.example.com",
        oauth_client_id="cid_456",
        oauth_token_url=token_url,
    )

    broker = MCPOAuthBroker()
    token = broker.exchange_authorization_code(
        server,
        code="test_auth_code",
        code_verifier="test_code_verifier",
        redirect_uri="http://localhost:8765/cb",
    )
    assert token.access_token == "acc_tok_999"
    assert token.refresh_token == "ref_tok_999"
    assert token.expires_at is not None

    # Cached
    assert broker.get_access_token(server) == "acc_tok_999"


# ---------------------------------------------------------------------------
# 2. MCP Elicitation Handler Installation
# ---------------------------------------------------------------------------

def test_mcp_elicitation_callback_wiring(monkeypatch):
    monkeypatch.setenv("HOMUN_MCP_ELICITATION", "1")
    called = []

    async def custom_elicit(context, params):
        called.append(params)
        return {"status": "consented"}

    try:
        install_product_elicitation(custom_elicit)
        import anyio
        from homun.application import mcp_client

        async def run_probe():
            cb = mcp_client._elicitation_callback
            assert cb is not None
            res = await cb(None, "elicit_params_probe")
            assert res == {"status": "consented"}

        anyio.run(run_probe)
        assert len(called) == 1
    finally:
        set_elicitation_callback(None)


# ---------------------------------------------------------------------------
# 3. Pre-Tool Call Hooks Enforcement
# ---------------------------------------------------------------------------

def test_pre_tool_call_hook_blocks_and_allows_tool(tmp_path):
    reset_plugin_manager()
    pm = PluginManager(base_dir=tmp_path / "plugins")

    hook_calls = []

    def sample_hook(tool_name, arguments, **kwargs):
        hook_calls.append((tool_name, arguments))
        if tool_name == "forbidden_tool":
            return {"action": "block", "message": "Operation forbidden by security plugin."}
        return {"action": "allow"}

    # Register hook manually
    from homun.application.plugin_contracts import PluginManifest
    fake_manifest = PluginManifest(name="sec_plugin", version="1.0.0", description="Security")
    pm._plugins["sec_plugin"] = type("Loaded", (), {"manifest": fake_manifest, "enabled": True})()
    pm._register_hook(fake_manifest, "pre_tool_call", sample_hook)

    # Test hook dispatch directly
    hook_res = pm.dispatch_hook("pre_tool_call", tool_name="forbidden_tool", arguments={"x": 1})
    assert len(hook_res) == 1
    assert hook_res[0]["action"] == "block"
    assert "Operation forbidden" in hook_res[0]["message"]

    # 3. Allowed tool
    hook_res_allow = pm.dispatch_hook("pre_tool_call", tool_name="allowed_tool", arguments={})
    assert len(hook_res_allow) == 1
    assert hook_res_allow[0]["action"] == "allow"


# ---------------------------------------------------------------------------
# 4. Provider Registry in ModelsRegistry
# ---------------------------------------------------------------------------

def test_models_registry_lists_provider_catalog_profiles(tmp_path):
    registry = ModelRegistry(data_dir=tmp_path)

    providers = registry.list_providers()
    provider_ids = {p.id for p in providers}

    # Verify that standard built-in profiles are now available
    assert "fake" in provider_ids
    assert "openai_compatible" in provider_ids
    assert "anthropic" in provider_ids
    assert "openrouter" in provider_ids
    assert "gemini" in provider_ids
    assert "deepseek" in provider_ids

    # Set active provider
    registry.set_active_provider("anthropic")
    assert registry.active_provider_id == "anthropic"
    assert registry.active.provider_id == "anthropic"
