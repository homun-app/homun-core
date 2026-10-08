"""Central visibility rules for scoped memories.

Who may see a note, by scope:
- project: notes of the given project, or notes bound to the given work
- agent:   craft notes of the given agent (transferable methodology)
- person:  notes of the given person only
- global:  workspace-wide curated facts; excluded from agent-run recall
  unless explicitly requested (the cross-project leak stays closed).
"""
from __future__ import annotations

from homun.memory.types import MemoryNote


def matches_context(
    note: MemoryNote,
    *,
    project_id: str | None = None,
    work_id: str | None = None,
    agent_id: str | None = None,
    person_id: str | None = None,
    include_global: bool = False,
) -> bool:
    if note.scope == "project":
        if project_id is not None and note.project_id == project_id:
            return True
        return work_id is not None and note.work_id == work_id
    if note.scope == "agent":
        return agent_id is not None and note.subject_id == agent_id
    if note.scope == "person":
        return person_id is not None and note.subject_id == person_id
    if note.scope == "global":
        # Legacy work-bound notes (written before scopes) stay visible to
        # their own work; they are not workspace-wide knowledge.
        if work_id is not None and note.work_id == work_id:
            return True
        return bool(include_global)
    return False
