"""Fake ModelPort adapter — deterministic, no network."""

from __future__ import annotations

from collections.abc import Iterator

from homun.domain.errors import NotFoundError, ValidationError
from homun.models.fake import FakeProvider
from homun.models.port import Connection, ConnectionKind
from homun.models.types import ChatMessage, CompletionResult, UsageEntry, VerifyResult


class FakeModelAdapter:
    """Implements ModelPort surface for the fake provider."""

    def __init__(self) -> None:
        self._provider = FakeProvider()
        self._connection = Connection(
            id="fake",
            kind="fake",
            display_name="Fake (deterministic)",
            model_id="fake-v1",
            configured=True,
            credential_present=True,
            active=True,
            notes=["No network; for tests and offline demos."],
        )
        self.usage: list[UsageEntry] = []

    def list_connections(self) -> list[Connection]:
        return [self._connection.model_copy(deep=True)]

    def get_connection(self, connection_id: str) -> Connection:
        if connection_id != self._connection.id:
            raise NotFoundError(f"Unknown connection: {connection_id}")
        return self._connection.model_copy(deep=True)

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
    ) -> Connection:
        del base_url, pydantic_provider, api_key
        if kind != "fake":
            raise ValidationError("FakeModelAdapter only accepts kind=fake")
        self._connection = Connection(
            id=connection_id or "fake",
            kind="fake",
            display_name=display_name or "Fake (deterministic)",
            model_id=model_id or "fake-v1",
            configured=True,
            credential_present=True,
            active=True,
        )
        return self.get_connection(self._connection.id)

    def delete_connection(self, connection_id: str) -> None:
        raise ValidationError("Cannot delete the built-in fake connection")

    def set_active(self, connection_id: str) -> Connection:
        return self.get_connection(connection_id)

    def verify(self, connection_id: str | None = None) -> VerifyResult:
        del connection_id
        return self._provider.verify_connection()

    def complete(
        self,
        messages: list[ChatMessage],
        *,
        connection_id: str | None = None,
    ) -> CompletionResult:
        del connection_id
        result = self._provider.complete(messages)
        self.usage.append(result.usage)
        return result

    def stream(
        self,
        messages: list[ChatMessage],
        *,
        connection_id: str | None = None,
    ) -> Iterator[str]:
        for chunk in self._provider.stream(messages):
            yield chunk
        last = getattr(self._provider, "last_stream_result", None)
        if last is not None:
            self.usage.append(last.usage)

    def list_usage(self, *, limit: int = 50) -> list[UsageEntry]:
        return self.usage[-max(1, min(limit, 200)) :]
