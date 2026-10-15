"""Persistent workspace language preference.

The client sets it when the user changes language; the engine uses it ONLY
for texts it generates by itself (intake labels, channels, chat). HTTP error
bodies stay neutral (docs/development/2026-10-15-errori-multilingua.md §3).
"""
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.ops.preferences import get_language, resolve_language, set_language
from homun.context import create_context
from homun.domain.errors import ValidationError
from homun.i18n import SUPPORTED_LANGUAGES


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    yield ctx
    ctx.close()


def test_default_language_is_italian_and_set_persists(ctx):
    assert get_language(ctx) == "it"
    set_language(ctx, "en")
    assert get_language(ctx) == "en"


def test_preference_survives_repository_reload(ctx, tmp_path):
    set_language(ctx, "en")
    db_path = ctx.repository.path
    ctx.close()

    reopened = create_context(db_path=db_path, data_dir=tmp_path, for_tests=True)
    try:
        assert get_language(reopened) == "en"
    finally:
        reopened.close()


def test_set_language_rejects_unknown_language_with_reason(ctx):
    with pytest.raises(ValidationError) as excinfo:
        set_language(ctx, "klingon")
    assert excinfo.value.reason == "preferences.language_invalid"
    assert excinfo.value.params == {"language": "klingon"}


def test_resolve_language_prefers_request_then_workspace(ctx):
    set_language(ctx, "en")
    assert resolve_language(ctx, None) == "en"
    assert resolve_language(ctx, "it") == "it"


def test_language_route_roundtrip_and_validation(ctx, monkeypatch):
    from homun.routes import preferences

    monkeypatch.setattr(preferences, "get_context", lambda: ctx)
    client = TestClient(create_app(session_token="t" * 32, session_actor_id="person_owner"))
    headers = {"Authorization": "Bearer " + "t" * 32}
    base = f"/v1/workspaces/{ctx.workspace_id}/language"

    assert client.get(base, headers=headers).json() == {"language": "it"}
    response = client.put(base, headers=headers, json={"language": "en"})
    assert response.status_code == 200, response.text
    assert response.json() == {"language": "en"}
    assert client.get(base, headers=headers).json() == {"language": "en"}

    invalid = client.put(base, headers=headers, json={"language": "fr"})
    assert invalid.status_code == 400
    assert invalid.json()["detail"]["reason"] == "preferences.language_invalid"

    unknown_ws = client.get(f"/v1/workspaces/other/language", headers=headers)
    assert unknown_ws.status_code == 404
    assert unknown_ws.json()["detail"]["reason"] == "workspace.unknown"


def test_supported_languages_are_it_and_en():
    assert SUPPORTED_LANGUAGES == ("it", "en")
