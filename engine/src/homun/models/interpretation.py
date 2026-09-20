"""Structured message interpretation types (F3.2 / F3.4)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


from homun.domain.roster import RosterEntry  # public compatibility re-export


class MentionCandidate(BaseModel):
    id: str
    display_name: str
    kind: Literal["person", "agent", "other"] = "person"


class MentionResolution(BaseModel):
    raw: str
    candidates: list[MentionCandidate] = Field(default_factory=list)


class CommandProposal(BaseModel):
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    summary: str


class PatchChangeDraft(BaseModel):
    """Unvalidated draft change from the model; engine runs preview_patch before UI."""

    field: Literal["objective", "owner_id", "step_assignee"]
    to_value: str | None = None
    step_id: str | None = None


class MessageInterpretation(BaseModel):
    kind: Literal["reply", "clarification", "command_proposal", "patch_proposal"]
    text: str | None = None
    command: CommandProposal | None = None
    patch_changes: list[PatchChangeDraft] = Field(default_factory=list)
    mentions: list[MentionResolution] = Field(default_factory=list)
    ambiguity: str | None = None
    language_hint: str | None = None
