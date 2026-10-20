"""B7: l'identità approvata di un trasporto è (connection_id, endpoint, kind reale).

Il nome o l'id scelti dalla persona per una connessione (per esempio
``golden_local``) non devono mai essere scambiati per il kind del trasporto:
il run adattivo e la chat con quella connessione devono partire. Il controllo
di sicurezza resta: un trasporto diverso da quello approvato — altro endpoint,
altra connessione — viene comunque rifiutato.
"""
import logging

import pytest

from homun.models.registry import ModelRegistry
from homun.models.secrets import MemorySecretStore
from homun.models.types import ChatMessage

# fixture riusate: server HTTP locali che registrano le richieste ricevute
from test_session_runtime_preferences import local_model_http, second_local_model_http


def _registry_with(tmp_path, url, *, connection_id="golden_local", model="provider-resolved-alias"):
    registry = ModelRegistry(data_dir=tmp_path, secrets=MemorySecretStore())
    registry.upsert_connection(
        connection_id=connection_id,
        kind="openai_compatible",
        display_name="La mia connessione",
        model_id=model,
        base_url=url,
    )
    return registry


@pytest.mark.parametrize("method", ["complete", "complete_tools"])
def test_user_named_connection_binds_approved_transport(tmp_path, local_model_http, method):
    """Una connessione creata dalla persona con un id suo arriva al trasporto:
    l'id della connessione non è il kind e non deve far rifiutare il run."""
    from homun.application.agent.runtime_selection import resolve
    from homun.models.native_turn import NativeMessage

    url, seen = local_model_http
    registry = _registry_with(tmp_path, url)
    expected = resolve(registry, connection_id="golden_local")
    assert expected["kind"] == "openai_compatible"
    messages = ([ChatMessage(role="user", content="Hello")] if method == "complete"
                else [NativeMessage(role="user", content="Hello")])
    if method == "complete":
        result = registry.complete(messages, connection_id="golden_local",
                                   expected_runtime=expected)
        assert result.text == "Done"
    else:
        result = registry.complete_tools(messages, connection_id="golden_local",
                                         expected_runtime=expected)
        assert result.message.content == "Done"
    assert seen and seen[0][0]["model"] == "provider-resolved-alias"


def test_transport_with_different_endpoint_is_still_rejected(tmp_path, local_model_http,
                                                             second_local_model_http):
    """Il controllo di sicurezza resta: dopo l'approvazione, un endpoint
    diverso viene rifiutato senza effettuare chiamate."""
    from homun.application.agent.runtime_selection import resolve
    from homun.domain.errors import ConflictError

    url, seen = local_model_http
    other_url, other_seen = second_local_model_http
    registry = _registry_with(tmp_path, url)
    expected = resolve(registry, connection_id="golden_local")
    registry.upsert_connection(connection_id="golden_local", kind="openai_compatible",
                               display_name="La mia connessione",
                               model_id="provider-resolved-alias", base_url=other_url)
    with pytest.raises(ConflictError):
        registry.complete([ChatMessage(role="user", content="Hello")],
                           connection_id="golden_local", expected_runtime=expected)
    assert not seen and not other_seen


def test_transport_of_another_connection_is_still_rejected(tmp_path, local_model_http,
                                                           second_local_model_http):
    """Un runtime approvato per una connessione non autorizza i trasporti di
    un'altra connessione, nemmeno a parità di kind."""
    from homun.application.agent.runtime_selection import resolve
    from homun.domain.errors import ConflictError

    url, seen = local_model_http
    other_url, _ = second_local_model_http
    registry = _registry_with(tmp_path, url)
    registry.upsert_connection(connection_id="altro-nome", kind="openai_compatible",
                               display_name="Altra connessione",
                               model_id="altro-modello", base_url=other_url)
    expected = resolve(registry, connection_id="altro-nome")
    with pytest.raises(ConflictError):
        registry.complete([ChatMessage(role="user", content="Hello")],
                           connection_id="golden_local", expected_runtime=expected)
    assert not seen


def test_unusable_connection_is_logged_and_listed_as_not_usable(tmp_path, local_model_http,
                                                                monkeypatch, caplog):
    """La costruzione fallita di un provider non è più silenziosa: log WARNING
    tipizzato e connessione visibile come non utilizzabile in Impostazioni."""
    from homun.models import registry as registry_module

    url, _ = local_model_http
    registry = _registry_with(tmp_path, url)
    real_provider = registry_module.OpenAICompatibleProvider

    class _BrokenForGolden:
        def __new__(cls, *args, **kwargs):
            if kwargs.get("provider_id") == "golden_local":
                raise RuntimeError("boom: bad base_url scheme")
            return real_provider(*args, **kwargs)

    monkeypatch.setattr(registry_module, "OpenAICompatibleProvider", _BrokenForGolden)
    with caplog.at_level(logging.WARNING, logger="homun.models.registry"):
        registry.upsert_connection(connection_id="golden_local", kind="openai_compatible",
                                   display_name="La mia connessione",
                                   model_id="m", base_url=url)
    assert any("provider_build_failed" in record.getMessage() for record in caplog.records)
    connection = registry.get_connection("golden_local")
    assert connection.configured is False
    assert any("non utilizzabile" in note for note in connection.notes)
