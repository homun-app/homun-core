"""Grants domain commands and validation."""

from __future__ import annotations
from datetime import datetime
from typing import Any
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.models import AccessGrant, Actor, utc_now
from homun.policy import require_project_capability

GRANT_CAPABILITIES = frozenset({"read", "write", "admin"})

from homun.domain.command_context import CommandContext


def _issue_admin_grant(
    ctx: CommandContext, *, actor: Actor, project_id: str, command_id: str
) -> AccessGrant:
    """Bootstrap admin grant for project creator (internal; skips admin check)."""
    grant = AccessGrant(
        id=new_id("grant"),
        workspace_id=ctx.store.workspace_id,
        subject_id=actor.id,
        resource_type="project",
        resource_id=project_id,
        capability="admin",
        issuer_id=actor.id,
        status="active",
    )
    ctx.store.grants[grant.id] = grant
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=grant.id,
        aggregate_type="grant",
        aggregate_version=1,
        event_type="grant.issued",
        payload={
            "subject_id": grant.subject_id,
            "resource_id": grant.resource_id,
            "capability": grant.capability,
            "bootstrap": True,
        },
    )
    return grant


def _parse_expires_at(ctx: CommandContext, raw: Any) -> datetime | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, datetime):
        return raw
    text = str(raw).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(f"Invalid expires_at: {text}") from exc
    return parsed


def _grant_issue(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    project_id = str(payload.get("project_id") or payload.get("resource_id") or "").strip()
    if not project_id:
        raise ValidationError("project_id is required")
    require_project_capability(ctx.store, actor, project_id, "admin")
    subject_id = str(payload.get("subject_id", "")).strip()
    if not subject_id:
        raise ValidationError("subject_id is required")
    capability = str(payload.get("capability", "")).strip()
    if capability not in GRANT_CAPABILITIES:
        raise ValidationError(f"Invalid capability: {capability}")
    resource_type = str(payload.get("resource_type", "project") or "project").strip()
    if resource_type != "project":
        raise ValidationError("B2 only supports resource_type=project")
    grant = AccessGrant(
        id=new_id("grant"),
        workspace_id=ctx.store.workspace_id,
        subject_id=subject_id,
        resource_type="project",
        resource_id=project_id,
        capability=capability,
        issuer_id=actor.id,
        status="active",
        expires_at=_parse_expires_at(ctx, payload.get("expires_at")),
    )
    ctx.store.grants[grant.id] = grant
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=grant.id,
        aggregate_type="grant",
        aggregate_version=1,
        event_type="grant.issued",
        payload={
            "subject_id": grant.subject_id,
            "resource_id": grant.resource_id,
            "capability": grant.capability,
        },
    )
    return {
        "grant_id": grant.id,
        "subject_id": grant.subject_id,
        "resource_id": grant.resource_id,
        "capability": grant.capability,
        "status": grant.status,
    }


def _grant_revoke(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    grant_id = str(payload.get("grant_id", "")).strip()
    grant = ctx.get_grant(grant_id)
    if grant.resource_type != "project":
        raise ValidationError("Only project grants can be revoked in B2")
    require_project_capability(ctx.store, actor, grant.resource_id, "admin")
    if grant.status == "revoked":
        return {
            "grant_id": grant.id,
            "status": grant.status,
            "resource_id": grant.resource_id,
        }
    grant.status = "revoked"
    grant.updated_at = utc_now()
    ctx.store.grants[grant.id] = grant
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=grant.id,
        aggregate_type="grant",
        aggregate_version=1,
        event_type="grant.revoked",
        payload={"subject_id": grant.subject_id, "resource_id": grant.resource_id},
    )
    return {
        "grant_id": grant.id,
        "status": grant.status,
        "resource_id": grant.resource_id,
    }

