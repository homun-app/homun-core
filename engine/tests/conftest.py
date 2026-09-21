"""Never read or modify the developer's real Keychain in automated tests."""
import pytest


@pytest.fixture(autouse=True)
def isolate_workspace_keys(monkeypatch):
    monkeypatch.delenv('HOMUN_WORKSPACE_KEY_FILE', raising=False)
    monkeypatch.setattr('homun.storage.encryption._keychain_available', lambda: False)
    def forbidden(*args, **kwargs):
        raise AssertionError('Tests must mock Keychain access explicitly')
    monkeypatch.setattr('homun.storage.encryption._keychain_read', forbidden)
    monkeypatch.setattr('homun.storage.encryption._keychain_write', forbidden)
