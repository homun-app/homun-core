"""External vector memory backend adapters (H18).

Provides optional remote vector memory backends (Supermemory, Byterover, Honcho)
with honest credential validation and DualWriteMemoryPort integration.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

SUPPORTED_EXTERNAL_BACKENDS = ("supermemory", "byterover", "honcho")

_BACKEND_ENV_KEYS: dict[str, str] = {
    "supermemory": "SUPERMEMORY_API_KEY",
    "byterover": "BYTEROVER_API_KEY",
    "honcho": "HONCHO_API_KEY",
}

_BACKEND_DEFAULT_URLS: dict[str, str] = {
    "supermemory": "https://api.supermemory.ai/v1",
    "byterover": "https://api.byterover.dev/v1",
    "honcho": "https://api.honcho.dev/v1",
}


class ExternalMemoryUnavailableError(RuntimeError):
    """Raised when an external memory backend is requested but unavailable or unconfigured."""


class BaseExternalVectorClient:
    """Base HTTP client for external vector memory providers."""

    def __init__(self, backend_name: str, api_key: str, base_url: Optional[str] = None, *, timeout: float = 10.0) -> None:
        self.backend_name = backend_name
        self.api_key = api_key
        self.base_url = (base_url or _BACKEND_DEFAULT_URLS.get(backend_name, "")).rstrip("/")
        self.timeout = timeout

    def _request(self, method: str, endpoint: str, payload: Optional[dict] = None) -> Any:
        url = f"{self.base_url}{endpoint}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": f"Homun-Memory/{self.backend_name}",
        }
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw.strip() else {}
        except Exception as exc:
            logger.warning(f"External vector backend {self.backend_name} call failed: {exc}")
            raise ExternalMemoryUnavailableError(f"{self.backend_name} request failed: {exc}") from exc

    def add(self, text: str, user_id: str, metadata: Optional[dict] = None) -> dict[str, Any]:
        payload = {
            "text": text,
            "user_id": user_id,
            "metadata": metadata or {},
        }
        res = self._request("POST", "/memories", payload)
        mid = res.get("id") or (res.get("data") or {}).get("id") or "ext_1"
        return {"id": str(mid), "results": [{"id": str(mid)}]}

    def search(self, query: str, user_id: str, limit: int = 10) -> dict[str, Any]:
        payload = {
            "query": query,
            "user_id": user_id,
            "limit": limit,
        }
        res = self._request("POST", "/memories/search", payload)
        items = res.get("results") or res.get("data") or []
        out: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            out.append({
                "memory": item.get("text") or item.get("memory") or "",
                "metadata": item.get("metadata") or {},
            })
        return {"results": out}

    def delete(self, memory_id: str) -> None:
        try:
            self._request("DELETE", f"/memories/{urllib.parse.quote(memory_id)}")
        except Exception:
            pass


class SupermemoryClient(BaseExternalVectorClient):
    def __init__(self, api_key: str, base_url: Optional[str] = None) -> None:
        super().__init__("supermemory", api_key, base_url or os.environ.get("SUPERMEMORY_URL"))


class ByteroverClient(BaseExternalVectorClient):
    def __init__(self, api_key: str, base_url: Optional[str] = None) -> None:
        super().__init__("byterover", api_key, base_url or os.environ.get("BYTEROVER_URL"))


class HonchoClient(BaseExternalVectorClient):
    def __init__(self, api_key: str, base_url: Optional[str] = None) -> None:
        super().__init__("honcho", api_key, base_url or os.environ.get("HONCHO_URL"))


def build_external_vector_client(backend: str) -> BaseExternalVectorClient:
    name = backend.strip().lower()
    if name not in _BACKEND_ENV_KEYS:
        raise ExternalMemoryUnavailableError(f"Unknown external memory backend: {backend}. Supported: {', '.join(SUPPORTED_EXTERNAL_BACKENDS)}")
    env_var = _BACKEND_ENV_KEYS[name]
    api_key = os.environ.get(env_var, "").strip()
    if not api_key:
        raise ExternalMemoryUnavailableError(f"Missing API key for external memory backend '{name}'. Set {env_var}.")
    if name == "supermemory":
        return SupermemoryClient(api_key)
    if name == "byterover":
        return ByteroverClient(api_key)
    if name == "honcho":
        return HonchoClient(api_key)
    raise ExternalMemoryUnavailableError(f"Unsupported backend {name}")


def describe_external_memory_backend(backend: str) -> dict[str, Any]:
    name = backend.strip().lower()
    env_var = _BACKEND_ENV_KEYS.get(name)
    if not env_var:
        return {
            "backend": name,
            "ok": False,
            "detail": f"Unknown external memory backend: {name}.",
        }
    api_key = os.environ.get(env_var, "").strip()
    if not api_key:
        return {
            "backend": name,
            "ok": False,
            "detail": f"HOMUN_MEMORY_BACKEND={name} configured but {env_var} is missing.",
        }
    return {
        "backend": name,
        "ok": True,
        "detail": f"External vector memory backend '{name}' active with API key configured.",
    }
