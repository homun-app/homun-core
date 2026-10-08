"""Never read or modify the developer's real Keychain in automated tests."""
import socket
import pytest


@pytest.fixture(autouse=True)
def isolate_workspace_keys(monkeypatch):
    monkeypatch.delenv('HOMUN_WORKSPACE_KEY_FILE', raising=False)
    monkeypatch.setattr('homun.storage.encryption._keychain_available', lambda: False)
    def forbidden(*args, **kwargs):
        raise AssertionError('Tests must mock Keychain access explicitly')
    monkeypatch.setattr('homun.storage.encryption._keychain_read', forbidden)
    monkeypatch.setattr('homun.storage.encryption._keychain_write', forbidden)


def local_provider_available() -> bool:
    """Un provider modello locale (es. Ollama su 11434) è raggiungibile?

    I runner CI non ne hanno uno: i test che esercitano summary e batch
    con un provider reale si saltano lì, e girano dove il provider c'è."""
    try:
        with socket.create_connection(('127.0.0.1', 11434), timeout=0.5):
            return True
    except OSError:
        return False


requires_local_provider = pytest.mark.skipif(
    not local_provider_available(),
    reason='richiede un provider modello locale (Ollama) non presente sui runner CI')
