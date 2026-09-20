"""OpenAI-compatible ModelPort adapter — thin wrap of OpenAICompatibleProvider."""

from __future__ import annotations

from collections.abc import Iterator

from homun.domain.errors import NotFoundError, ValidationError
from homun.models.openai_compat import SECRET_KEY, OpenAICompatibleProvider
from homun.models.port import Connection, ConnectionKind
from homun.models.secrets import SecretStore
from homun.models.types import ChatMessage, CompletionResult, UsageEntry, VerifyResult


class OpenAICompatModelAdapter:
    """Implements ModelPort surface for openai_compatible connections."""

    def __init__(
        self,
        *,
        secrets: SecretStore,
        base_url: str = "http://127.0.0.1:11434/v1",
        default_model: str = "qwen3.5:4b",
        connection_id: str = "openai_compatible",
        display_name: str = "OpenAI-compatible",
    ) -> None:
        self._secrets = secrets
        self._base_url = base_url.rstrip("/")
        self._default_model = default_model
        self._connection_id = connection_id
        self._display_name = display_name
        self._active = True
        self.usage: list[UsageEntry] = []
        self._rebuild()

    def _rebuild(self) -> None:
        self._provider = OpenAICompatibleProvider(
            secrets=self._secrets,
            base_url=self._base_url,
            default_model=self._default_model,
        )

    def _connection(self) -> Connection:
        return Connection(
            id=self._connection_id,
            kind="openai_compatible",
            display_name=self._display_name,
            model_id=self._default_model,
            base_url=self._base_url,
            configured=True,
            credential_present=self._secrets.has(SECRET_KEY),
            active=self._active,
            notes=["OpenAI-compatible HTTP (Ollama or cloud)."],
        )

    def list_connections(self) -> list[Connection]:
        return [self._connection()]

    def get_connection(self, connection_id: str) -> Connection:
        if connection_id != self._connection_id:
            raise NotFoundError(f"Unknown connection: {connection_id}")
        return self._connection()

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
        del pydantic_provider
        if kind != "openai_compatible":
            raise ValidationError("OpenAICompatModelAdapter only accepts kind=openai_compatible")
        if connection_id:
            self._connection_id = connection_id
        if display_name.strip():
            self._display_name = display_name.strip()
        if model_id.strip():
            self._default_model = model_id.strip()
        if base_url and base_url.strip():
            self._base_url = base_url.strip().rstrip("/")
        if api_key is not None and api_key.strip():
            self._secrets.put(SECRET_KEY, api_key.strip())
        self._rebuild()
        return self.get_connection(self._connection_id)

    def delete_connection(self, connection_id: str) -> None:
        raise ValidationError("Cannot delete the built-in openai_compatible connection")

    def set_active(self, connection_id: str) -> Connection:
        conn = self.get_connection(connection_id)
        self._active = True
        return conn

    def verify(self, connection_id: str | None = None) -> VerifyResult:
        if connection_id is not None and connection_id != self._connection_id:
            raise NotFoundError(f"Unknown connection: {connection_id}")
        return self._provider.verify_connection()

    def complete(
        self,
        messages: list[ChatMessage],
        *,
        connection_id: str | None = None,
    ) -> CompletionResult:
        if connection_id is not None and connection_id != self._connection_id:
            raise NotFoundError(f"Unknown connection: {connection_id}")
        result = self._provider.complete(messages)
        self.usage.append(result.usage)
        return result

    def stream(
        self,
        messages: list[ChatMessage],
        *,
        connection_id: str | None = None,
    ) -> Iterator[str]:
        if connection_id is not None and connection_id != self._connection_id:
            raise NotFoundError(f"Unknown connection: {connection_id}")
        for chunk in self._provider.stream(messages):
            yield chunk
        last = getattr(self._provider, "last_stream_result", None)
        if last is not None:
            self.usage.append(last.usage)

    def list_usage(self, *, limit: int = 50) -> list[UsageEntry]:
        return self.usage[-max(1, min(limit, 200)) :]
