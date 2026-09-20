"""Optional Mem0-backed MemoryPort (F3.5a slice B/C).

Homun keeps SqliteMemoryPort as the approved-memory ledger (source of truth).
When HOMUN_MEMORY_BACKEND=mem0, DualWriteMemoryPort indexes notes in Mem0 OSS
configured for local Ollama + Qdrant only — never OpenAI/cloud defaults.
"""

from __future__ import annotations

import os
from typing import Any

from homun.domain.errors import ValidationError
from homun.memory.sqlite_port import SqliteMemoryPort
from homun.memory.types import MemoryNote


class Mem0UnavailableError(RuntimeError):
    """Raised when Mem0 backend was requested but is not usable."""


def mem0_requested() -> bool:
    return os.environ.get("HOMUN_MEMORY_BACKEND", "sqlite").strip().lower() == "mem0"


def _env(name: str, default: str) -> str:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip()


def build_local_mem0_config() -> dict[str, Any]:
    """Explicit local-only Mem0 config (Ollama LLM/embedder + Qdrant)."""
    ollama_url = _env("HOMUN_MEM0_OLLAMA_URL", "http://127.0.0.1:11434")
    llm_model = _env("HOMUN_MEM0_LLM_MODEL", "llama3.2")
    embed_model = _env("HOMUN_MEM0_EMBED_MODEL", "nomic-embed-text")
    embed_dims = int(_env("HOMUN_MEM0_EMBED_DIMS", "768"))
    qdrant_host = _env("HOMUN_MEM0_QDRANT_HOST", "127.0.0.1")
    qdrant_port = int(_env("HOMUN_MEM0_QDRANT_PORT", "6333"))
    collection = _env("HOMUN_MEM0_COLLECTION", "homun_memories")
    return {
        "version": "v1.1",
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": collection,
                "host": qdrant_host,
                "port": qdrant_port,
                "embedding_model_dims": embed_dims,
            },
        },
        "llm": {
            "provider": "ollama",
            "config": {
                "model": llm_model,
                "temperature": 0,
                "max_tokens": 2000,
                "ollama_base_url": ollama_url,
            },
        },
        "embedder": {
            "provider": "ollama",
            "config": {
                "model": embed_model,
                "ollama_base_url": ollama_url,
            },
        },
    }


def describe_memory_backend(*, mem0_client: Any | None = None) -> dict[str, Any]:
    """Operator-facing status for Settings / GET /v1/memory/status."""
    if not mem0_requested():
        return {
            "backend": "sqlite",
            "ok": True,
            "detail": "Ledger-only (SQLite). Set HOMUN_MEMORY_BACKEND=mem0 for local Mem0.",
        }
    if mem0_client is None:
        return {
            "backend": "mem0",
            "ok": False,
            "detail": "HOMUN_MEMORY_BACKEND=mem0 but Mem0 client is not attached.",
        }
    cfg = build_local_mem0_config()
    vs = cfg["vector_store"]["config"]
    llm = cfg["llm"]["config"]
    emb = cfg["embedder"]["config"]
    return {
        "backend": "mem0",
        "ok": True,
        "detail": (
            f"Mem0 locale · Ollama {llm['model']} / {emb['model']} @ {llm['ollama_base_url']} · "
            f"Qdrant {vs['host']}:{vs['port']} / {vs['collection_name']}"
        ),
        "ollama_url": llm["ollama_base_url"],
        "llm_model": llm["model"],
        "embed_model": emb["model"],
        "qdrant_host": vs["host"],
        "qdrant_port": vs["port"],
        "collection": vs["collection_name"],
    }


