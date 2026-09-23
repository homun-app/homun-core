"""Homun ModelPort — LLM connections without vendor lock-in.

Adapters (Pydantic AI, OpenAI-compat, Fake) live under models/adapters/.
Callers must only depend on this module and models.types.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Literal, Protocol, TYPE_CHECKING

if TYPE_CHECKING:
    from homun.models.agent_turn import ToolDefinition
    from homun.models.native_turn import NativeMessage, NativeResult

from enum import Enum
from urllib.parse import urlparse
from pydantic import BaseModel, Field, model_validator

from homun.models.types import ChatMessage, CompletionResult, UsageEntry, VerifyResult, utc_now


ConnectionKind = Literal["fake", "openai_compatible", "pydantic_ai"]


class UnsetPin(Enum):
    VALUE = 'unset'


UNSET_PIN = UnsetPin.VALUE
DEFAULT_LOCAL_CONTEXT_WINDOW = 16384
DEFAULT_MAX_OUTPUT_TOKENS = 8192


def effective_context_window(base_url: str | None, pin: int | None) -> int | None:
    """Homun's requested local context, never an inferred model training maximum."""
    if pin is not None:
        return pin
    url = urlparse(base_url or '')
    try:
        local_ollama = url.hostname in {'localhost', '127.0.0.1', '::1'} and url.port == 11434
    except ValueError:
        local_ollama = False
    return DEFAULT_LOCAL_CONTEXT_WINDOW if local_ollama else None


class ContextLimits(BaseModel):
    context_window: int | None = Field(default=None, gt=0, strict=True)
    max_output_tokens: int = Field(default=DEFAULT_MAX_OUTPUT_TOKENS, gt=0, strict=True)

    @model_validator(mode='after')
    def output_fits_context(self):
        if self.context_window is not None and self.max_output_tokens >= self.context_window:
            raise ValueError('max_output_tokens must be smaller than context_window')
        return self


class Connection(ContextLimits):
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
        context_window: int | None | UnsetPin = UNSET_PIN,
        max_output_tokens: int | UnsetPin = UNSET_PIN,
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


class NativeToolPort(ModelPort, Protocol):
    """Optional native conversation surface; separate from plain-chat adapters."""

    def complete_tools(self, messages: list["NativeMessage"], *, tools: list["ToolDefinition"],
                       connection_id: str | None = None, context_window: int | None = None,
                       max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS) -> "NativeResult": ...

    def complete_summary(self, messages: list["NativeMessage"], *, connection_id: str | None = None,
                         context_window: int | None = None,
                         max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS) -> "NativeResult": ...


# Re-export for callers that import port only
__all__ = [
    "ChatMessage",
    "CompletionResult",
    "Connection",
    "ConnectionKind",
    "ModelPort",
    "NativeToolPort",
    "UsageEntry",
    "VerifyResult",
    "utc_now",
]
