"""A configured credential is not evidence that a hosted tool executed."""
from fastapi.testclient import TestClient
from fastapi import FastAPI
from homun.routes.alternate_runtimes import router
from homun.application.managed_tool_gateway import ManagedToolGateway, ManagedToolGatewayConfig


def test_configured_route_without_transport_is_unavailable(monkeypatch):
    monkeypatch.setenv('TOOL_GATEWAY_USER_TOKEN', 'fixture-secret')
    monkeypatch.setenv('TOOL_GATEWAY_ORIGIN', 'http://127.0.0.1:1')
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        status = client.get('/v1/runtimes/status').json()['managed_tool_gateway']
        assert status['active'] is False
        assert status['configured'] is True
        response = client.post('/v1/runtimes/tool-gateway/invoke',
            json={'tool_name':'weather', 'arguments':{'city':'Milan'}})
    assert response.status_code == 200
    result = response.json()
    assert result['success'] is False
    assert result['result'] is None
    assert result['error_code'] == 'tool_gateway_unavailable'
    assert 'fixture-secret' not in response.text


def test_injected_transport_does_not_bypass_credentials():
    gateway = ManagedToolGateway(ManagedToolGatewayConfig('fixture', 'http://127.0.0.1:1'))
    calls = []
    result = gateway.invoke_tool('write', {}, http_dispatcher=lambda *args: calls.append(args))
    assert not calls
    assert result.success is False
    assert result.error_code == 'tool_gateway_unconfigured'


def test_transport_failure_never_exposes_credentials_or_claims_effect():
    gateway = ManagedToolGateway(ManagedToolGatewayConfig('fixture', 'http://127.0.0.1:1', 'fixture-secret', True))
    def fail(*args):
        raise RuntimeError('Authorization: Bearer fixture-secret')
    result = gateway.invoke_tool('write', {}, http_dispatcher=fail)
    assert result.success is False
    assert result.result is None
    assert result.error_code == 'tool_gateway_outcome_unknown'
    assert 'fixture-secret' not in result.error
