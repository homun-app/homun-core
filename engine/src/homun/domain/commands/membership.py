"""Membership domain commands and validation."""

from __future__ import annotations
from typing import Any
from homun.domain.errors import ValidationError

from homun.domain.command_context import CommandContext


def _known_member_ids(ctx) -> set[str]:
    """Person actors are not stored; agents are. Callers may include person_* ids."""
    return set(ctx.store.agents.keys())


def _normalize_member_ids(ctx: CommandContext, raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValidationError("member_ids must be a list")
    out: list[str] = []
    seen: set[str] = set()
    known_agents = _known_member_ids(ctx)
    for item in raw:
        mid = str(item).strip()
        if not mid or mid in seen:
            continue
        # Allow person_* without registry; agents must exist.
        if mid.startswith("agent_") and mid not in known_agents:
            raise ValidationError(f"Unknown agent member: {mid}")
        if mid.startswith("team_"):
            raise ValidationError(f"Team id is not a member: {mid}")
        seen.add(mid)
        out.append(mid)
    return out


def _normalize_team_ids(ctx: CommandContext, raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValidationError("team_ids must be a list")
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        tid = str(item).strip()
        if not tid or tid in seen:
            continue
        if tid not in ctx.store.teams:
            raise ValidationError(f"Unknown team: {tid}")
        seen.add(tid)
        out.append(tid)
    return out


def _validate_coordinator(ctx: CommandContext, coordinator_id: str | None, member_ids: list[str]) -> str | None:
    if coordinator_id is None:
        return None
    cid = str(coordinator_id).strip()
    if not cid:
        return None
    if cid not in member_ids:
        raise ValidationError("coordinator_id must be included in member_ids")
    return cid

