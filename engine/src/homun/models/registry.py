"""Model provider registry and configuration (F3.1)."""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from homun.domain.errors import NotFoundError, ValidationError
from homun.domain.ids import new_id
from homun.models.fake import FakeProvider
from homun.models.guardrails import apply_interpretation_guardrails
from homun.models.interpret import run_interpret_with_retry
from homun.models.interpretation import MessageInterpretation, RosterEntry
from homun.models.conversation_context import ConversationContext
from homun.models.openai_compat import SECRET_KEY, OpenAICompatibleProvider
from homun.models.port import Connection, ConnectionKind
from homun.models.prompt_store import PromptStore
from homun.models.secrets import FileSecretStore, MemorySecretStore, SecretStore
from homun.models.types import (
    AttemptContext,
    ChatMessage,
    CompletionResult,
    ProviderInfo,
    UsageAttempt,
    UsageEntry,
    VerifyResult,
    utc_now,
)


class ModelRegistry:
    """Owns provider selection, credentials, and usage ledger for the process."""

    def __init__(
        self,
        *,
        data_dir: Path,
        secrets: SecretStore | None = None,
        active_provider_id: str | None = None,
    ) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_path = self.data_dir / "models.json"
        # Workspace language for prompt selection (HOMUN_LANGUAGE, default Italian);
        # output always follows the request language through the prompt rules.
        self.prompts = PromptStore(default_language=os.environ.get("HOMUN_LANGUAGE", "it"))
        self.secrets: SecretStore = secrets or FileSecretStore(self.data_dir / "secrets.json")
        self.usage: list[UsageEntry] = []
        self.attempts: list[UsageAttempt] = []
        self.workspace_id: str = ""
        self._config = self._load_config()
        if active_provider_id is not None:
            self._config["active_provider_id"] = active_provider_id
        self._rebuild_providers()

    def _load_config(self) -> dict[str, Any]:
        if not self.config_path.exists():
            return {
                "active_provider_id": "openai_compatible",
                "openai_compatible": {
                    "base_url": "http://127.0.0.1:11434/v1",
                    "default_model": "qwen3.5:4b",
                },
            }
        raw = json.loads(self.config_path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}

    def _save_config(self) -> None:
        self.config_path.write_text(
            json.dumps(self._config, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    def _rebuild_providers(self) -> None:
        openai_cfg = self._config.get("openai_compatible") or {}
        self._fake = FakeProvider()
        self._openai = OpenAICompatibleProvider(
            secrets=self.secrets,
            base_url=str(openai_cfg.get("base_url") or "https://api.openai.com/v1"),
            default_model=str(openai_cfg.get("default_model") or "gpt-4o-mini"),
        )
        self._providers = {
            self._fake.provider_id: self._fake,
            self._openai.provider_id: self._openai,
        }

    @property
    def active_provider_id(self) -> str:
        return str(self._config.get("active_provider_id") or "fake")

    def set_active_provider(self, provider_id: str) -> None:
        if provider_id not in self._providers:
            raise KeyError(f"Unknown provider: {provider_id}")
        self._config["active_provider_id"] = provider_id
        self._save_config()

    def list_providers(self) -> list[ProviderInfo]:
        openai_cfg = self._config.get("openai_compatible") or {}
        return [
            ProviderInfo(
                id="fake",
                kind="fake",
                display_name="Fake deterministico",
                configured=True,
                credential_present=True,
                default_model=self._fake.default_model,
                notes=["No network", "Deterministic completions for tests"],
            ),
            ProviderInfo(
                id="openai_compatible",
                kind="openai_compatible",
                display_name="OpenAI-compatible",
                configured=True,
                credential_present=self.secrets.has(SECRET_KEY),
                base_url=str(openai_cfg.get("base_url") or ""),
                default_model=str(openai_cfg.get("default_model") or ""),
                notes=[
                    "Default local path: Ollama at http://127.0.0.1:11434/v1",
                    "Requires explicit API key for remote hosts; local may use placeholder ollama",
                    "Secrets file is not encrypted (D-CRYPTO-01 pending)",
                ],
            ),
        ]

    def list_connections(self) -> list[Connection]:
        """ModelPort view of providers — Homun Connection objects, no vendor types."""
        active = self.active_provider_id
        out: list[Connection] = []
        for info in self.list_providers():
            out.append(
                Connection(
                    id=info.id,
                    kind=info.kind,
                    display_name=info.display_name,
                    model_id=info.default_model or info.id,
                    base_url=info.base_url,
                    configured=info.configured,
                    credential_present=info.credential_present,
                    active=info.id == active,
                    notes=list(info.notes),
                )
            )
        return out

    def get_connection(self, connection_id: str) -> Connection:
        for conn in self.list_connections():
            if conn.id == connection_id:
                return conn
        raise NotFoundError(f"Unknown connection: {connection_id}")

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
        del display_name, pydantic_provider
        if kind == "fake":
            cid = connection_id or "fake"
            if cid != "fake":
                raise ValidationError("Built-in fake connection id must be 'fake'")
            return self.get_connection("fake")
        if kind == "openai_compatible":
            if api_key is not None and api_key.strip():
                self.set_openai_credentials(
                    api_key=api_key,
                    base_url=base_url,
                    default_model=model_id or None,
                )
            else:
                openai_cfg = dict(self._config.get("openai_compatible") or {})
                if base_url is not None and base_url.strip():
                    openai_cfg["base_url"] = base_url.strip().rstrip("/")
                if model_id.strip():
                    openai_cfg["default_model"] = model_id.strip()
                self._config["openai_compatible"] = openai_cfg
                self._save_config()
                self._rebuild_providers()
            return self.get_connection("openai_compatible")
        if kind == "pydantic_ai":
            raise ValidationError(
                "kind=pydantic_ai connections are not registered yet; use openai_compatible or fake"
            )
        raise ValidationError(f"Unsupported connection kind: {kind}")

    def delete_connection(self, connection_id: str) -> None:
        raise ValidationError(f"Cannot delete built-in connection: {connection_id}")

    def set_active(self, connection_id: str) -> Connection:
        self.set_active_provider(connection_id)
        return self.get_connection(connection_id)

    def set_openai_credentials(self, *, api_key: str, base_url: str | None = None, default_model: str | None = None) -> None:
        key = api_key.strip()
        if not key:
            raise ValueError("api_key is required")
        self.secrets.put(SECRET_KEY, key)
        openai_cfg = dict(self._config.get("openai_compatible") or {})
        if base_url is not None and base_url.strip():
            openai_cfg["base_url"] = base_url.strip().rstrip("/")
        if default_model is not None and default_model.strip():
            openai_cfg["default_model"] = default_model.strip()
        self._config["openai_compatible"] = openai_cfg
        self._save_config()
        self._rebuild_providers()

    def clear_openai_credentials(self) -> None:
        self.secrets.delete(SECRET_KEY)

    def verify(self, provider_id: str | None = None, *, connection_id: str | None = None) -> VerifyResult:
        pid = connection_id or provider_id or self.active_provider_id
        provider = self._providers.get(pid)
        if provider is None:
            return VerifyResult(ok=False, provider_id=pid, message=f"Unknown provider: {pid}")
        return provider.verify_connection()

    def complete(
        self,
        messages: list[ChatMessage],
        *,
        provider_id: str | None = None,
        model_id: str | None = None,
        connection_id: str | None = None,
    ) -> CompletionResult:
        pid = connection_id or provider_id or self.active_provider_id
        provider = self._providers.get(pid)
        if provider is None:
            raise KeyError(f"Unknown provider: {pid}")
        result = provider.complete(messages, model_id=model_id)
        self.usage.append(result.usage)
        return result

    def stream(
        self,
        messages: list[ChatMessage],
        *,
        connection_id: str | None = None,
        provider_id: str | None = None,
        model_id: str | None = None,
    ) -> Iterator[str]:
        pid = connection_id or provider_id or self.active_provider_id
        provider = self._providers.get(pid)
        if provider is None:
            raise KeyError(f"Unknown provider: {pid}")
        stream_fn = getattr(provider, "stream", None)
        if stream_fn is None:
            text = self.complete(
                messages,
                connection_id=connection_id,
                provider_id=provider_id,
                model_id=model_id,
            ).text
            size = 24
            for i in range(0, len(text), size):
                yield text[i : i + size]
            return
        for chunk in stream_fn(messages, model_id=model_id):
            yield chunk
        last = getattr(provider, "last_stream_result", None)
        if last is not None and isinstance(last, CompletionResult):
            self.usage.append(last.usage)

    def stream_known_text(self, text: str, *, size: int = 24) -> Iterator[str]:
        """Present already-known assistant text with ModelPort chunking (no LLM call)."""
        cleaned = text.strip()
        if not cleaned:
            return
        for i in range(0, len(cleaned), size):
            yield cleaned[i : i + size]

    def list_usage(self, *, limit: int = 50) -> list[UsageEntry]:
        return self.usage[-max(1, min(limit, 200)) :]

    def list_attempts(self, *, limit: int = 50) -> list[UsageAttempt]:
        return self.attempts[-max(1, min(limit, 200)) :]

    def append_attempt(self, attempt: UsageAttempt) -> UsageAttempt:
        self.attempts.append(attempt)
        return attempt

    def interpret(
        self,
        text: str,
        *,
        roster: list[RosterEntry],
        provider_id: str | None = None,
        context: AttemptContext | None = None,
        conversation_context: ConversationContext | None = None,
    ) -> MessageInterpretation:
        pid = provider_id or self.active_provider_id
        if pid not in self._providers:
            raise KeyError(f"Unknown provider: {pid}")
        raw = run_interpret_with_retry(
            self,
            text,
            roster=roster,
            provider_id=pid,
            context=context,
            conversation_context=conversation_context,
        )
        return apply_interpretation_guardrails(raw, roster)

    def apply_ollama_preset(self, *, model: str = "qwen3.5:4b") -> None:
        """Point openai_compatible at local Ollama and activate it."""
        model_id = model.strip() or "qwen3.5:4b"
        self.secrets.put(SECRET_KEY, "ollama")
        self._config["openai_compatible"] = {
            "base_url": "http://127.0.0.1:11434/v1",
            "default_model": model_id,
        }
        self._config["active_provider_id"] = "openai_compatible"
        self._save_config()
        self._rebuild_providers()


def build_default_registry(data_dir: Path, *, for_tests: bool = False) -> ModelRegistry:
    secrets: SecretStore = MemorySecretStore() if for_tests else FileSecretStore(data_dir / "secrets.json")
    if for_tests:
        return ModelRegistry(data_dir=data_dir, secrets=secrets, active_provider_id="fake")
    registry = ModelRegistry(data_dir=data_dir, secrets=secrets, active_provider_id=None)
    if registry.config_path.exists() and registry.active_provider_id == "fake":
        # An explicit configuration that selects the deterministic fake provider
        # is respected as written (offline/CI profiles); it used to be silently
        # replaced by the Ollama preset.
        return registry
    # Product default: local Ollama. Fake remains available for explicit switch / CI.
    if registry.active_provider_id == "fake":
        registry.apply_ollama_preset()
    else:
        host = str((registry._config.get("openai_compatible") or {}).get("base_url") or "")
        local = "127.0.0.1" in host or "localhost" in host
        if local and not registry.secrets.has(SECRET_KEY):
            registry.secrets.put(SECRET_KEY, "ollama")
            registry._rebuild_providers()
        if not registry.config_path.exists():
            registry._save_config()
    return registry
