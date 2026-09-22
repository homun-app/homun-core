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
    plan = ctx.current_plan(work)
    pending_steps = [s for s in plan.steps if s.status == StepStatus.PENDING] if plan else []
    if decision == "approve" and pending_steps:
        # A verified intermediate phase advances the work, it does not conclude
        # it: the next phase waits for the person's explicit go, like the first.
        assert_work_transition(work.status, WorkStatus.READY)
        work.status = WorkStatus.READY
    elif decision == "approve":
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
    advanced = decision == "approve" and bool(pending_steps)
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="review.recorded",
        payload={"review_id": review.id, "decision": decision,
                 **({"advanced_to_step": pending_steps[0].id} if advanced else {})},
    )
    if decision == "approve":
        from homun.domain.commands.conversations import append_engine_message
        if advanced:
            append_engine_message(
                ctx, actor=actor, command_id=f"{command_id}:phase",
                conversation_id=work.primary_conversation_id, author_id="homun_engine",
                text=(f"Fase verificata e completata. Prossima: «{pending_steps[0].title}». "
                      "L'avvio è nel riepilogo del lavoro: nulla parte senza il tuo via."),
                event_payload={"work_id": work.id, "next_step_id": pending_steps[0].id},
            )
        else:
            append_engine_message(
                ctx, actor=actor, command_id=f"{command_id}:done",
                conversation_id=work.primary_conversation_id, author_id="homun_engine",
                text=(f"Lavoro completato: «{work.title}». Il risultato verificato resta "
                      "nella conversazione; nessun invio esterno."),
                event_payload={"work_id": work.id, "artifact_id": artifact.id},
            )
    return {
        "review_id": review.id,
        "status": work.status,
        "version": work.version,
    }