class DualWriteMemoryPort:
    """Ledger (SQLite) + optional Mem0 search index."""

    def __init__(self, ledger: SqliteMemoryPort, mem0: Any | None = None) -> None:
        self.ledger = ledger
        self._mem0 = mem0
        # Mem0 memory ids keyed by Homun note id (best-effort for delete/rectify).
        self._mem0_ids: dict[str, str] = {}

    def list(
        self,
        *,
        work_id: str | None = None,
        project_id: str | None = None,
        include_deleted: bool = False,
    ) -> list[MemoryNote]:
        return self.ledger.list(
            work_id=work_id,
            project_id=project_id,
            include_deleted=include_deleted,
        )

    def add_approved(
        self,
        *,
        text: str,
        actor_id: str,
        work_id: str | None = None,
        project_id: str | None = None,
    ) -> MemoryNote:
        note = self.ledger.add_approved(
            text=text,
            actor_id=actor_id,
            work_id=work_id,
            project_id=project_id,
        )
        self._index_note(note)
        return note

    def rectify(self, memory_id: str, *, text: str, actor_id: str) -> MemoryNote:
        note = self.ledger.rectify(memory_id, text=text, actor_id=actor_id)
        # Ledger authoritative; re-index best-effort after remove old Mem0 entry.
        self._forget_mem0(memory_id)
        self._index_note(note)
        return note

    def delete(self, memory_id: str, *, actor_id: str) -> MemoryNote:
        note = self.ledger.delete(memory_id, actor_id=actor_id)
        self._forget_mem0(memory_id)
        return note

    def export(self, *, project_id: str | None = None) -> list[MemoryNote]:
        return self.ledger.export(project_id=project_id)

    def recall(
        self,
        query: str,
        *,
        project_id: str | None = None,
        limit: int = 10,
    ) -> list[MemoryNote]:
        cleaned = query.strip()
        if not cleaned:
            return []
        if self._mem0 is None:
            return self.ledger.recall(cleaned, project_id=project_id, limit=limit)
        try:
            raw = self._mem0.search(
                cleaned,
                user_id=self.ledger.workspace_id,
                limit=max(1, min(limit * 3, 50)),
            )
        except Exception:
            return self.ledger.recall(cleaned, project_id=project_id, limit=limit)
        results = raw.get("results", raw) if isinstance(raw, dict) else raw
        if not isinstance(results, list):
            return self.ledger.recall(cleaned, project_id=project_id, limit=limit)
        ledger_by_id = {n.id: n for n in self.ledger.list(project_id=project_id)}
        out: list[MemoryNote] = []
        seen: set[str] = set()
        for item in results:
            if not isinstance(item, dict):
                continue
            meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            homun_id = meta.get("homun_id") if isinstance(meta, dict) else None
            if not isinstance(homun_id, str) or homun_id in seen:
                continue
            note = ledger_by_id.get(homun_id)
            if note is None:
                continue
            # Project isolation always from ledger, never Mem0 alone.
            if project_id is not None and note.project_id != project_id:
                continue
            seen.add(homun_id)
            out.append(note)
            if len(out) >= max(1, min(limit, 50)):
                break
        if not out:
            return self.ledger.recall(cleaned, project_id=project_id, limit=limit)
        return out

    def status(self) -> dict[str, Any]:
        return describe_memory_backend(mem0_client=self._mem0)

    def _index_note(self, note: MemoryNote) -> None:
        if self._mem0 is None:
            return
        metadata = {
            "homun_id": note.id,
            "workspace_id": note.workspace_id,
            "project_id": note.project_id,
            "work_id": note.work_id,
        }
        try:
            result = self._mem0.add(
                note.text,
                user_id=note.workspace_id,
                metadata={k: v for k, v in metadata.items() if v is not None},
            )
        except Exception:
            return
        mem0_id = _extract_mem0_id(result)
        if mem0_id:
            self._mem0_ids[note.id] = mem0_id

    def _forget_mem0(self, memory_id: str) -> None:
        if self._mem0 is None:
            return
        mem0_id = self._mem0_ids.pop(memory_id, None)
        if not mem0_id:
            return
        for method_name in ("delete", "delete_memory"):
            method = getattr(self._mem0, method_name, None)
            if callable(method):
                try:
                    method(mem0_id)
                except Exception:
                    pass
                return


def _extract_mem0_id(result: Any) -> str | None:
    if isinstance(result, dict):
        for key in ("id", "memory_id"):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        results = result.get("results")
        if isinstance(results, list) and results:
            return _extract_mem0_id(results[0])
    if isinstance(result, list) and result:
        return _extract_mem0_id(result[0])
    return None


def try_build_mem0_client() -> Any:
    """Import Mem0 only when explicitly requested; local Ollama+Qdrant config only."""
    try:
        from mem0 import Memory  # type: ignore[import-not-found]
    except ImportError as exc:
        raise Mem0UnavailableError(
            "mem0ai is not installed. Install with: uv pip install -e \".[memory]\" "
            "or unset HOMUN_MEMORY_BACKEND."
        ) from exc
    config = build_local_mem0_config()
    # Guard: never ship openai provider accidentally.
    for section in ("llm", "embedder", "vector_store"):
        provider = str((config.get(section) or {}).get("provider") or "")
        if provider == "openai":
            raise Mem0UnavailableError("OpenAI provider is forbidden for Homun Mem0 local stack")
    try:
        return Memory.from_config(config)
    except Exception as exc:  # noqa: BLE001
        raise Mem0UnavailableError(
            "Mem0 failed to initialize with local Ollama+Qdrant. "
            "Ensure Qdrant is running (docker run -d -p 6333:6333 qdrant/qdrant), "
            f"Ollama is up at {_env('HOMUN_MEM0_OLLAMA_URL', 'http://127.0.0.1:11434')}, "
            f"and models are pulled ({_env('HOMUN_MEM0_LLM_MODEL', 'llama3.2')}, "
            f"{_env('HOMUN_MEM0_EMBED_MODEL', 'nomic-embed-text')}). "
            f"Underlying error: {exc}"
        ) from exc


def build_memory_port(ledger: SqliteMemoryPort) -> SqliteMemoryPort | DualWriteMemoryPort:
    if not mem0_requested():
        return ledger
    client = try_build_mem0_client()
    return DualWriteMemoryPort(ledger, client)


def assert_query(query: str) -> str:
    cleaned = query.strip()
    if not cleaned:
        raise ValidationError("Recall query is required")
    return cleaned
