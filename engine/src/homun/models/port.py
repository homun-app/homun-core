"""Homun ModelPort — LLM connections without vendor lock-in.

Adapters (Pydantic AI, OpenAI-compat, Fake) live under models/adapters/.
Callers must only depend on this module and models.types.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from homun.models.types import ChatMessage, CompletionResult, UsageEntry, VerifyResult, utc_now


ConnectionKind = Literal["fake", "openai_compatible", "pydantic_ai"]


class Connection(BaseModel):
    """Configured LLM connection (secrets never included)."""

    id: str
    kind: ConnectionKind
    display_name: str
    model_id: str
    base_url: str | None = None
    pydantic_provider: str | None = None
    configured: bool = True
    credential_present: bool = False
    active: bool = False
    notes: list[str] = Field(default_factory=list)
    updated_at: str | None = None


class ModelPort(Protocol):
    """Replaceable model runtime surface for Homun."""

    def list_connections(self) -> list[Connection]: ...

    def get_connection(self, connection_id: str) -> Connection: ...

    def upsert_connection(
        self,
        *,
        connection_id: str | None,
        kind: ConnectionKind,
        display_name: str,
        model_id: str,
        base_url: str | None = None,
        pydantic_provider: str | None = None,
        api_key: str | None = None,
    ) -> Connection: ...

    def delete_connection(self, connection_id: str) -> None: ...

    def set_active(self, connection_id: str) -> Connection: ...

    def verify(self, connection_id: str | None = None) -> VerifyResult: ...

    def complete(
        self,
        messages: list[ChatMessage],
        *,
        connection_id: str | None = None,
    ) -> CompletionResult: ...

    def stream(
        self,
        messages: list[ChatMessage],
        *,
        connection_id: str | None = None,
    ) -> Iterator[str]: ...

    def list_usage(self, *, limit: int = 50) -> list[UsageEntry]: ...


# Re-export for callers that import port only
__all__ = [
    "ChatMessage",
    "CompletionResult",
    "Connection",
    "ConnectionKind",
    "ModelPort",
    "UsageEntry",
    "VerifyResult",
    "utc_now",
]
