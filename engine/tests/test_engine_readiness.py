import sqlite3

from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.runtime import dbos_app
from homun.runtime.capabilities import get_capabilities


def test_runtime_capability_requires_launched_runtime(monkeypatch):
    monkeypatch.setattr(dbos_app, 'is_launched', lambda: False)
    assert get_capabilities()['features']['runtime'] is False
    monkeypatch.setattr(dbos_app, 'is_launched', lambda: True)
    assert get_capabilities()['features']['runtime'] is True


def test_sqlite_failure_has_typed_transport_error(tmp_path, monkeypatch):
    ctx = create_context(db_path=tmp_path/'ws.db', data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    try:
        def unavailable():
            raise sqlite3.OperationalError('private internal database path')
        monkeypatch.setattr(ctx.repository, 'load', unavailable)
        client = TestClient(create_app(), raise_server_exceptions=False)
        response = client.get('/v1/workspaces/ws_local/conversations')
        assert response.status_code == 503
        assert response.json()['detail']['code'] == 'storage_unavailable'
        assert 'private internal' not in response.text
    finally:
        reset_context_for_tests(None)
