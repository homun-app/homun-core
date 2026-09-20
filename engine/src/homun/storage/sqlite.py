"""Atomic document persistence with optimistic concurrency and WAL snapshots."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from threading import RLock

from homun.domain.errors import ConflictError
from homun.domain.models import CommandRecord, DomainEvent
from homun.domain.store import WorkspaceStore
from homun.storage.documents import ENTITY_TYPES, write_delta
from homun.storage.schema import initialize


class SqliteWorkspaceRepository:
    """A no-op save neither writes rows nor advances the persisted generation.

    Every snapshot, including a no-op, must match the committed generation.
    Delta comparison currently reads all documents; writes scale with changes.
    """

    def __init__(self, path: Path, workspace_id: str) -> None:
        self.path = path
        self.workspace_id = workspace_id
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        try:
            initialize(self._conn, workspace_id)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA foreign_keys=ON")
        except BaseException:
            self._conn.close()
            raise

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def connection(self) -> sqlite3.Connection:
        """Compatibility connection; callers must use locked() for shared access.

        Do not commit this connection inside a repository transaction. Provider
        and memory operations must run outside the domain transaction boundary.
        """
        return self._conn

    @contextmanager
    def locked(self):
        """Serialize access to the shared connection, including online backups."""
        with self._lock:
            yield self._conn

    @contextmanager
    def _atomic(self, *, write=False):
        with self._lock:
            if self._conn.in_transaction:
                raise RuntimeError("Repository transaction already active")
            self._conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            try:
                yield
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise

    def load(self) -> WorkspaceStore:
        with self._atomic():
            return self._load()

    def _load(self) -> WorkspaceStore:
        store = WorkspaceStore(self.workspace_id)
        meta = dict(self._conn.execute("SELECT key, value FROM meta"))
        if meta.get("workspace_id") != self.workspace_id:
            raise ValueError("workspace_id mismatch")
        store._generation = int(meta["generation"])
        store._sequence = int(meta["sequence"])
        for kind, entity_id, payload in self._conn.execute("SELECT kind, id, payload FROM entities"):
            if kind not in ENTITY_TYPES:
                raise ValueError(f"Unsupported workspace entity kind: {kind}")
            attr, model_type = ENTITY_TYPES[kind]
            getattr(store, attr)[entity_id] = model_type.model_validate_json(payload)
        store.events = [DomainEvent.model_validate_json(row[0]) for row in self._conn.execute(
            "SELECT payload FROM events ORDER BY sequence"
        )]
        store.commands = {key: CommandRecord.model_validate_json(payload) for key, payload in
                          self._conn.execute("SELECT command_id, payload FROM commands")}
        return store

    def save(self, store: WorkspaceStore) -> None:
        with self._atomic(write=True):
            generation = self._save(store)
        store._generation = generation

    @contextmanager
    def transaction(self):
        """Load, mutate and persist a fresh store atomically; no provider calls.

        The yielded store is disposable on failure. Do not call save/load within
        this context; the repository owns the single commit at successful exit.
        """
        with self._atomic(write=True):
            store = self._load()
            yield store
            generation = self._save(store)
        store._generation = generation

    def _save(self, store: WorkspaceStore) -> int:
        if store.workspace_id != self.workspace_id:
            raise ValueError("workspace_id mismatch")
        meta = dict(self._conn.execute("SELECT key, value FROM meta"))
        if meta.get("workspace_id") != self.workspace_id:
            raise ValueError("workspace_id mismatch")
        generation = int(meta["generation"])
        if store._generation != generation:
            raise ConflictError("Workspace changed since this snapshot was loaded; reload before retrying")
        if len({event.sequence for event in store.events}) != len(store.events):
            raise ValueError("Duplicate event sequence")
        kinds = {row[0] for row in self._conn.execute("SELECT DISTINCT kind FROM entities")}
        if kinds - ENTITY_TYPES.keys():
            raise ValueError("Unsupported workspace entity kind")
        desired = {(kind, key): model.model_dump_json() for kind, (attr, _) in ENTITY_TYPES.items()
                   for key, model in getattr(store, attr).items()}
        changed = write_delta(self._conn, "entities", ("kind", "id"), desired)
        changed |= write_delta(self._conn, "events", ("sequence",), {
            (event.sequence,): event.model_dump_json() for event in store.events
        })
        changed |= write_delta(self._conn, "commands", ("command_id",), {
            (key,): model.model_dump_json() for key, model in store.commands.items()
        })
        if int(meta["sequence"]) != store._sequence:
            self._conn.execute("UPDATE meta SET value=? WHERE key='sequence'", (str(store._sequence),))
            changed = True
        if changed:
            generation += 1
            self._conn.execute("UPDATE meta SET value=? WHERE key='generation'", (str(generation),))
        return generation
