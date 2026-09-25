"""OpenAI-compatible ModelPort adapter — thin wrap of OpenAICompatibleProvider."""

from __future__ import annotations

from collections.abc import Iterator

from homun.domain.errors import NotFoundError, ValidationError
from homun.models.openai_compat import SECRET_KEY, OpenAICompatibleProvider
from homun.models.port import (Connection, ConnectionKind, ContextLimits, UNSET_PIN, UnsetPin,
                               effective_context_window)
from pydantic import ValidationError as SchemaError
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
        self._context_window_pin = None
        self._max_output_tokens = 8192
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
            context_window=effective_context_window(self._base_url, self._context_window_pin),
            max_output_tokens=self._max_output_tokens,
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
        context_window: int | None | UnsetPin = UNSET_PIN,
        max_output_tokens: int | UnsetPin = UNSET_PIN,
    ) -> Connection:
        del pydantic_provider
        if kind != "openai_compatible":
            raise ValidationError("OpenAICompatModelAdapter only accepts kind=openai_compatible")
        pin = self._context_window_pin if context_window is UNSET_PIN else context_window
        output = self._max_output_tokens if max_output_tokens is UNSET_PIN else max_output_tokens
        url = base_url.strip().rstrip('/') if base_url and base_url.strip() else self._base_url
        try:
            ContextLimits(context_window=effective_context_window(url, pin), max_output_tokens=output)
        except SchemaError as exc:
            raise ValidationError('Invalid native context limits') from exc
        self._context_window_pin, self._max_output_tokens = pin, output
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

    def complete_tools(self, messages, *, tools=None, connection_id=None, model_id=None, context_window=None, max_output_tokens=8192):
        from homun.models.native_errors import NativeModelError
        from homun.models.native_transport import complete_tools
        if connection_id is not None:
            self.get_connection(connection_id)
        try:
            result = complete_tools(self._provider, messages, tools=tools, model_id=model_id, context_window=context_window,
                                    max_output_tokens=max_output_tokens)
        except NativeModelError as exc:
            if isinstance(exc.usage, UsageEntry):
                self.usage.append(exc.usage)
            raise
        self.usage.append(result.usage)
        return result

    def complete_summary(self, messages, *, connection_id=None, context_window=None, max_output_tokens=8192):
        from homun.models.native_errors import NativeModelError
        from homun.models.native_transport import complete_summary
        if connection_id is not None:
            self.get_connection(connection_id)
        try:
            result = complete_summary(self._provider, messages, context_window=context_window,
                                      max_output_tokens=max_output_tokens)
        except NativeModelError as exc:
            if isinstance(exc.usage, UsageEntry):
                self.usage.append(exc.usage)
            raise
        self.usage.append(result.usage)
        return result

    def stream(
        self,
        messages: list[ChatMessage],
        *,
        connection_id: str | None = None,
        cancel_check: Any | None = None,
    ) -> Iterator[str]:
        if connection_id is not None and connection_id != self._connection_id:
            raise NotFoundError(f"Unknown connection: {connection_id}")
        for chunk in self._provider.stream(messages, cancel_check=cancel_check):
            if cancel_check is not None and callable(cancel_check) and cancel_check():
                break
            yield chunk
        last = getattr(self._provider, "last_stream_result", None)
        if last is not None:
            self.usage.append(last.usage)

    def list_usage(self, *, limit: int = 50) -> list[UsageEntry]:
        return self.usage[-max(1, min(limit, 200)) :]
