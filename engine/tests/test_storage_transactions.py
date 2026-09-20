"""Durability and concurrent snapshot regressions for the workspace repository."""
import sqlite3

import pytest

from homun.domain.errors import ConflictError
from homun.domain.models import Project
from homun.storage.sqlite import SqliteWorkspaceRepository


def project(key, name=None):
    return Project(id=key, workspace_id="ws", name=name or key)


@pytest.fixture
def repo(tmp_path):
    instance = SqliteWorkspaceRepository(tmp_path / "workspace.db", "ws")
    yield instance
    instance.close()


def test_noop_save_has_no_database_writes(repo):
    store = repo.load()
    store.projects["one"] = project("one")
    repo.save(store)
    before = repo.connection().total_changes
    repo.save(store)
    assert repo.connection().total_changes == before


def test_delta_save_preserves_unchanged_entity_row(repo):
    store = repo.load()
    store.projects = {key: project(key) for key in ("one", "two")}
    repo.save(store)
    repo.connection().executescript("""
        CREATE TRIGGER forbid_delete BEFORE DELETE ON entities
        WHEN OLD.id = 'two' BEGIN SELECT RAISE(ABORT, 'unchanged row deleted'); END;
        CREATE TRIGGER forbid_update BEFORE UPDATE ON entities
        WHEN OLD.id = 'two' BEGIN SELECT RAISE(ABORT, 'unchanged row updated'); END;
    """)
    store.projects["one"].name = "Changed"
    repo.save(store)
    assert repo.load().projects["one"].name == "Changed"


def test_save_failure_rolls_back_all_partial_writes(repo):
    store = repo.load()
    store.projects["one"] = project("one")
    repo.save(store)
    repo.connection().executescript("""
        CREATE TRIGGER fail_insert BEFORE INSERT ON entities
        WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    """)
    store.projects["one"].name = "Must roll back"
    store.projects["bad"] = project("bad")
    with pytest.raises(sqlite3.IntegrityError):
        repo.save(store)
    assert not repo.connection().in_transaction
    other = SqliteWorkspaceRepository(repo.path, "ws")
    try:
        assert other.load().projects["one"].name == "one"
        assert "bad" not in other.load().projects
    finally:
        other.close()


def test_workspace_identity_checked_on_reopen(repo):
    with pytest.raises(ValueError, match="workspace"):
        SqliteWorkspaceRepository(repo.path, "wrong")


def test_stale_snapshot_rejected_across_repository_handles(repo):
    other = SqliteWorkspaceRepository(repo.path, "ws")
    try:
        left, right = repo.load(), other.load()
        left.projects["one"] = project("one")
        repo.save(left)
        right.projects["two"] = project("two")
        with pytest.raises(ConflictError):
            other.save(right)
        assert set(other.load().projects) == {"one"}
    finally:
        other.close()


def test_transaction_commits_or_rolls_back(repo):
    with repo.transaction() as store:
        store.projects["one"] = project("one")
    with pytest.raises(RuntimeError):
        with repo.transaction() as store:
            store.projects["two"] = project("two")
            raise RuntimeError("abort")
    assert set(repo.load().projects) == {"one"}


def test_future_schema_rejected_without_rewriting(repo):
    repo.connection().execute("PRAGMA user_version=999")
    with pytest.raises(ValueError, match="schema"):
        SqliteWorkspaceRepository(repo.path, "ws")
    assert repo.connection().execute("PRAGMA user_version").fetchone()[0] == 999


def test_noop_save_does_not_invalidate_other_snapshot(repo):
    left, right = repo.load(), repo.load()
    repo.save(left)
    right.projects["one"] = project("one")
    repo.save(right)
    assert repo.load().projects["one"].name == "one"


