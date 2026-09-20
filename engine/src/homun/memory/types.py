"""MemoryPort protocol and approved-note types (F3.5a slice A)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from homun.domain.ids import new_id


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class MemoryNote(BaseModel):
    id: str
    workspace_id: str
    text: str
    work_id: str | None = None
    project_id: str | None = None
    status: Literal["approved", "rectified", "deleted"] = "approved"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    created_by: str = ""


class MemoryPort(Protocol):
    def list(
        self,
        *,
        work_id: str | None = None,
        project_id: str | None = None,
        include_deleted: bool = False,
    ) -> list[MemoryNote]: ...

    def add_approved(
        self,
        *,
        text: str,
        actor_id: str,
        work_id: str | None = None,
        project_id: str | None = None,
    ) -> MemoryNote: ...

    def rectify(self, memory_id: str, *, text: str, actor_id: str) -> MemoryNote: ...

    def delete(self, memory_id: str, *, actor_id: str) -> MemoryNote: ...

    def export(self, *, project_id: str | None = None) -> list[MemoryNote]: ...

    def recall(
        self,
        query: str,
        *,
        project_id: str | None = None,
        limit: int = 10,
    ) -> list[MemoryNote]: ...


def new_memory_id() -> str:
    return new_id("mem")
