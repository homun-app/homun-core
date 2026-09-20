"""Projects domain commands and validation."""

from __future__ import annotations
from typing import Any
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, Project, Work, utc_now
from homun.policy import require_project_capability

PROJECT_STATUSES = frozenset({"active", "archived"})

from homun.domain.command_context import CommandContext
from homun.domain.commands.grants import _issue_admin_grant
from homun.domain.commands.membership import _normalize_member_ids
from homun.domain.commands.membership import _normalize_team_ids


def _project_create(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ValidationError("Project name is required")
    member_ids = _normalize_member_ids(ctx, payload.get("member_ids"))
    team_ids = _normalize_team_ids(ctx, payload.get("team_ids"))
    status = str(payload.get("status", "active") or "active").strip()
    if status not in PROJECT_STATUSES:
        raise ValidationError(f"Invalid project status: {status}")
    project = Project(
        id=new_id("proj"),
        workspace_id=ctx.store.workspace_id,
        name=name,
        description=str(payload.get("description", "") or ""),
        member_ids=member_ids,
        team_ids=team_ids,
        status=status,
    )
    ctx.store.projects[project.id] = project
    grant = _issue_admin_grant(ctx, actor=actor, project_id=project.id, command_id=command_id)
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=project.id,
        aggregate_type="project",
        aggregate_version=project.version,
        event_type="project.created",
        payload={"name": project.name, "admin_grant_id": grant.id},
    )
    return {
        "project_id": project.id,
        "version": project.version,
        "name": project.name,
        "status": project.status,
        "admin_grant_id": grant.id,
    }


def _project_update(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    project = ctx.get_project(str(payload.get("project_id", "")))
    require_project_capability(ctx.store, actor, project.id, "write")
    ctx._require_expected_version(project.version, payload.get("expected_version"))
    if "name" in payload:
        name = str(payload.get("name", "")).strip()
        if not name:
            raise ValidationError("Project name is required")
        project.name = name
    if "description" in payload:
        project.description = str(payload.get("description") or "")
    if "member_ids" in payload:
        project.member_ids = _normalize_member_ids(ctx, payload.get("member_ids"))
    if "team_ids" in payload:
        project.team_ids = _normalize_team_ids(ctx, payload.get("team_ids"))
    if "status" in payload:
        status = str(payload.get("status") or "").strip()
        if status not in PROJECT_STATUSES:
            raise ValidationError(f"Invalid project status: {status}")
        project.status = status
    project.version += 1
    project.updated_at = utc_now()
    ctx.store.projects[project.id] = project
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=project.id,
        aggregate_type="project",
        aggregate_version=project.version,
        event_type="project.updated",
        payload={"name": project.name, "status": project.status},
    )
    return {
        "project_id": project.id,
        "version": project.version,
        "name": project.name,
        "description": project.description,
        "member_ids": list(project.member_ids),
        "team_ids": list(project.team_ids),
        "status": project.status,
    }


def _project_archive(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _project_update(ctx, 
        actor,
        command_id,
        {
            "project_id": payload.get("project_id"),
            "expected_version": payload.get("expected_version"),
            "status": "archived",
        },
    )


def _project_create_from_conversation(
    ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    conversation_id = str(payload.get("conversation_id", ""))
    conversation = ctx.get_conversation(conversation_id)
    ctx._require_expected_version(conversation.version, payload.get("expected_version"))
    if conversation.project_id is not None:
        raise ValidationError("Conversation already belongs to a project")
    name = str(payload.get("name", "")).strip() or conversation.title
    member_ids = _normalize_member_ids(ctx, payload.get("member_ids"))
    team_ids = _normalize_team_ids(ctx, payload.get("team_ids"))
    project = Project(
        id=new_id("proj"),
        workspace_id=ctx.store.workspace_id,
        name=name,
        description=str(payload.get("description", "") or ""),
        member_ids=member_ids,
        team_ids=team_ids,
        conversation_ids=[conversation.id],
    )
    ctx.store.projects[project.id] = project
    grant = _issue_admin_grant(ctx, actor=actor, project_id=project.id, command_id=command_id)
    conversation.project_id = project.id
    conversation.version += 1
    conversation.updated_at = utc_now()
    # Preserve work links: attach project to works whose primary chat is this one.
    for work in ctx.store.works.values():
        if conversation.id in work.conversation_ids and work.project_id is None:
            work.project_id = project.id
            work.version += 1
            work.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=project.id,
        aggregate_type="project",
        aggregate_version=project.version,
        event_type="project.created_from_conversation",
        payload={"conversation_id": conversation.id, "admin_grant_id": grant.id},
    )
    return {
        "project_id": project.id,
        "conversation_id": conversation.id,
        "conversation_version": conversation.version,
        "admin_grant_id": grant.id,
    }


def ensure_project_for_work(ctx: CommandContext, actor: Actor, work: Work, *, command_id: str) -> str:
    """Return project_id for work; create from primary conversation if missing."""
    if work.project_id:
        return work.project_id
    conversation = ctx.get_conversation(work.primary_conversation_id)
    if conversation.project_id:
        work.project_id = conversation.project_id
        work.version += 1
        work.updated_at = utc_now()
        return conversation.project_id
    created = _project_create_from_conversation(ctx, 
        actor,
        command_id,
        {
            "conversation_id": conversation.id,
            "expected_version": conversation.version,
            "name": work.title or conversation.title,
        },
    )
    return str(created["project_id"])

