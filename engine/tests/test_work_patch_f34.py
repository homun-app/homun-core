"""F3.4 versioned work patch tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.errors import ConflictError, ValidationError
from homun.domain.models import Actor
from homun.domain.patch import WorkPatchChange, build_preview
from homun.domain.service import DomainService
from homun.domain.store import WorkspaceStore


def _seed_work_with_plan(service: DomainService, actor: Actor) -> dict:
    conv = service.apply(actor, "c1", "conversation.create", {"title": "T"})
    work = service.apply(
        actor,
        "w1",
        "work.create",
        {
            "conversation_id": conv["conversation_id"],
            "title": "Catalogo",
            "objective": "Vecchio obiettivo",
        },
    )
    plan = service.apply(
        actor,
        "p1",
        "plan.propose",
        {
            "work_id": work["work_id"],
            "expected_version": work["version"],
            "steps": [
                {
                    "title": "Bozza",
                    "assignee_id": actor.id,
                    "output_expected": "Bozza",
                    "depends_on": [],
                }
            ],
        },
    )
    current = service.current_plan(service.get_work(work["work_id"]))
    assert current is not None
    return {
        "work_id": work["work_id"],
        "version": plan["version"],
        "step_ids": [s.id for s in current.steps],
        "plan_revision": plan["plan_revision"],
    }


def test_preview_fills_from_value_and_summary() -> None:
    store = WorkspaceStore("ws_local")
    service = DomainService(store)
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    seeded = _seed_work_with_plan(service, actor)
    work = service.get_work(seeded["work_id"])
    proposal = build_preview(
        work,
        service.current_plan(work),
        [WorkPatchChange(field="objective", to_value="Nuovo obiettivo")],
        roster_ids={actor.id},
    )
    assert proposal.base_version == work.version
    assert proposal.changes[0].from_value == "Vecchio obiettivo"
    assert proposal.missing_or_ambiguous == []
    assert any("obiettivo" in line.lower() for line in proposal.summary_lines)


def test_apply_patch_updates_objective_and_bumps_version() -> None:
    store = WorkspaceStore("ws_local")
    service = DomainService(store)
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    seeded = _seed_work_with_plan(service, actor)
    result = service.apply(
        actor,
        "patch1",
        "work.apply_patch",
        {
            "work_id": seeded["work_id"],
            "expected_version": seeded["version"],
            "changes": [{"field": "objective", "to_value": "Nuovo obiettivo"}],
        },
    )
    work = service.get_work(seeded["work_id"])
    assert work.objective == "Nuovo obiettivo"
    assert work.version == seeded["version"] + 1
    assert result["version"] == work.version


def test_apply_patch_stale_version_conflicts() -> None:
    store = WorkspaceStore("ws_local")
    service = DomainService(store)
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    seeded = _seed_work_with_plan(service, actor)
    with pytest.raises(ConflictError):
        service.apply(
            actor,
            "patch_stale",
            "work.apply_patch",
            {
                "work_id": seeded["work_id"],
                "expected_version": 1,
                "changes": [{"field": "objective", "to_value": "X"}],
            },
        )


def test_preview_rejects_unknown_assignee() -> None:
    store = WorkspaceStore("ws_local")
    service = DomainService(store)
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    seeded = _seed_work_with_plan(service, actor)
    work = service.get_work(seeded["work_id"])
    proposal = build_preview(
        work,
        service.current_plan(work),
        [
            WorkPatchChange(
                field="step_assignee",
                step_id=seeded["step_ids"][0],
                to_value="ghost",
            )
        ],
        roster_ids={actor.id},
    )
    assert proposal.missing_or_ambiguous
    assert any("ghost" in item for item in proposal.missing_or_ambiguous)


def test_apply_step_assignee_creates_new_plan_revision() -> None:
    store = WorkspaceStore("ws_local")
    service = DomainService(store)
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    seeded = _seed_work_with_plan(service, actor)
    vera = service.apply(actor, "a_vera", "agent.create", {"name": "Vera", "role": "prezzi"})
    vera_id = str(vera["agent_id"])
    result = service.apply(
        actor,
        "patch_assignee",
        "work.apply_patch",
        {
            "work_id": seeded["work_id"],
            "expected_version": seeded["version"],
            "changes": [
                {
                    "field": "step_assignee",
                    "step_id": seeded["step_ids"][0],
                    "to_value": vera_id,
                }
            ],
            "roster_ids": [actor.id, vera_id],
        },
    )
    work = service.get_work(seeded["work_id"])
    plan = service.current_plan(work)
    assert plan is not None
    assert plan.revision == seeded["plan_revision"] + 1
    assert plan.steps[0].assignee_id == vera_id
    assert result["plan_revision"] == plan.revision


def test_apply_patch_with_issues_raises_validation() -> None:
    store = WorkspaceStore("ws_local")
    service = DomainService(store)
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    seeded = _seed_work_with_plan(service, actor)
    with pytest.raises(ValidationError):
        service.apply(
            actor,
            "patch_bad",
            "work.apply_patch",
            {
                "work_id": seeded["work_id"],
                "expected_version": seeded["version"],
                "changes": [{"field": "owner_id", "to_value": "ghost"}],
                "roster_ids": [actor.id],
            },
        )


def test_post_message_returns_patch_preview_without_applying(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_local.sqlite3"
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    )
    app = create_app()
    headers = {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}
    with TestClient(app) as client:
        created = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_f34_create",
                "type": "conversation.create",
                "payload": {"title": "Catalogo"},
            },
        )
        conversation_id = created.json()["result"]["conversation_id"]
        work = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_f34_work",
                "type": "work.create",
                "payload": {
                    "conversation_id": conversation_id,
                    "title": "Catalogo",
                    "objective": "Vecchio obiettivo",
                },
            },
        )
        work_id = work.json()["result"]["work_id"]
        version = work.json()["result"]["version"]
        posted = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_f34_msg",
                "type": "conversation.post_message",
                "payload": {
                    "conversation_id": conversation_id,
                    "text": "Cambia obiettivo a Catalogo invernale Acme",
                    "roster": [
                        {"id": "person_fabio", "display_name": "Fabio", "kind": "person"},
                    ],
                },
            },
        )
        assert posted.status_code == 200, posted.text
        body = posted.json()["result"]
        assert body["interpretation"]["kind"] == "patch_proposal"
        assert body["patch_proposal"]["changes"][0]["to_value"] == "Catalogo invernale Acme"
        assert "Obiettivo" in "\n".join(body["patch_proposal"]["summary_lines"])

        listed = client.get(f"/v1/workspaces/ws_local/works/{work_id}", headers=headers)
        assert listed.status_code == 200
        assert listed.json()["work"]["objective"] == "Vecchio obiettivo"

        applied = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_f34_apply",
                "type": "work.apply_patch",
                "payload": {
                    "work_id": work_id,
                    "expected_version": version,
                    "changes": body["patch_proposal"]["changes"],
                    "roster_ids": ["person_fabio"],
                },
            },
        )
        assert applied.status_code == 200, applied.text
        after = client.get(f"/v1/workspaces/ws_local/works/{work_id}", headers=headers)
        assert after.json()["work"]["objective"] == "Catalogo invernale Acme"


def test_fake_assign_phrase_is_patch_proposal() -> None:
    from homun.models.fake import FakeProvider
    from homun.models.interpretation import RosterEntry

    provider = FakeProvider()
    roster = [
        RosterEntry(id="person_fabio", display_name="Fabio", kind="person"),
        RosterEntry(id="agent_vera", display_name="Vera", kind="agent"),
    ]
    interp = provider.interpret("Assegna a @Vera il prossimo passo del piano", roster=roster)
    assert interp.kind == "patch_proposal"
    assert interp.patch_changes
    assert interp.patch_changes[0].field == "step_assignee"
    assert interp.patch_changes[0].to_value == "agent_vera"
