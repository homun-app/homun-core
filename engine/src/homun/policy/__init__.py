"""Minimal actor checks and project AccessGrant enforcement (B2)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from homun.domain.errors import NotFoundError, PermissionDeniedError
from homun.domain.models import AccessGrant, Actor
from homun.domain.store import WorkspaceStore

ProjectCapability = Literal["read", "write", "admin"]

_CAP_RANK = {"read": 1, "write": 2, "admin": 3}


def require_workspace_actor(actor: Actor, workspace_id: str) -> None:
    if actor.workspace_id != workspace_id:
        raise PermissionDeniedError("Actor does not belong to this workspace")


def _grant_active(grant: AccessGrant, *, now: datetime | None = None) -> bool:
    if grant.status != "active":
        return False
    if grant.expires_at is not None:
        moment = now or datetime.now(timezone.utc)
        expires = grant.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires <= moment:
            return False
    return True


def effective_project_capability(
    store: WorkspaceStore,
    subject_id: str,
    project_id: str,
) -> ProjectCapability | None:
    """Highest non-revoked capability for subject on project, or None if deny."""
    if project_id not in store.projects:
        return None
    best = 0
    best_cap: ProjectCapability | None = None
    for grant in store.grants.values():
        if grant.resource_type != "project" or grant.resource_id != project_id:
            continue
        if grant.subject_id != subject_id:
            continue
        if not _grant_active(grant):
            continue
        rank = _CAP_RANK.get(grant.capability, 0)
        if rank > best:
            best = rank
            best_cap = grant.capability  # type: ignore[assignment]
    return best_cap


def has_project_capability(
    store: WorkspaceStore,
    subject_id: str,
    project_id: str,
    needed: ProjectCapability,
) -> bool:
    effective = effective_project_capability(store, subject_id, project_id)
    if effective is None:
        return False
    return _CAP_RANK[effective] >= _CAP_RANK[needed]


def require_project_capability(
    store: WorkspaceStore,
    actor: Actor,
    project_id: str,
    needed: ProjectCapability,
) -> None:
    if project_id not in store.projects:
        raise NotFoundError(f"Project not found: {project_id}")
    if not has_project_capability(store, actor.id, project_id, needed):
        raise PermissionDeniedError(
            f"Actor {actor.id} lacks {needed} on project {project_id}"
        )


def list_readable_project_ids(store: WorkspaceStore, subject_id: str) -> set[str]:
    return {
        project_id
        for project_id in store.projects
        if has_project_capability(store, subject_id, project_id, "read")
    }
