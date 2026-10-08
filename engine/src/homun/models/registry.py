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
from homun.models.runtime_binding import bound_provider
from homun.models.guardrails import apply_interpretation_guardrails
from homun.models.interpret import run_interpret_with_retry
from homun.models.interpretation import MessageInterpretation, RosterEntry
from homun.models.conversation_context import ConversationContext
from homun.models.openai_compat import SECRET_KEY, OpenAICompatibleProvider
from homun.models.port import (Connection, ConnectionKind, ContextLimits, UNSET_PIN, UnsetPin,
                               effective_context_window)
from pydantic import ValidationError as SchemaError
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
        try:
            from homun.application.provider_registry import create_builtin_profiles
            builtin_profiles = create_builtin_profiles()
            for pid, prof in builtin_profiles.items():
                if pid in self._providers:
                    continue
                prof_cfg = self._config.get(pid) or {}
                b_url = str(prof_cfg.get("base_url") or prof.base_url or "https://api.openai.com/v1")
                default_mod = prof_cfg.get("default_model") or prof.default_aux_model or (prof.fallback_models[0] if prof.fallback_models else "default")
                self._providers[pid] = OpenAICompatibleProvider(
                    secrets=self.secrets,
                    base_url=b_url,
                    default_model=str(default_mod),
                    provider_id=pid,
                )
            for cid, cfg in self._config.items():
                if cid in self._providers or cid in ("active_provider_id", "version") or not isinstance(cfg, dict):
                    continue
                base_pid = cid.split(":")[0]
                prof = builtin_profiles.get(base_pid)
                b_url = str(cfg.get("base_url") or (prof.base_url if prof else "https://api.openai.com/v1"))
                default_mod = str(cfg.get("default_model") or (prof.default_aux_model if prof else "default"))
                self._providers[cid] = OpenAICompatibleProvider(
                    secrets=self.secrets,
                    base_url=b_url,
                    default_model=default_mod,
                    provider_id=base_pid,
                )
        except Exception:
            pass

    @property
    def active_provider_id(self) -> str:
        return str(self._config.get("active_provider_id") or "fake")

    @property
    def active(self):
        return self._providers.get(self.active_provider_id, self._fake)

    def set_active_provider(self, provider_id: str) -> None:
        if provider_id not in self._providers:
            raise KeyError(f"Unknown provider: {provider_id}")
        self._config["active_provider_id"] = provider_id
        self._save_config()

    def list_providers(self) -> list[ProviderInfo]:
        openai_cfg = self._config.get("openai_compatible") or {}
        res = [
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
                credential_present=self.secrets.has(SECRET_KEY) or self.secrets.has("provider:openai_compatible:api_key"),
                base_url=str(openai_cfg.get("base_url") or ""),
                default_model=str(openai_cfg.get("default_model") or ""),
                notes=[
                    "Default local path: Ollama at http://127.0.0.1:11434/v1",
                    "Requires explicit API key for remote hosts; local may use placeholder ollama",
                    "Secrets file is not encrypted (D-CRYPTO-01 pending)",
                ],
            ),
        ]
        try:
            from homun.application.provider_registry import create_builtin_profiles
            from homun.application.credential_pool import get_credential_pool
            pool = get_credential_pool()
            builtin_profiles = create_builtin_profiles()
            for pid, prof in builtin_profiles.items():
                if any(p.id == pid for p in res):
                    continue
                prof_cfg = self._config.get(pid) or {}
                has_cred = (
                    self.secrets.has(f"provider:{pid}:api_key")
                    or any(bool(os.environ.get(ev)) for ev in prof.env_vars)
                    or bool(pool.list_credentials(provider=pid))
                )
                default_mod = prof_cfg.get("default_model") or prof.default_aux_model or (prof.fallback_models[0] if prof.fallback_models else "")
                b_url = prof_cfg.get("base_url") or prof.base_url or ""
                res.append(
                    ProviderInfo(
                        id=pid,
                        kind="openai_compatible",
                        display_name=prof.display_name,
                        configured=True,
                        credential_present=has_cred,
                        default_model=str(default_mod),
                        base_url=str(b_url),
                        notes=[prof.description],
                    )
                )
            for cid, cfg in self._config.items():
                if any(p.id == cid for p in res) or cid in ("active_provider_id", "version") or not isinstance(cfg, dict):
                    continue
                base_pid = cid.split(":")[0]
                prof = builtin_profiles.get(base_pid)
                d_mod = str(cfg.get("default_model") or "")
                d_name = str(cfg.get("display_name") or (f"{prof.display_name} ({d_mod})" if prof and d_mod else cid))
                b_url = str(cfg.get("base_url") or (prof.base_url if prof else ""))
                has_cred = (
                    self.secrets.has(f"provider:{cid}:api_key")
                    or self.secrets.has(f"provider:{base_pid}:api_key")
                    or (prof and any(bool(os.environ.get(ev)) for ev in prof.env_vars))
                    or bool(pool.list_credentials(provider=base_pid))
                )
                res.append(
                    ProviderInfo(
                        id=cid,
                        kind="openai_compatible",
                        display_name=d_name,
                        configured=True,
                        credential_present=has_cred or base_pid == "ollama",
                        default_model=d_mod,
                        base_url=b_url,
                        notes=[prof.description if prof else ""],
                    )
                )
        except Exception:
            pass
        return res

    def list_connections(self) -> list[Connection]:
        """ModelPort view of providers — Homun Connection objects, no vendor types."""
        active = self.active_provider_id
        out: list[Connection] = []
        for info in self.list_providers():
            pins = self._config.get(info.id, {})
            out.append(
                Connection(
                    id=info.id,
                    kind=info.kind,
                    display_name=info.display_name,
                    model_id=info.default_model or info.id,
                    base_url=info.base_url,
                    context_window=effective_context_window(info.base_url, pins.get('context_window')) if info.kind == 'openai_compatible' else None,
                    max_output_tokens=pins.get('max_output_tokens', 8192),
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
        if ":" in connection_id:
            base_pid, model_name = connection_id.split(":", 1)
            for conn in self.list_connections():
                if conn.id == base_pid:
                    return Connection(
                        id=connection_id,
                        kind=conn.kind,
                        display_name=f"{conn.display_name} ({model_name})",
                        model_id=model_name,
                        base_url=conn.base_url,
                        context_window=conn.context_window,
                        max_output_tokens=conn.max_output_tokens,
                        configured=conn.configured,
                        credential_present=conn.credential_present,
                        active=conn.active,
                        notes=conn.notes,
                    )
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
        context_window: int | None | UnsetPin = UNSET_PIN,
        max_output_tokens: int | UnsetPin = UNSET_PIN,
    ) -> Connection:
        del display_name, pydantic_provider
        if kind == "fake":
            if context_window is not UNSET_PIN or max_output_tokens is not UNSET_PIN:
                raise ValidationError('Native context pins require an OpenAI-compatible connection')
            cid = connection_id or "fake"
            if cid != "fake":
                raise ValidationError("Built-in fake connection id must be 'fake'")
            return self.get_connection("fake")
        if kind == "openai_compatible":
            cid = connection_id or "openai_compatible"
            cfg = dict(self._config.get(cid) or (self._config.get("openai_compatible") if cid == "openai_compatible" else {}))
            if base_url is not None and base_url.strip():
                cfg["base_url"] = base_url.strip().rstrip("/")
            if model_id.strip():
                cfg["default_model"] = model_id.strip()
            if context_window is not UNSET_PIN:
                if context_window is None:
                    cfg.pop('context_window', None)
                else:
                    cfg['context_window'] = context_window
            if max_output_tokens is not UNSET_PIN:
                cfg['max_output_tokens'] = max_output_tokens
            try:
                ContextLimits(context_window=effective_context_window(cfg.get('base_url'), cfg.get('context_window')),
                              max_output_tokens=cfg.get('max_output_tokens', 8192))
            except SchemaError as exc:
                raise ValidationError('Invalid native context limits') from exc
            if api_key is not None and api_key.strip():
                clean_key = api_key.strip()
                self.secrets.put(f"provider:{cid}:api_key", clean_key)
                if cid == "openai_compatible":
                    self.secrets.put(SECRET_KEY, clean_key)
                try:
                    from homun.application.credential_pool import get_credential_pool
                    get_credential_pool().add_credential(cid, clean_key)
                except Exception:
                    pass
            self._config[cid] = cfg
            self._save_config()
            self._rebuild_providers()
            return self.get_connection(cid)
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
        self.upsert_connection(connection_id='openai_compatible', kind='openai_compatible',
                               display_name='OpenAI-compatible', model_id=default_model or '',
                               api_key=key, base_url=base_url)

    def clear_openai_credentials(self) -> None:
        self.secrets.delete(SECRET_KEY)

    def _get_provider(self, pid: str | None) -> Any:
        target_id = pid or self.active_provider_id
        # Preset alias: "ollama" may name the builtin profile or the user's
        # openai_compatible connection pointed at local Ollama. Prefer the
        # configured connection (its base_url and default_model are the
        # user's choice); the builtin profile only serves when no such
        # connection exists.
        if target_id == "ollama" and "openai_compatible" in self._providers:
            oc = self._providers["openai_compatible"]
            if isinstance(oc, OpenAICompatibleProvider) and "11434" in (getattr(oc, "base_url", "") or ""):
                return oc
        if target_id in self._providers:
            return self._providers[target_id]
        if target_id and ":" in target_id:
            base_pid, model_id = target_id.split(":", 1)
            base_prov = self._providers.get(base_pid)
            if base_prov is not None and isinstance(base_prov, OpenAICompatibleProvider):
                derived = OpenAICompatibleProvider(
                    secrets=self.secrets,
                    base_url=base_prov.base_url,
                    default_model=model_id,
                    provider_id=base_pid,
                )
                self._providers[target_id] = derived
                return derived
        return self._providers.get(target_id)

    def verify(
        self,
        provider_id: str | None = None,
        *,
        connection_id: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        model_id: str | None = None,
    ) -> VerifyResult:
        pid = connection_id or provider_id or self.active_provider_id
        provider = self._get_provider(pid)
        if provider is None:
            return VerifyResult(ok=False, provider_id=pid, message=f"Unknown provider: {pid}")
        if pid == "fake":
            return provider.verify_connection()
        if api_key or base_url or model_id:
            temp_b_url = base_url or getattr(provider, "base_url", "https://api.openai.com/v1")
            temp_mod = model_id or getattr(provider, "default_model", "gpt-4o-mini")
            temp_provider = OpenAICompatibleProvider(
                secrets=self.secrets,
                base_url=temp_b_url,
                default_model=temp_mod,
                provider_id=pid,
            )
            return temp_provider.verify_connection(api_key_override=api_key)
        return provider.verify_connection()

    def complete(
        self,
        messages: list[ChatMessage],
        *,
        provider_id: str | None = None,
        model_id: str | None = None,
        connection_id: str | None = None,
        expected_runtime: dict | None = None,
    ) -> CompletionResult:
        pid = connection_id or provider_id or self.active_provider_id
        provider = self._get_provider(pid)
        if provider is None:
            raise KeyError(f"Unknown provider: {pid}")
        provider = bound_provider(provider, pid, expected_runtime)
        result = provider.complete(messages, model_id=model_id)
        self.usage.append(result.usage)
        return result

    def complete_tools(self, messages, *, tools=None, connection_id=None, model_id=None, expected_runtime=None, context_window=None, max_output_tokens=8192,
                       stream=False, cancel_check=None, on_delta=None):
        from homun.domain.errors import ValidationError
        from homun.models.native_errors import NativeModelError
        from homun.models.native_transport import complete_tools
        pid = connection_id or self.active_provider_id
        provider = self._get_provider(pid)
        if not isinstance(provider, OpenAICompatibleProvider):
            raise ValidationError('Native tools require an OpenAI-compatible connection')
        provider = bound_provider(provider, pid, expected_runtime)
        try:
            result = complete_tools(provider, messages, tools=tools, model_id=model_id, context_window=context_window,
                                    max_output_tokens=max_output_tokens, stream=stream,
                                    cancel_check=cancel_check, on_delta=on_delta)
        except NativeModelError as exc:
            if isinstance(exc.usage, UsageEntry):
                self.usage.append(exc.usage)
            raise
        self.usage.append(result.usage)
        return result

    def complete_summary(self, messages, *, connection_id=None, model_id=None, expected_runtime=None, context_window=None, max_output_tokens=8192):
        from homun.models.native_errors import NativeModelError
        from homun.models.native_transport import complete_summary
        pid = connection_id or self.active_provider_id
        provider = self._get_provider(pid)
        if not isinstance(provider, OpenAICompatibleProvider):
            raise ValidationError('Native summaries require an OpenAI-compatible connection')
        provider = bound_provider(provider, connection_id or self.active_provider_id, expected_runtime)
        try:
            result = complete_summary(provider, messages, model_id=model_id, context_window=context_window,
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
        provider_id: str | None = None,
        model_id: str | None = None,
        cancel_check: Any | None = None,
    ) -> Iterator[str]:
        pid = connection_id or provider_id or self.active_provider_id
        provider = self._get_provider(pid)
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
                if cancel_check is not None and callable(cancel_check) and cancel_check():
                    break
            return
        try:
            stream_iter = stream_fn(messages, model_id=model_id, cancel_check=cancel_check)
        except TypeError:
            stream_iter = stream_fn(messages, model_id=model_id)
        for chunk in stream_iter:
            yield chunk
            if cancel_check is not None and callable(cancel_check) and cancel_check():
                break
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
        prov = self._get_provider(pid)
        if prov is None:
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
