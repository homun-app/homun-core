"""F1 domain tests — transitions, concurrency, idempotency, chat/project rules."""

from __future__ import annotations

import pytest

from homun.domain.errors import ConflictError, InvalidTransitionError, NotFoundError, ValidationError
from homun.domain.models import Actor
from homun.domain.service import DomainService
from homun.domain.states import WorkStatus
from homun.domain.store import WorkspaceStore


@pytest.fixture
def workspace() -> tuple[DomainService, Actor, Actor]:
    store = WorkspaceStore("ws_test")
    service = DomainService(store)
    fabio = Actor(id="person_fabio", workspace_id="ws_test", display_name="Fabio")
    giulia = Actor(id="person_giulia", workspace_id="ws_test", display_name="Giulia")
    return service, fabio, giulia


def _create_agent(service: DomainService, actor: Actor, name: str) -> str:
    result = service.apply(actor, f"cmd_agent_{name}", "agent.create", {"name": name, "role": "collab"})
    return str(result["agent_id"])


def _seed_work(service: DomainService, actor: Actor, *, reviewer_id: str | None = None) -> dict:
    conv = service.apply(actor, "cmd_conv_1", "conversation.create", {"title": "Catalogo"})
    agent = _create_agent(service, actor, "Vera")
    work = service.apply(
        actor,
        "cmd_work_1",
        "work.create",
        {
            "conversation_id": conv["conversation_id"],
            "title": "Nuovo catalogo",
            "objective": "Catalogo prodotti Acme",
            "reviewer_id": reviewer_id or actor.id,
        },
    )
    plan = service.apply(
        actor,
        "cmd_plan_1",
        "plan.propose",
        {
            "work_id": work["work_id"],
            "expected_version": work["version"],
            "steps": [
                {
                    "id": "step_collect",
                    "title": "Raccogliere listino",
                    "assignee_id": agent,
                    "output_expected": "Listino CSV",
                },
                {
                    "id": "step_draft",
                    "title": "Bozza catalogo",
                    "assignee_id": agent,
                    "depends_on": ["step_collect"],
                    "output_expected": "Documento bozza",
                },
            ],
        },
    )
    accepted = service.apply(
        actor,
        "cmd_accept_1",
        "plan.accept",
        {"work_id": work["work_id"], "expected_version": plan["version"]},
    )
    return {
        "conversation_id": conv["conversation_id"],
        "work_id": work["work_id"],
        "agent_id": agent,
        "version": accepted["version"],
        "status": accepted["status"],
    }


def test_conversation_without_project(workspace: tuple[DomainService, Actor, Actor]) -> None:
    service, fabio, _ = workspace
    result = service.apply(fabio, "cmd1", "conversation.create", {"title": "Domanda libera"})
    conversation = service.get_conversation(str(result["conversation_id"]))
    assert conversation.project_id is None


def test_project_from_conversation_preserves_ids(
    workspace: tuple[DomainService, Actor, Actor],
) -> None:
    service, fabio, _ = workspace
    seeded = _seed_work(service, fabio)
    conversation = service.get_conversation(seeded["conversation_id"])
    result = service.apply(
        fabio,
        "cmd_proj",
        "project.create_from_conversation",
        {
            "conversation_id": conversation.id,
            "expected_version": conversation.version,
            "name": "Progetto Acme",
        },
    )
    conversation = service.get_conversation(conversation.id)
    work = service.get_work(seeded["work_id"])
    assert conversation.id == seeded["conversation_id"]
    assert conversation.project_id == result["project_id"]
    assert work.project_id == result["project_id"]


def test_multiple_conversations_for_same_work(
    workspace: tuple[DomainService, Actor, Actor],
) -> None:
    service, fabio, _ = workspace
    seeded = _seed_work(service, fabio)
    second = service.apply(fabio, "cmd_conv_2", "conversation.create", {"title": "Discussione bozza"})
    linked = service.apply(
        fabio,
        "cmd_link",
        "work.link_conversation",
        {
            "work_id": seeded["work_id"],
            "conversation_id": second["conversation_id"],
            "expected_version": seeded["version"],
        },
    )
    assert seeded["conversation_id"] in linked["conversation_ids"]
    assert second["conversation_id"] in linked["conversation_ids"]
    assert service.get_work(seeded["work_id"]).id == seeded["work_id"]


def test_agent_rename_keeps_stable_id(workspace: tuple[DomainService, Actor, Actor]) -> None:
    service, fabio, _ = workspace
    agent_id = _create_agent(service, fabio, "Vera")
    renamed = service.apply(
        fabio,
        "cmd_rename",
        "agent.rename",
        {"agent_id": agent_id, "expected_version": 1, "name": "Vera Prezzi"},
    )
    assert renamed["agent_id"] == agent_id
    assert service.get_agent(agent_id).name == "Vera Prezzi"


