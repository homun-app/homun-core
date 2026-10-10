"""Human-gated promotion of a project lesson into an agent's craft memory.

The supervisor decides which on-the-job lessons become transferable
methodology: the craft copy carries provenance, the project original stays
untouched, and text that still references workspace entities (project,
material, work, conversation ids) is refused — craft memory must travel
across projects without carrying project data with it.
"""
from __future__ import annotations

import re

from homun.domain.errors import NotFoundError, ValidationError

_ENTITY_REFERENCE = re.compile(r"\b(?:proj_|mat_|work_|conv_|mem_|grant_)")


def promote_to_agent(ctx, actor, memory_id: str, agent_id: str) -> dict:
    if actor.kind != "person":
        raise ValidationError("Only a person can promote memories into craft memory")
    store = ctx.repository.load()
    agent = store.agents.get(agent_id)
    if agent is None:
        raise NotFoundError("Agent not found")
    if agent.status not in ("active",):
        raise ValidationError("Craft memory requires an active agent")
    source = next((n for n in ctx.memory.list(include_deleted=False) if n.id == memory_id), None)
    if source is None:
        raise NotFoundError("Memory not found")
    if source.status == "deleted":
        raise NotFoundError("Memory not found")
    if source.scope == "agent":
        raise ValidationError("The note is already craft memory")
    if _ENTITY_REFERENCE.search(source.text):
        raise ValidationError(
            "Craft memory cannot reference workspace entities (project/material/work ids); "
            "rewrite the lesson in general terms before promoting."
        )
    duplicate = next(
        (n for n in ctx.memory.list(scope="agent", subject_id=agent_id, include_deleted=False)
         if n.text.strip().lower() == source.text.strip().lower()),
        None,
    )
    if duplicate is not None:
        return {"memory_id": duplicate.id, "agent_id": agent_id, "status": "duplicate",
                "source_memory_id": source.id}
    note = ctx.memory.add_approved(
        text=source.text,
        actor_id=actor.id,
        scope="agent",
        subject_id=agent_id,
        source_memory_id=source.id,
    )
    return {"memory_id": note.id, "agent_id": agent_id, "status": "promoted",
            "source_memory_id": source.id}
