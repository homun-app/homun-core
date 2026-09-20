"""Model provider protocol (F3.1)."""

from __future__ import annotations

from typing import Protocol

from homun.models.types import ChatMessage, CompletionResult, VerifyResult


class ModelProvider(Protocol):
    provider_id: str

    def verify_connection(self) -> VerifyResult: ...

    def complete(self, messages: list[ChatMessage], *, model_id: str | None = None) -> CompletionResult: ...
