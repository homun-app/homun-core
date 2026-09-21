"""Process-wide engine context: persisted domain service + model registry."""

from __future__ import annotations

from dataclasses import dataclass, replace
from contextlib import ExitStack
import sqlite3
from pathlib import Path

from homun.domain.service import DomainService
from homun.memory.sqlite_port import SqliteMemoryPort
from homun.memory.mem0_port import build_memory_port
from homun.memory.types import MemoryPort
from homun.models.registry import ModelRegistry, build_default_registry
from homun.storage.paths import default_db_path
from homun.storage.sqlite import SqliteWorkspaceRepository, _open_connection
from homun.storage.encryption import configured_workspace_key

DEFAULT_WORKSPACE_ID = "ws_local"


@dataclass
class EngineContext:
    workspace_id: str
    repository: SqliteWorkspaceRepository
    service: DomainService
    models: ModelRegistry
    memory: MemoryPort
    data_dir: Path
    memory_connection: sqlite3.Connection | None = None

    def snapshot(self) -> EngineContext:
        return replace(self, service=self.service.for_store(self.repository.load()))

    def close(self) -> None:
        if self.memory_connection is not None:
            self.memory_connection.close()
        self.repository.close()

    def persist(self) -> None:
        self.repository.save(self.service.store)


_CONTEXT: EngineContext | None = None


def get_context() -> EngineContext:
    global _CONTEXT
    if _CONTEXT is None:
        _CONTEXT = create_context()
    return _CONTEXT


def create_context(
    *,
    workspace_id: str = DEFAULT_WORKSPACE_ID,
    db_path: Path | str | None = None,
    data_dir: Path | str | None = None,
    for_tests: bool = False,
    encryption_key: bytes | None = None,
) -> EngineContext:
    path = Path(db_path) if db_path is not None else default_db_path(workspace_id)
    if data_dir is not None:
        root = Path(data_dir)
    else:
        root = path.parent
    encryption_key = configured_workspace_key(encryption_key)
    with ExitStack() as resources:
        repo = SqliteWorkspaceRepository(path, workspace_id, encryption_key=encryption_key)
        resources.callback(repo.close)
        store = repo.load()
        models = build_default_registry(root, for_tests=for_tests)
        models.workspace_id = workspace_id
        service = DomainService(
            store,
            known_connection_ids=lambda: {c.id for c in models.list_connections()},
            durable_runtime=False,
            data_dir=root,
        )
        memory_connection = _open_connection(path, encryption_key)
        resources.callback(memory_connection.close)
        memory = build_memory_port(SqliteMemoryPort(memory_connection, workspace_id))
        ctx = EngineContext(
            workspace_id=workspace_id,
            repository=repo,
            service=service,
            models=models,
            memory=memory,
            memory_connection=memory_connection,
            data_dir=root,
        )
        resources.pop_all()
        return ctx



def reset_context_for_tests(ctx: EngineContext | None = None) -> None:
    global _CONTEXT
    if _CONTEXT is not None:
        _CONTEXT.close()
    _CONTEXT = ctx
