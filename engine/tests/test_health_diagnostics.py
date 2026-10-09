"""Health stays coarse; full DB diagnostics require owner/admin."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import Actor
from homun.storage.recovery import RecoveryIssue, RecoveryReport, write_report


@pytest.fixture
def client(tmp_path: Path):
    reset_context_for_tests(
        create_context(
            workspace_id="ws_local",
            db_path=tmp_path / "ws_local.sqlite3",
            data_dir=tmp_path,
            for_tests=True,
        )
    )
    app = create_app()
    with TestClient(app) as tc:
        yield tc, tmp_path
    reset_context_for_tests(None)


def test_health_exposes_coarse_db_state_only(client):
    tc, data_dir = client
    report = RecoveryReport(
        mode="repaired",
        started_at="2026-10-01T00:00:00+00:00",
        finished_at="2026-10-01T00:01:00+00:00",
        workspace_id="ws_local",
        quarantine_dir=str(data_dir / "recovery" / "quarantine"),
    )
    report.issues.append(RecoveryIssue("unreadable_table", "commands", "entity_cmd_secret"))
    report.tables["commands"] = {"kept": 1, "lost": 2}
    write_report(data_dir, report)

    response = tc.get("/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["db"] == {"state": "repaired"}
    assert "report" not in body["db"]
    assert "quarantine" not in response.text
    assert "entity_cmd_secret" not in response.text


def test_diagnostics_db_requires_actor(client):
    tc, _data_dir = client
    assert tc.get("/v1/diagnostics/db").status_code == 401


def test_diagnostics_db_allows_owner_and_returns_full_report(client):
    tc, data_dir = client
    report = RecoveryReport(
        mode="repaired",
        started_at="2026-10-01T00:00:00+00:00",
        finished_at="2026-10-01T00:01:00+00:00",
        workspace_id="ws_local",
        quarantine_dir=str(data_dir / "recovery" / "quarantine"),
    )
    write_report(data_dir, report)

    owner = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    response = tc.get(
        "/v1/diagnostics/db",
        headers={"X-Homun-Actor-Id": owner.id, "X-Homun-Actor-Name": owner.display_name},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "repaired"
    assert body["report"]["workspace_id"] == "ws_local"
    assert body["report"]["quarantine_dir"] == str(data_dir / "recovery" / "quarantine")


def test_diagnostics_db_denies_member(client):
    tc, _data_dir = client
    from homun.context import get_context
    from homun.domain.ids import new_id

    owner = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    ctx = get_context()
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            service = ctx.service.for_store(store)
            service.apply(owner, f"bootstrap:{new_id('cmd')}", "person.bootstrap", {})
            service.apply(
                owner,
                f"invite:{new_id('cmd')}",
                "person.invite",
                {
                    "role": "member",
                    "note": "",
                    "expires_at": "2099-01-01T00:00:00+00:00",
                    "secret_hash": "abc",
                },
            )
        ctx.service.store = store

    # Redeem path is heavy; create a member person via invite redeem is complex.
    # Seed a member directly after owner bootstrap for the ACL check.
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            from homun.domain.models import Person, utc_now
            member = Person(
                id="person_member",
                workspace_id="ws_local",
                display_name="Member",
                role="member",
                status="active",
                created_at=utc_now(),
            )
            store.persons[member.id] = member
        ctx.service.store = store

    denied = tc.get(
        "/v1/diagnostics/db",
        headers={"X-Homun-Actor-Id": "person_member"},
    )
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "permission_denied"
