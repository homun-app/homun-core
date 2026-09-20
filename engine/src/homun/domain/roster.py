"""Workspace roster for interpret / plan — person actor + Homun agents."""

from __future__ import annotations

from collections.abc import Iterable

from homun.domain.models import Actor, AgentProfile
from typing import Literal
from pydantic import BaseModel


class RosterEntry(BaseModel):
    id: str
    display_name: str
    kind: Literal["person", "agent", "other"] = "person"

ROSTER_AGENT_STATUSES = frozenset({"active", "draft"})


def agent_to_roster_entry(agent: AgentProfile) -> RosterEntry:
    return RosterEntry(id=agent.id, display_name=agent.name, kind="agent")


def build_workspace_roster(
    *,
    actor: Actor,
    agents: Iterable[AgentProfile],
    include_statuses: frozenset[str] = ROSTER_AGENT_STATUSES,
    existing: list[RosterEntry] | None = None,
) -> list[RosterEntry]:
    """Merge person (and any provided entries) with eligible agents; stable ids, no invent."""
    by_id: dict[str, RosterEntry] = {}
    if existing:
        for entry in existing:
            by_id[entry.id] = entry
    else:
        by_id[actor.id] = RosterEntry(
            id=actor.id,
            display_name=actor.display_name,
            kind="person" if actor.kind == "person" else "other",
        )
    if actor.id not in by_id:
        by_id[actor.id] = RosterEntry(
            id=actor.id,
            display_name=actor.display_name,
            kind="person" if actor.kind == "person" else "other",
        )
    for agent in agents:
        if agent.status not in include_statuses:
            continue
        by_id[agent.id] = agent_to_roster_entry(agent)
    return list(by_id.values())