def test_legacy_database_preserves_documents_and_event_sequence(tmp_path):
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE entities(kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id));
        CREATE TABLE events(sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE commands(command_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        INSERT INTO meta VALUES ('workspace_id', 'ws');
        INSERT INTO meta VALUES ('sequence', '42');
    """)
    conn.execute("INSERT INTO entities VALUES ('project', 'one', ?)", (project("one").model_dump_json(),))
    conn.commit()
    conn.close()
    repository = SqliteWorkspaceRepository(path, "ws")
    try:
        store = repository.load()
        assert store.projects["one"].name == "one"
        assert store._sequence == 42
        assert store._generation == 0
        repository.save(store)
    finally:
        repository.close()


def test_load_has_coherent_read_snapshot_while_other_handle_commits(repo):
    other = SqliteWorkspaceRepository(repo.path, "ws")
    writer = other.load()
    writer.projects["new"] = project("new")
    writer._sequence = 7
    fired = False

    def commit_between_reads(statement):
        nonlocal fired
        if "SELECT kind, id, payload FROM entities" in statement and not fired:
            fired = True
            other.save(writer)

    repo.connection().set_trace_callback(commit_between_reads)
    try:
        snapshot = repo.load()
        assert fired
        assert snapshot.projects == {}
        assert snapshot._sequence == 0
        assert repo.load()._sequence == 7
    finally:
        repo.connection().set_trace_callback(None)
        other.close()


def test_delta_deletes_only_removed_rows(repo):
    store = repo.load()
    store.projects = {key: project(key) for key in ("one", "two")}
    repo.save(store)
    del store.projects["one"]
    repo.save(store)
    assert set(repo.load().projects) == {"two"}


def test_failed_save_can_be_retried_with_same_generation(repo):
    store = repo.load()
    store.projects["bad"] = project("bad")
    repo.connection().executescript("""
        CREATE TRIGGER fail_insert BEFORE INSERT ON entities
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    """)
    with pytest.raises(sqlite3.IntegrityError):
        repo.save(store)
    repo.connection().execute("DROP TRIGGER fail_insert")
    repo.save(store)
    assert set(repo.load().projects) == {"bad"}


def test_duplicate_event_sequence_fails_instead_of_silently_dropping_event(repo):
    from homun.domain.models import DomainEvent
    store = repo.load()
    event = DomainEvent(event_id="e1", workspace_id="ws", aggregate_id="one",
                        aggregate_type="project", aggregate_version=1, sequence=1,
                        type="created", actor_id="person")
    store.events = [event, event.model_copy(update={"event_id": "e2"})]
    with pytest.raises(ValueError, match="sequence"):
        repo.save(store)
    assert repo.load().events == []


def test_unknown_entity_cannot_be_erased_by_save(repo):
    store = repo.load()
    repo.connection().execute("INSERT INTO entities VALUES ('future', 'one', '{}')")
    repo.connection().commit()
    with pytest.raises(ValueError, match="entity"):
        repo.save(store)
    with pytest.raises(ValueError, match="entity"):
        repo.load()


def test_commit_failure_preserves_generation_and_database(repo):
    store = repo.load()
    repo.connection().executescript("""
        CREATE TABLE parents(id INTEGER PRIMARY KEY);
        CREATE TABLE children(parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER fail_commit AFTER INSERT ON entities
        BEGIN INSERT INTO children VALUES (999); END;
    """)
    store.projects["one"] = project("one")
    before = store._generation
    with pytest.raises(sqlite3.IntegrityError):
        repo.save(store)
    assert store._generation == before
    assert repo.load().projects == {}
    assert not repo.connection().in_transaction


def test_legacy_missing_sequence_recovers_existing_event_count(repo):
    from homun.domain.models import DomainEvent
    event = DomainEvent(event_id="e1", workspace_id="ws", aggregate_id="one",
                        aggregate_type="project", aggregate_version=1, sequence=1,
                        type="created", actor_id="person")
    repo.connection().execute("INSERT INTO events VALUES (1, ?)", (event.model_dump_json(),))
    repo.connection().execute("DELETE FROM meta WHERE key IN ('sequence', 'generation')")
    repo.connection().execute("PRAGMA user_version=0")
    repo.connection().commit()
    other = SqliteWorkspaceRepository(repo.path, "ws")
    try:
        assert other.load().next_sequence() == 2
    finally:
        other.close()