def test_happy_path_to_completed(workspace: tuple[DomainService, Actor, Actor]) -> None:
    service, fabio, giulia = workspace
    seeded = _seed_work(service, fabio, reviewer_id=fabio.id)
    started = service.apply(
        fabio,
        "cmd_start",
        "work.start",
        {"work_id": seeded["work_id"], "expected_version": seeded["version"]},
    )
    assert started["status"] == WorkStatus.RUNNING
    waiting = service.apply(
        fabio,
        "cmd_req",
        "work.request_contribution",
        {
            "work_id": seeded["work_id"],
            "expected_version": started["version"],
            "step_id": "step_collect",
            "to_actor_id": giulia.id,
            "need": "Listino aggiornato",
        },
    )
    assert waiting["status"] == WorkStatus.WAITING_INPUT
    contributed = service.apply(
        giulia,
        "cmd_contrib",
        "work.provide_contribution",
        {
            "request_id": waiting["request_id"],
            "expected_version": waiting["version"],
            "text": "SKU,Prezzo\nA-1,10",
        },
    )
    assert contributed["status"] == WorkStatus.READY
    started2 = service.apply(
        fabio,
        "cmd_start2",
        "work.start",
        {"work_id": seeded["work_id"], "expected_version": contributed["version"]},
    )
    artifact = service.apply(
        fabio,
        "cmd_art",
        "work.submit_artifact",
        {
            "work_id": seeded["work_id"],
            "expected_version": started2["version"],
            "title": "Bozza catalogo",
            "content": "# Catalogo\n...",
        },
    )
    assert artifact["status"] == WorkStatus.REVIEW
    approved = service.apply(
        fabio,
        "cmd_review",
        "work.review",
        {
            "work_id": seeded["work_id"],
            "expected_version": artifact["version"],
            "artifact_version_id": artifact["artifact_id"],
            "decision": "approve",
        },
    )
    assert approved["status"] == WorkStatus.COMPLETED


def test_cannot_approve_obsolete_artifact(workspace: tuple[DomainService, Actor, Actor]) -> None:
    service, fabio, _ = workspace
    seeded = _seed_work(service, fabio)
    started = service.apply(
        fabio,
        "cmd_start",
        "work.start",
        {"work_id": seeded["work_id"], "expected_version": seeded["version"]},
    )
    first = service.apply(
        fabio,
        "cmd_art1",
        "work.submit_artifact",
        {
            "work_id": seeded["work_id"],
            "expected_version": started["version"],
            "title": "v1",
            "content": "one",
        },
    )
    # Request changes then new artifact.
    changed = service.apply(
        fabio,
        "cmd_changes",
        "work.review",
        {
            "work_id": seeded["work_id"],
            "expected_version": first["version"],
            "artifact_version_id": first["artifact_id"],
            "decision": "request_changes",
        },
    )
    restarted = service.apply(
        fabio,
        "cmd_start2",
        "work.start",
        {"work_id": seeded["work_id"], "expected_version": changed["version"]},
    )
    second = service.apply(
        fabio,
        "cmd_art2",
        "work.submit_artifact",
        {
            "work_id": seeded["work_id"],
            "expected_version": restarted["version"],
            "title": "v2",
            "content": "two",
        },
    )
    with pytest.raises(ValidationError, match="obsolete"):
        service.apply(
            fabio,
            "cmd_bad_review",
            "work.review",
            {
                "work_id": seeded["work_id"],
                "expected_version": second["version"],
                "artifact_version_id": first["artifact_id"],
                "decision": "approve",
            },
        )


def test_cannot_complete_from_running_without_artifact_command(
    workspace: tuple[DomainService, Actor, Actor],
) -> None:
    """F1 has no silent complete; review requires an artifact version."""
    service, fabio, _ = workspace
    seeded = _seed_work(service, fabio)
    started = service.apply(
        fabio,
        "cmd_start",
        "work.start",
        {"work_id": seeded["work_id"], "expected_version": seeded["version"]},
    )
    with pytest.raises((ValidationError, NotFoundError)):
        service.apply(
            fabio,
            "cmd_review_no_art",
            "work.review",
            {
                "work_id": seeded["work_id"],
                "expected_version": started["version"],
                "artifact_version_id": "missing",
                "decision": "approve",
            },
        )


def test_illegal_transition_draft_to_completed(
    workspace: tuple[DomainService, Actor, Actor],
) -> None:
    service, fabio, _ = workspace
    conv = service.apply(fabio, "c1", "conversation.create", {"title": "x"})
    work = service.apply(
        fabio,
        "w1",
        "work.create",
        {
            "conversation_id": conv["conversation_id"],
            "title": "t",
            "objective": "o",
        },
    )
    # Force illegal transition via internal helper path: submit artifact from draft.
    with pytest.raises(InvalidTransitionError):
        service.apply(
            fabio,
            "bad",
            "work.submit_artifact",
            {
                "work_id": work["work_id"],
                "expected_version": work["version"],
                "title": "a",
                "content": "b",
            },
        )


