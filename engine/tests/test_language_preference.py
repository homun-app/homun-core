"""Language as a person preference, with the workspace language as default.

Resolution chain: person → workspace → English
(docs/development/2026-10-15-errori-multilingua.md §3). The engine uses the
resolved language ONLY for texts it generates by itself (intake catalog
labels, channels, chat); HTTP error bodies stay neutral.
"""
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.ops.preferences import (
    person_language,
    resolve_language,
    set_person_language,
    set_workspace_language,
    workspace_language,
)
from homun.context import create_context
from homun.domain.errors import ValidationError
from homun.i18n import SUPPORTED_LANGUAGES, user_text


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    yield ctx
    ctx.close()


@pytest.fixture
def people(ctx):
    """An owner and two members of the same workspace."""
    from homun.domain.models import Actor, Person, utc_now

    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            service = ctx.service.for_store(store)
            service.apply(Actor(id="person_owner", workspace_id=ctx.workspace_id,
                                display_name="Owner"), "bootstrap:cmd1", "person.bootstrap", {})
            for person_id, name in (("person_a", "Anna"), ("person_b", "Bruno")):
                store.persons[person_id] = Person(
                    id=person_id, workspace_id=ctx.workspace_id, display_name=name,
                    role="member", status="active", created_at=utc_now(),
                )
        ctx.service.store = store
    return ("person_owner", "person_a", "person_b")


def test_no_preference_anywhere_resolves_to_english(ctx):
    assert workspace_language(ctx) is None
    assert resolve_language(ctx) == "en"


def test_workspace_preference_persists_and_survives_reload(ctx, tmp_path):
    set_workspace_language(ctx, "it")
    assert workspace_language(ctx) == "it"
    db_path = ctx.repository.path
    ctx.close()

    reopened = create_context(db_path=db_path, data_dir=tmp_path, for_tests=True)
    try:
        assert workspace_language(reopened) == "it"
    finally:
        reopened.close()


def test_unknown_language_is_rejected_with_reason_for_person_and_workspace(ctx):
    with pytest.raises(ValidationError) as workspace_error:
        set_workspace_language(ctx, "klingon")
    assert workspace_error.value.reason == "preferences.language_invalid"
    assert workspace_error.value.params == {"language": "klingon"}

    with pytest.raises(ValidationError) as person_error:
        set_person_language(ctx, "person_a", "klingon")
    assert person_error.value.reason == "preferences.language_invalid"


def test_two_people_same_workspace_each_get_engine_texts_in_their_language(ctx, people):
    """Same engine-generated message, each person in their own language."""
    _owner, anna, bruno = people
    set_person_language(ctx, anna, "en")
    set_person_language(ctx, bruno, "it")

    anna_message = user_text("intake.catalog.limits",
                             language=resolve_language(ctx, person_id=anna))
    bruno_message = user_text("intake.catalog.limits",
                              language=resolve_language(ctx, person_id=bruno))
    assert anna_message == "Limits"
    assert bruno_message == "Limiti"


def test_person_without_preference_gets_workspace_language(ctx, people):
    set_workspace_language(ctx, "en")
    assert person_language(ctx, "person_a") is None
    assert resolve_language(ctx, person_id="person_a") == "en"

    set_workspace_language(ctx, "it")
    assert resolve_language(ctx, person_id="person_a") == "it"


def test_person_preference_wins_over_workspace_and_request_over_all(ctx, people):
    set_workspace_language(ctx, "en")
    set_person_language(ctx, "person_a", "it")
    assert resolve_language(ctx, person_id="person_a") == "it"
    assert resolve_language(ctx, "en", person_id="person_a") == "en"


def _actor_client(ctx):
    """App dev-insecure fidata sugli header attore: ogni chiamante è una
    persona dello spazio di lavoro. Le stesse rotte NON sono raggiungibili
    con un token di persona (solo allowlist remota, session.scope_denied):
    qui si prova il contratto delle rotte, non il trasporto delle sessioni
    (quello è in test_remote_token_scope.py)."""
    from homun.context import reset_context_for_tests

    reset_context_for_tests(ctx)
    return TestClient(create_app())


def _actor_headers(person_id: str) -> dict[str, str]:
    return {"X-Homun-Actor-Id": person_id}


def _teardown_global_context():
    """Detach the test context from the process-wide slot (the fixture closes it)."""
    from homun.context import reset_context_for_tests

    reset_context_for_tests(None)


def test_person_routes_roundtrip_and_authority(ctx, people):
    owner, anna, bruno = people
    try:
        client = _actor_client(ctx)
        base = f"/v1/workspaces/{ctx.workspace_id}"
        anna_headers = _actor_headers(anna)
        owner_headers = _actor_headers(owner)

        # A person sets their own language.
        own = client.put(f"{base}/people/{anna}/language",
                         headers=anna_headers, json={"language": "en"})
        assert own.status_code == 200, own.text
        assert own.json() == {"language": "en"}
        assert person_language(ctx, anna) == "en"

        # Someone else's language needs workspace authority.
        forbidden = client.put(f"{base}/people/{bruno}/language",
                               headers=anna_headers, json={"language": "en"})
        assert forbidden.status_code == 403
        detail = forbidden.json()["detail"]
        assert detail["code"] == "permission_denied"
        assert detail["reason"] == "permission.workspace_authority_required"

        # The owner can set another person's language.
        granted = client.put(f"{base}/people/{bruno}/language",
                             headers=owner_headers, json={"language": "it"})
        assert granted.status_code == 200, granted.text
        assert person_language(ctx, bruno) == "it"

        # Unknown person: typed not_found with reason.
        unknown = client.put(f"{base}/people/person_ghost/language",
                             headers=owner_headers, json={"language": "it"})
        assert unknown.status_code == 404
        assert unknown.json()["detail"]["reason"] == "preferences.person_unknown"

        # Reading falls back person → workspace → English.
        assert client.get(f"{base}/people/{anna}/language",
                          headers=anna_headers).json() == {"language": "en"}
        set_workspace_language(ctx, "it")
        assert client.get(f"{base}/people/{bruno}/language",
                          headers=_actor_headers(bruno)).json() == {"language": "it"}
    finally:
        _teardown_global_context()


def test_workspace_language_change_requires_authority(ctx, people):
    owner, anna, _bruno = people
    try:
        client = _actor_client(ctx)
        base = f"/v1/workspaces/{ctx.workspace_id}/language"
        anna_headers = _actor_headers(anna)
        owner_headers = _actor_headers(owner)

        # A plain member cannot change the workspace default.
        denied = client.put(base, headers=anna_headers, json={"language": "en"})
        assert denied.status_code == 403
        detail = denied.json()["detail"]
        assert detail["code"] == "permission_denied"
        assert detail["reason"] == "permission.workspace_authority_required"
        assert workspace_language(ctx) is None

        # The owner can, and the value round-trips.
        allowed = client.put(base, headers=owner_headers, json={"language": "it"})
        assert allowed.status_code == 200, allowed.text
        assert client.get(base, headers=owner_headers).json() == {"language": "it"}

        invalid = client.put(base, headers=owner_headers, json={"language": "fr"})
        assert invalid.status_code == 400
        assert invalid.json()["detail"]["reason"] == "preferences.language_invalid"

        unknown_ws = client.get("/v1/workspaces/other/language", headers=owner_headers)
        assert unknown_ws.status_code == 404
        assert unknown_ws.json()["detail"]["reason"] == "workspace.unknown"
    finally:
        _teardown_global_context()


def test_supported_languages_are_it_and_en():
    assert SUPPORTED_LANGUAGES == ("it", "en")
