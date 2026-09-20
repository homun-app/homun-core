"""Teams domain commands and validation."""

from __future__ import annotations
from typing import Any
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, Team, utc_now

TEAM_STATUSES = frozenset({"active", "archived"})

from homun.domain.command_context import CommandContext
from homun.domain.commands.membership import _normalize_member_ids
from homun.domain.commands.membership import _validate_coordinator


def _team_create(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ValidationError("Team name is required")
    member_ids = _normalize_member_ids(ctx, payload.get("member_ids"))
    coordinator_id = _validate_coordinator(ctx, payload.get("coordinator_id"), member_ids)
    status = str(payload.get("status", "active") or "active").strip()
    if status not in TEAM_STATUSES:
        raise ValidationError(f"Invalid team status: {status}")
    team = Team(
        id=new_id("team"),
        workspace_id=ctx.store.workspace_id,
        name=name,
        description=str(payload.get("description", "") or ""),
        member_ids=member_ids,
        coordinator_id=coordinator_id,
        status=status,
    )
    ctx.store.teams[team.id] = team
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=team.id,
        aggregate_type="team",
        aggregate_version=team.revision,
        event_type="team.created",
        payload={"name": team.name},
    )
    return {
        "team_id": team.id,
        "revision": team.revision,
        "name": team.name,
        "status": team.status,
    }


def _team_update(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    team = ctx.get_team(str(payload.get("team_id", "")))
    ctx._require_expected_version(team.revision, payload.get("expected_version"))
    if "name" in payload:
        name = str(payload.get("name", "")).strip()
        if not name:
            raise ValidationError("Team name is required")
        team.name = name
    if "description" in payload:
        team.description = str(payload.get("description") or "")
    if "member_ids" in payload:
        team.member_ids = _normalize_member_ids(ctx, payload.get("member_ids"))
    if "coordinator_id" in payload or "member_ids" in payload:
        coord = payload.get("coordinator_id", team.coordinator_id)
        team.coordinator_id = _validate_coordinator(ctx, coord, team.member_ids)
    if "status" in payload:
        status = str(payload.get("status") or "").strip()
        if status not in TEAM_STATUSES:
            raise ValidationError(f"Invalid team status: {status}")
        team.status = status
    team.revision += 1
    team.updated_at = utc_now()
    ctx.store.teams[team.id] = team
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=team.id,
        aggregate_type="team",
        aggregate_version=team.revision,
        event_type="team.updated",
        payload={"name": team.name, "status": team.status},
    )
    return {
        "team_id": team.id,
        "revision": team.revision,
        "name": team.name,
        "description": team.description,
        "member_ids": list(team.member_ids),
        "coordinator_id": team.coordinator_id,
        "status": team.status,
    }


def _team_archive(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _team_update(ctx, 
        actor,
        command_id,
        {
            "team_id": payload.get("team_id"),
            "expected_version": payload.get("expected_version"),
            "status": "archived",
        },
    )

