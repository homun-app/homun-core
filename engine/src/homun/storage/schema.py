"""Versioned, transactional migration from the original document schema."""
import sqlite3

SCHEMA_VERSION = 1
TABLES = {
    "meta": "key TEXT PRIMARY KEY, value TEXT NOT NULL",
    "entities": "kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind, id)",
    "events": "sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL",
    "commands": "command_id TEXT PRIMARY KEY, payload TEXT NOT NULL",
}
COLUMNS = {
    "meta": ["key", "value"],
    "entities": ["kind", "id", "payload"],
    "events": ["sequence", "payload"],
    "commands": ["command_id", "payload"],
}


class UnsupportedSchemaVersion(ValueError):
    """This engine cannot safely interpret the workspace's schema version."""


def validate_schema_version(conn: sqlite3.Connection) -> int:
    """Read-only compatibility gate shared by startup and backup validation."""
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version not in (0, SCHEMA_VERSION):
        raise UnsupportedSchemaVersion(f"Unsupported workspace schema version: {version}")
    return version


def initialize(conn: sqlite3.Connection, workspace_id: str) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        version = validate_schema_version(conn)
        present = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if present:
            for table, columns in COLUMNS.items():
                actual = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
                if actual != columns:
                    raise ValueError(f"Unsupported workspace schema: {table}")
            row = conn.execute("SELECT value FROM meta WHERE key='workspace_id'").fetchone()
            if row is None or row[0] != workspace_id:
                raise ValueError("workspace_id mismatch or missing workspace identity")
        else:
            for table, definition in TABLES.items():
                conn.execute(f"CREATE TABLE {table} ({definition})")
            conn.execute("INSERT INTO meta VALUES ('workspace_id', ?)", (workspace_id,))
        if version == 0:
            conn.execute("INSERT OR IGNORE INTO meta VALUES ('generation', '0')")
            conn.execute(
                "INSERT OR IGNORE INTO meta SELECT 'sequence', CAST(COALESCE(MAX(sequence), 0) AS TEXT) FROM events"
            )
            conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        generation = conn.execute("SELECT value FROM meta WHERE key='generation'").fetchone()
        if generation is None or int(generation[0]) < 0:
            raise ValueError("Invalid workspace schema generation")
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
