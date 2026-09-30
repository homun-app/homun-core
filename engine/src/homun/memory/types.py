"""MemoryPort protocol and approved-note types (F3.5a slice A)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field, model_validator

from homun.domain.ids import new_id


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


MemoryScope = Literal["project", "agent", "person", "global"]


class MemoryNote(BaseModel):
    id: str
    workspace_id: str
    text: str
    work_id: str | None = None
    project_id: str | None = None
    # Who the knowledge belongs to. Legacy payloads without scope derive
    # "project" when a project_id is recorded, else stay workspace-global.
    scope: MemoryScope = "global"
    # agent id (scope=agent) or person id (scope=person); None otherwise.
    subject_id: str | None = None
    # Provenance when the note was promoted from project memory into craft.
    source_memory_id: str | None = None
    status: Literal["approved", "rectified", "deleted"] = "approved"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    created_by: str = ""

    @model_validator(mode="before")
    @classmethod
    def _derive_legacy_scope(cls, values: Any) -> Any:
        if isinstance(values, dict) and "scope" not in values and values.get("project_id"):
            values = {**values, "scope": "project"}
        return values


class MemoryPort(Protocol):
    def list(
        self,
        *,
        work_id: str | None = None,
        project_id: str | None = None,
        scope: str | None = None,
        subject_id: str | None = None,
        include_deleted: bool = False,
    ) -> list[MemoryNote]: ...

    def add_approved(
        self,
        *,
        text: str,
        actor_id: str,
        work_id: str | None = None,
        project_id: str | None = None,
        scope: str | None = None,
        subject_id: str | None = None,
        source_memory_id: str | None = None,
    ) -> MemoryNote: ...

    def rectify(self, memory_id: str, *, text: str, actor_id: str) -> MemoryNote: ...

    def delete(self, memory_id: str, *, actor_id: str) -> MemoryNote: ...

    def export(
        self,
        *,
        project_id: str | None = None,
        scope: str | None = None,
        subject_id: str | None = None,
    ) -> list[MemoryNote]: ...

    def recall(
        self,
        query: str,
        *,
        project_id: str | None = None,
        work_id: str | None = None,
        agent_id: str | None = None,
        person_id: str | None = None,
        scope: str | None = None,
        subject_id: str | None = None,
        include_global: bool = True,
        limit: int = 10,
    ) -> list[MemoryNote]: ...


def new_memory_id() -> str:
    return new_id("mem")
