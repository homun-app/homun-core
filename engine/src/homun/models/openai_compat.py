"""OpenAI-compatible HTTP provider adapter (F3.1 first real adapter)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from homun.domain.ids import new_id
from homun.models.secrets import SecretStore
from homun.models.types import ChatMessage, CompletionResult, UsageEntry, VerifyResult

SECRET_KEY = "provider:openai_compatible:api_key"


def assistant_text_from_message(message: dict[str, Any]) -> str:
    """Prefer final content; fall back to reasoning when thinking models leave content empty."""
    content = str(message.get("content") or "").strip()
    if content:
        return content
    for key in ("reasoning", "reasoning_content", "thinking"):
        raw = message.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return ""


class OpenAICompatibleProvider:
    """Talks to OpenAI-compatible /v1/chat/completions (also Ollama-compatible gateways)."""

    provider_id = "openai_compatible"

    def __init__(
        self,
        *,
        secrets: SecretStore,
        base_url: str = "https://api.openai.com/v1",
        default_model: str = "gpt-4o-mini",
        timeout_seconds: float = 120.0,
    ) -> None:
        self._secrets = secrets
        self.base_url = base_url.rstrip("/")
        self.default_model = default_model
        self.timeout_seconds = timeout_seconds
        self.last_stream_result: CompletionResult | None = None

    def _api_key(self) -> str | None:
        key = self._secrets.get(SECRET_KEY)
        if key:
            return key
        # Local OpenAI-compatible gateways (e.g. Ollama) often need no real key.
        host = self.base_url.lower()
        if "127.0.0.1" in host or "localhost" in host:
            return "ollama"
        return None

    def _is_local_host(self) -> bool:
        host = self.base_url.lower()
        return "127.0.0.1" in host or "localhost" in host

    def _ollama_native_root(self) -> str | None:
        """Return Ollama root URL when base_url looks like a local Ollama OpenAI gateway."""
        if not self._is_local_host():
            return None
        root = self.base_url
        if root.endswith("/v1"):
            root = root[: -len("/v1")]
        # Prefer native /api/chat when talking to the usual Ollama port.
        if ":11434" in root:
            return root
        return None

    def verify_connection(self) -> VerifyResult:
        api_key = self._api_key()
        if not api_key:
            return VerifyResult(
                ok=False,
                provider_id=self.provider_id,
                message="Missing API key. Set credentials explicitly before verifying.",
            )
        try:
            if self._ollama_native_root() is not None:
                payload = self._post_ollama_chat(
                    {
                        "model": self.default_model,
                        "messages": [{"role": "user", "content": "ping"}],
                        "stream": False,
                        "think": False,
                        "options": {"num_predict": 8},
                    }
                )
                message = payload.get("message") if isinstance(payload, dict) else None
                if not isinstance(message, dict):
                    return VerifyResult(
                        ok=False,
                        provider_id=self.provider_id,
                        message="Unexpected Ollama response shape.",
                    )
            else:
                payload = self._post(
                    "/chat/completions",
                    {
                        "model": self.default_model,
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 8,
                    },
                    api_key=api_key,
                )
                if not isinstance(payload, dict) or "choices" not in payload:
                    return VerifyResult(
                        ok=False,
                        provider_id=self.provider_id,
                        message="Unexpected provider response shape.",
                    )
        except Exception as exc:  # noqa: BLE001 — surface as verify failure
            return VerifyResult(
                ok=False,
                provider_id=self.provider_id,
                message=f"Provider unreachable or rejected credentials: {exc}",
            )
        return VerifyResult(
            ok=True,
            provider_id=self.provider_id,
            message=f"Connected to {self.base_url} · model {self.default_model}",
        )

    def complete(self, messages: list[ChatMessage], *, model_id: str | None = None) -> CompletionResult:
        api_key = self._api_key()
        if not api_key:
            raise RuntimeError("openai_compatible provider has no API key configured")
        model = model_id or self.default_model
        chat_messages = [{"role": m.role, "content": m.content} for m in messages]

        if self._ollama_native_root() is not None:
            payload = self._post_ollama_chat(
                {
                    "model": model,
                    "messages": chat_messages,
                    "stream": False,
                    # Thinking models (e.g. qwen3.5) otherwise burn the token budget in
                    # reasoning and leave content empty — structured interpret needs content.
                    "think": False,
                    "options": {"temperature": 0, "num_predict": 8192},
                }
            )
            message = payload.get("message") if isinstance(payload, dict) else None
            text = assistant_text_from_message(message) if isinstance(message, dict) else ""
            input_tokens = None
            output_tokens = None
            if isinstance(payload, dict):
                if payload.get("prompt_eval_count") is not None:
                    input_tokens = int(payload["prompt_eval_count"])
                if payload.get("eval_count") is not None:
                    output_tokens = int(payload["eval_count"])
            usage = UsageEntry(
                id=new_id("usage"),
                provider_id=self.provider_id,
                model_id=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                status="ok" if text else "unknown",
                notes="Ollama native /api/chat (think disabled for structured output).",
            )
            return CompletionResult(
                text=text or "(empty completion)",
                model_id=model,
                provider_id=self.provider_id,
                usage=usage,
            )

        body = {
            "model": model,
            "messages": chat_messages,
            "max_tokens": 1024,
        }
        payload = self._post("/chat/completions", body, api_key=api_key)
        text = ""
        choices = payload.get("choices") if isinstance(payload, dict) else None
        if isinstance(choices, list) and choices:
            message = choices[0].get("message") if isinstance(choices[0], dict) else None
            if isinstance(message, dict):
                text = assistant_text_from_message(message)
        usage_raw = payload.get("usage") if isinstance(payload, dict) else None
        input_tokens = None
        output_tokens = None
        if isinstance(usage_raw, dict):
            if usage_raw.get("prompt_tokens") is not None:
                input_tokens = int(usage_raw["prompt_tokens"])
            if usage_raw.get("completion_tokens") is not None:
                output_tokens = int(usage_raw["completion_tokens"])
        usage = UsageEntry(
            id=new_id("usage"),
            provider_id=self.provider_id,
            model_id=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            status="ok" if text else "unknown",
            notes="Live provider usage; estimated_cost not priced in F3.1.",
        )
        return CompletionResult(
            text=text or "(empty completion)",
            model_id=model,
            provider_id=self.provider_id,
            usage=usage,
        )

    def stream(self, messages: list[ChatMessage], *, model_id: str | None = None) -> Iterator[str]:
        """Yield text deltas from the provider; set last_stream_result when finished."""
        api_key = self._api_key()
        if not api_key:
            raise RuntimeError("openai_compatible provider has no API key configured")
        model = model_id or self.default_model
        chat_messages = [{"role": m.role, "content": m.content} for m in messages]
        self.last_stream_result = None
        pieces: list[str] = []
        input_tokens: int | None = None
        output_tokens: int | None = None

        if self._ollama_native_root() is not None:
            for piece, usage_bits in self._iter_ollama_stream(model, chat_messages):
                if piece:
                    pieces.append(piece)
                    yield piece
                if usage_bits.get("input_tokens") is not None:
                    input_tokens = int(usage_bits["input_tokens"])
                if usage_bits.get("output_tokens") is not None:
                    output_tokens = int(usage_bits["output_tokens"])
        else:
            for piece, usage_bits in self._iter_openai_sse_stream(model, chat_messages, api_key=api_key):
                if piece:
                    pieces.append(piece)
                    yield piece
                if usage_bits.get("input_tokens") is not None:
                    input_tokens = int(usage_bits["input_tokens"])
                if usage_bits.get("output_tokens") is not None:
                    output_tokens = int(usage_bits["output_tokens"])

        text = "".join(pieces)
        usage = UsageEntry(
            id=new_id("usage"),
            provider_id=self.provider_id,
            model_id=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            status="ok" if text else "unknown",
            notes="Streamed completion; unknown tokens stay null.",
        )
        self.last_stream_result = CompletionResult(
            text=text or "(empty completion)",
            model_id=model,
            provider_id=self.provider_id,
            usage=usage,
        )

    def _iter_openai_sse_stream(
        self, model: str, chat_messages: list[dict[str, str]], *, api_key: str
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        body = {
            "model": model,
            "messages": chat_messages,
            "max_tokens": 1024,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        data = json.dumps(body).encode("utf-8")
        request = Request(
            f"{self.base_url}/chat/completions",
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
                "Accept": "text/event-stream",
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                for raw_line in response:
                    line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else str(raw_line)
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        parsed = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(parsed, dict):
                        continue
                    usage_bits: dict[str, Any] = {}
                    usage_raw = parsed.get("usage")
                    if isinstance(usage_raw, dict):
                        if usage_raw.get("prompt_tokens") is not None:
                            usage_bits["input_tokens"] = int(usage_raw["prompt_tokens"])
                        if usage_raw.get("completion_tokens") is not None:
                            usage_bits["output_tokens"] = int(usage_raw["completion_tokens"])
                    piece = ""
                    choices = parsed.get("choices")
                    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                        delta = choices[0].get("delta")
                        if isinstance(delta, dict):
                            content = delta.get("content")
                            if isinstance(content, str):
                                piece = content
                    yield piece, usage_bits
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail[:300]}") from exc
        except URLError as exc:
            raise RuntimeError(str(exc.reason)) from exc

    def _iter_ollama_stream(
        self, model: str, chat_messages: list[dict[str, str]]
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        root = self._ollama_native_root()
        if root is None:
            raise RuntimeError("Ollama native root is not configured")
        body = {
            "model": model,
            "messages": chat_messages,
            "stream": True,
            "think": False,
            "options": {"temperature": 0, "num_predict": 8192},
        }
        data = json.dumps(body).encode("utf-8")
        request = Request(
            f"{root}/api/chat",
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer ollama",
                "Accept": "application/x-ndjson",
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                for raw_line in response:
                    line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else str(raw_line)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        parsed = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(parsed, dict):
                        continue
                    usage_bits: dict[str, Any] = {}
                    if parsed.get("prompt_eval_count") is not None:
                        usage_bits["input_tokens"] = int(parsed["prompt_eval_count"])
                    if parsed.get("eval_count") is not None:
                        usage_bits["output_tokens"] = int(parsed["eval_count"])
                    piece = ""
                    message = parsed.get("message")
                    if isinstance(message, dict):
                        content = message.get("content")
                        if isinstance(content, str):
                            piece = content
                    yield piece, usage_bits
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail[:300]}") from exc
        except URLError as exc:
            raise RuntimeError(str(exc.reason)) from exc

    def _post_ollama_chat(self, body: dict[str, Any]) -> dict[str, Any]:
        root = self._ollama_native_root()
        if root is None:
            raise RuntimeError("Ollama native root is not configured")
        return self._post_url(f"{root}/api/chat", body, api_key="ollama")

    def _post(self, path: str, body: dict[str, Any], *, api_key: str) -> dict[str, Any]:
        return self._post_url(f"{self.base_url}{path}", body, api_key=api_key)

    def _post_url(self, url: str, body: dict[str, Any], *, api_key: str) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8")
        request = Request(
            url,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {detail[:300]}") from exc
        except URLError as exc:
            raise RuntimeError(str(exc.reason)) from exc
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise RuntimeError("Provider returned non-object JSON")
        return parsed
