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


@pytest.fixture(autouse=True)
def clean_structured_fallback_memory():
    """The «route rejects tools» memory of the structured fallback is a module
    global keyed by (route, model): without a reset, a test that simulates the
    rejection poisons every later front-door turn of the suite (they would all
    fall back to structured output). One reset per test, like test_front_door
    always did locally for its own tests."""
    from homun.models import structured_fallback
    structured_fallback.reset_mode_memory()
    yield
    structured_fallback.reset_mode_memory()


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
