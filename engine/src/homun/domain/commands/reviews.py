"""Reviews domain commands and validation."""

from __future__ import annotations
from typing import Any
from homun.domain.errors import NotFoundError, ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, ArtifactVersion, Review, utc_now
from homun.domain.states import StepStatus, WorkStatus, assert_work_transition

from homun.domain.command_context import CommandContext


def _work_submit_artifact(
    ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    title = str(payload.get("title", "")).strip()
    content = str(payload.get("content", "")).strip()
    if not title or not content:
        raise ValidationError("Artifact title and content are required")
    assert_work_transition(work.status, WorkStatus.REVIEW)
    version = work.current_artifact_version + 1
    artifact = ArtifactVersion(
        id=new_id("art"),
        work_id=work.id,
        version=version,
        title=title,
        content=content,
        created_by=actor.id,
    )
    ctx.store.artifacts[artifact.id] = artifact
    work.current_artifact_version = version
    work.status = WorkStatus.REVIEW
    plan = ctx.current_plan(work)
    if plan is not None:
        for step in plan.steps:
            if step.status == StepStatus.RUNNING:
                step.status = StepStatus.SUCCEEDED
    work.version += 1
    work.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="artifact.created",
        payload={"artifact_id": artifact.id, "artifact_version": version},
    )
    return {
        "artifact_id": artifact.id,
        "artifact_version": version,
        "status": work.status,
        "version": work.version,
    }


def _work_review(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    if work.reviewer_id and actor.id != work.reviewer_id and actor.id != work.owner_id:
        raise ValidationError("Actor is not the reviewer for this work")
    artifact_version_id = str(payload.get("artifact_version_id", ""))
    artifact = ctx.store.artifacts.get(artifact_version_id)
    if artifact is None or artifact.work_id != work.id:
        raise NotFoundError("Artifact version not found for this work")
    if artifact.version != work.current_artifact_version:
        raise ValidationError("Cannot approve an obsolete artifact version")
    decision = str(payload.get("decision", ""))
    if decision not in {"approve", "request_changes"}:
        raise ValidationError("decision must be approve or request_changes")
    if decision == "approve":
        assert_work_transition(work.status, WorkStatus.COMPLETED)
        work.status = WorkStatus.COMPLETED
    else:
        assert_work_transition(work.status, WorkStatus.READY)
        work.status = WorkStatus.READY
    review = Review(
        id=new_id("rev"),
        work_id=work.id,
        artifact_version_id=artifact.id,
        decision=decision,
        reviewer_id=actor.id,
        comment=str(payload.get("comment", "")),
    )
    ctx.store.reviews[review.id] = review
    work.version += 1
    work.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="review.recorded",
        payload={"review_id": review.id, "decision": decision},
    )
    return {
        "review_id": review.id,
        "status": work.status,
        "version": work.version,
    }