def test_command_idempotent_replay(workspace: tuple[DomainService, Actor, Actor]) -> None:
    service, fabio, _ = workspace
    first = service.apply(fabio, "same_cmd", "conversation.create", {"title": "Uno"})
    second = service.apply(fabio, "same_cmd", "conversation.create", {"title": "Uno"})
    assert first == second
    assert len(service.store.conversations) == 1


def test_command_id_conflict_on_different_type(
    workspace: tuple[DomainService, Actor, Actor],
) -> None:
    service, fabio, _ = workspace
    service.apply(fabio, "same_cmd", "conversation.create", {"title": "Uno"})
    with pytest.raises(ConflictError):
        service.apply(fabio, "same_cmd", "agent.create", {"name": "X"})


def test_concurrent_version_conflict(workspace: tuple[DomainService, Actor, Actor]) -> None:
    service, fabio, _ = workspace
    seeded = _seed_work(service, fabio)
    with pytest.raises(ConflictError):
        service.apply(
            fabio,
            "stale",
            "work.start",
            {"work_id": seeded["work_id"], "expected_version": 1},
        )


def test_insert_step_after_succeeded_keeps_history(
    workspace: tuple[DomainService, Actor, Actor],
) -> None:
    service, fabio, _ = workspace
    seeded = _seed_work(service, fabio)
    started = service.apply(
        fabio,
        "cmd_start",
        "work.start",
        {"work_id": seeded["work_id"], "expected_version": seeded["version"]},
    )
    artifact = service.apply(
        fabio,
        "cmd_art",
        "work.submit_artifact",
        {
            "work_id": seeded["work_id"],
            "expected_version": started["version"],
            "title": "partial",
            "content": "done collect+draft for now",
        },
    )
    # After review request_changes we could revise; revise from review → ready.
    changed = service.apply(
        fabio,
        "cmd_ch",
        "work.review",
        {
            "work_id": seeded["work_id"],
            "expected_version": artifact["version"],
            "artifact_version_id": artifact["artifact_id"],
            "decision": "request_changes",
        },
    )
    translator = _create_agent(service, fabio, "Traduttore")
    revised = service.apply(
        fabio,
        "cmd_rev",
        "plan.revise",
        {
            "work_id": seeded["work_id"],
            "expected_version": changed["version"],
            "insert_after_step_id": "step_draft",
            "new_step": {
                "id": "step_translate",
                "title": "Traduci catalogo",
                "assignee_id": translator,
            },
        },
    )
    work = service.get_work(seeded["work_id"])
    old_plan = service.store.plans[service.store.plan_key(work.id, 1)]
    new_plan = service.current_plan(work)
    assert new_plan is not None
    assert old_plan.revision == 1
    assert new_plan.revision == revised["plan_revision"]
    assert "step_translate" in revised["step_ids"]
    assert "step_collect" in revised["step_ids"]
    # Succeeded steps remain in the new revision copy.
    assert any(s.id == "step_collect" and s.status.value == "succeeded" for s in new_plan.steps)


@pytest.mark.parametrize(
    ("from_status", "command", "payload_extra"),
    [
        (WorkStatus.DRAFT, "work.start", {}),
        (WorkStatus.COMPLETED, "work.start", {}),
    ],
)
def test_transition_table_rejects(
    workspace: tuple[DomainService, Actor, Actor],
    from_status: WorkStatus,
    command: str,
    payload_extra: dict,
) -> None:
    service, fabio, _ = workspace
    if from_status == WorkStatus.DRAFT:
        conv = service.apply(fabio, "c", "conversation.create", {"title": "t"})
        work = service.apply(
            fabio,
            "w",
            "work.create",
            {
                "conversation_id": conv["conversation_id"],
                "title": "t",
                "objective": "o",
            },
        )
        with pytest.raises((InvalidTransitionError, ValidationError)):
            service.apply(
                fabio,
                "x",
                command,
                {"work_id": work["work_id"], "expected_version": work["version"], **payload_extra},
            )
    else:
        seeded = _seed_work(service, fabio)
        started = service.apply(
            fabio,
            "s",
            "work.start",
            {"work_id": seeded["work_id"], "expected_version": seeded["version"]},
        )
        art = service.apply(
            fabio,
            "a",
            "work.submit_artifact",
            {
                "work_id": seeded["work_id"],
                "expected_version": started["version"],
                "title": "t",
                "content": "c",
            },
        )
        done = service.apply(
            fabio,
            "r",
            "work.review",
            {
                "work_id": seeded["work_id"],
                "expected_version": art["version"],
                "artifact_version_id": art["artifact_id"],
                "decision": "approve",
            },
        )
        assert done["status"] == WorkStatus.COMPLETED
        with pytest.raises(InvalidTransitionError):
            service.apply(
                fabio,
                "again",
                "work.start",
                {"work_id": seeded["work_id"], "expected_version": done["version"]},
            )
