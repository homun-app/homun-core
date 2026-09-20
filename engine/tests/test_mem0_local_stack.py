"""Mem0 local stack (F3.5a slice C) — config, dual-write isolation, status."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.memory.mem0_port import (
    DualWriteMemoryPort,
    Mem0UnavailableError,
    build_local_mem0_config,
    describe_memory_backend,
    try_build_mem0_client,
)
from homun.memory.sqlite_port import SqliteMemoryPort


class FakeMem0:
    """Minimal Mem0 stand-in for unit tests (no network)."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []
        self.deleted: list[str] = []
        self._seq = 0

    def add(self, text: str, user_id: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        self._seq += 1
        mid = f"m0_{self._seq}"
        self.entries.append(
            {
                "id": mid,
                "memory": text,
                "user_id": user_id,
                "metadata": dict(metadata or {}),
            }
        )
        return {"id": mid, "results": [{"id": mid}]}

    def search(self, query: str, user_id: str, limit: int = 10) -> dict[str, Any]:
        q = query.lower()
        hits = []
        for entry in self.entries:
            if q in str(entry.get("memory", "")).lower():
                hits.append(
                    {
                        "memory": entry["memory"],
                        "metadata": entry["metadata"],
                    }
                )
            if len(hits) >= limit:
                break
        return {"results": hits}

    def delete(self, memory_id: str) -> None:
        self.deleted.append(memory_id)
        self.entries = [e for e in self.entries if e["id"] != memory_id]


def test_build_local_mem0_config_is_ollama_qdrant_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HOMUN_MEM0_OLLAMA_URL", raising=False)
    monkeypatch.delenv("HOMUN_MEM0_LLM_MODEL", raising=False)
    cfg = build_local_mem0_config()
    assert cfg["llm"]["provider"] == "ollama"
    assert cfg["embedder"]["provider"] == "ollama"
    assert cfg["vector_store"]["provider"] == "qdrant"
    dump = str(cfg).lower()
    assert "openai" not in dump
    assert cfg["llm"]["config"]["ollama_base_url"] == "http://127.0.0.1:11434"
    assert cfg["vector_store"]["config"]["port"] == 6333


def test_build_local_mem0_config_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOMUN_MEM0_OLLAMA_URL", "http://127.0.0.1:11435")
    monkeypatch.setenv("HOMUN_MEM0_LLM_MODEL", "qwen3.5:4b")
    monkeypatch.setenv("HOMUN_MEM0_QDRANT_PORT", "6335")
    monkeypatch.setenv("HOMUN_MEM0_COLLECTION", "homun_test")
    cfg = build_local_mem0_config()
    assert cfg["llm"]["config"]["model"] == "qwen3.5:4b"
    assert cfg["llm"]["config"]["ollama_base_url"] == "http://127.0.0.1:11435"
    assert cfg["vector_store"]["config"]["port"] == 6335
    assert cfg["vector_store"]["config"]["collection_name"] == "homun_test"


def test_dual_write_fake_mem0_respects_project_isolation() -> None:
    conn = sqlite3.connect(":memory:")
    ledger = SqliteMemoryPort(conn, "ws_test")
    fake = FakeMem0()
    port = DualWriteMemoryPort(ledger, mem0=fake)
    port.add_approved(
        text="Cliente Acme preferisce PDF",
        actor_id="person_fabio",
        project_id="proj_a",
    )
    port.add_approved(
        text="Progetto B: tono formale Acme",
        actor_id="person_fabio",
        project_id="proj_b",
    )
    assert len(fake.entries) == 2
    hits_a = port.recall("Acme", project_id="proj_a")
    assert len(hits_a) == 1
    assert hits_a[0].project_id == "proj_a"
    hits_b = port.recall("Acme", project_id="proj_b")
    assert len(hits_b) == 1
    assert hits_b[0].project_id == "proj_b"


def test_dual_write_delete_forgets_mem0() -> None:
    conn = sqlite3.connect(":memory:")
    ledger = SqliteMemoryPort(conn, "ws_test")
    fake = FakeMem0()
    port = DualWriteMemoryPort(ledger, mem0=fake)
    note = port.add_approved(text="Da cancellare", actor_id="person_fabio", project_id="p1")
    assert fake.entries
    port.delete(note.id, actor_id="person_fabio")
    assert fake.deleted
    assert port.recall("cancellare", project_id="p1") == []


def test_try_build_mem0_client_missing_package(monkeypatch: pytest.MonkeyPatch) -> None:
    import builtins

    real_import = builtins.__import__

    def fake_import(name: str, *args: Any, **kwargs: Any):
        if name == "mem0" or name.startswith("mem0."):
            raise ImportError("no mem0")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(Mem0UnavailableError, match="mem0ai is not installed"):
        try_build_mem0_client()


def test_describe_memory_backend_sqlite(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOMUN_MEMORY_BACKEND", "sqlite")
    status = describe_memory_backend(mem0_client=None)
    assert status["backend"] == "sqlite"
    assert status["ok"] is True


def test_memory_status_http(tmp_path: Path) -> None:
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    try:
        response = client.get("/v1/memory/status")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["backend"] == "sqlite"
        assert body["ok"] is True
    finally:
        reset_context_for_tests(None)
        ctx.repository.close()


@pytest.mark.integration
@pytest.mark.skipif(os.environ.get("HOMUN_MEM0_LIVE") != "1", reason="Set HOMUN_MEM0_LIVE=1 for live Mem0")
def test_live_mem0_add_recall(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOMUN_MEMORY_BACKEND", "mem0")
    client = try_build_mem0_client()
    conn = sqlite3.connect(tmp_path / "live.db")
    ledger = SqliteMemoryPort(conn, "ws_live")
    port = DualWriteMemoryPort(ledger, mem0=client)
    note = port.add_approved(
        text="Il cliente Acme vuole solo PDF firmato",
        actor_id="person_fabio",
        project_id="proj_live",
    )
    hits = port.recall("PDF", project_id="proj_live", limit=5)
    assert any(h.id == note.id for h in hits)
