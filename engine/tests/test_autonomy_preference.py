"""La modalità di autonomia come preferenza della persona, nel motore.

L'ultima modalità scelta (Autonomo / Con guardrail / Supervisionato) è il
default della persona per le conversazioni nuove e sopravvive ai ricaricamenti:
vissuta nel motore (meta per persona), non solo nel browser.
"""
import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.ops.preferences import (
    AUTONOMY_LEVELS,
    person_autonomy,
    set_person_autonomy,
)
from homun.context import create_context
from homun.domain.errors import ValidationError


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
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


def test_levels_are_the_three_ui_modes():
    assert AUTONOMY_LEVELS == ("autonomous", "guarded", "supervised")


def test_person_autonomy_roundtrip_and_reload(ctx, people, tmp_path):
    _owner, anna, _bruno = people
    assert person_autonomy(ctx, anna) is None, 'nessuna preferenza all\'inizio'
    set_person_autonomy(ctx, anna, "supervised")
    assert person_autonomy(ctx, anna) == "supervised"
    db_path = ctx.repository.path
    ctx.close()

    reopened = create_context(db_path=db_path, data_dir=tmp_path, for_tests=True)
    try:
        assert person_autonomy(reopened, anna) == "supervised"
    finally:
        reopened.close()


def test_unknown_level_is_rejected(ctx, people):
    _owner, anna, _bruno = people
    with pytest.raises(ValidationError) as caught:
        set_person_autonomy(ctx, anna, "anarchia")
    assert caught.value.reason == "preferences.autonomy_invalid"
    assert caught.value.params == {"level": "anarchia"}


def test_routes_roundtrip_authority_and_first_use(ctx, people):
    owner, anna, bruno = people
    from homun.context import reset_context_for_tests

    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    base = f"/v1/workspaces/{ctx.workspace_id}"
    anna_headers = {"X-Homun-Actor-Id": anna}
    owner_headers = {"X-Homun-Actor-Id": owner}
    try:
        # Senza preferenza la lettura dichiara il default della UI.
        assert client.get(f"{base}/people/{anna}/autonomy", headers=anna_headers).json() == {
            "autonomy": "guarded"}

        # La persona imposta la propria.
        own = client.put(f"{base}/people/{anna}/autonomy",
                         headers=anna_headers, json={"autonomy": "autonomous"})
        assert own.status_code == 200, own.text
        assert own.json() == {"autonomy": "autonomous"}
        assert person_autonomy(ctx, anna) == "autonomous"

        # Quella di un altro richiede l'autorità dello spazio.
        forbidden = client.put(f"{base}/people/{bruno}/autonomy",
                               headers=anna_headers, json={"autonomy": "autonomous"})
        assert forbidden.status_code == 403
        assert forbidden.json()["detail"]["reason"] == "permission.workspace_authority_required"

        # Valori sconosciuti rifiutati con reason tipizzata.
        invalid = client.put(f"{base}/people/{anna}/autonomy",
                             headers=anna_headers, json={"autonomy": "turbo"})
        assert invalid.status_code == 400
        assert invalid.json()["detail"]["reason"] == "preferences.autonomy_invalid"

        # Persona ignota: 404 tipizzato (per gli altri serve la persona viva).
        unknown = client.get(f"{base}/people/person_ghost/autonomy", headers=owner_headers)
        assert unknown.status_code == 404
        assert unknown.json()["detail"]["reason"] == "preferences.person_unknown"
    finally:
        client.close()
        reset_context_for_tests(None)


def test_first_use_bootstraps_the_person_with_their_own_preference(ctx):
    """La persona locale può scegliere la modalità prima di qualsiasi comando:
    la preferenza crea la sua Person (bootstrap al primo uso), non va persa."""
    from homun.context import reset_context_for_tests

    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    base = f"/v1/workspaces/{ctx.workspace_id}"
    headers = {"X-Homun-Actor-Id": "person_local"}
    try:
        response = client.put(f"{base}/people/person_local/autonomy",
                              headers=headers, json={"autonomy": "supervised"})
        assert response.status_code == 200, response.text
        assert person_autonomy(ctx, "person_local") == "supervised"
        assert ctx.repository.snapshot().persons.get("person_local") is not None
    finally:
        client.close()
        reset_context_for_tests(None)
