#!/usr/bin/env python3
"""Synthetic SQLCipher feasibility only. All databases/keys live in a temp dir.

Run using an isolated environment with sqlcipher3==0.6.2 and dbos==3.0.0.
No application imports, existing database paths, or Keychain access.
"""
import json
from pathlib import Path
import secrets
import sqlite3
import tempfile

import sqlcipher3


def connection(path, key):
    conn = sqlcipher3.connect(str(path), check_same_thread=False)
    # Generated hexadecimal key; never log it. Set before any schema access.
    conn.execute(f'PRAGMA key = "x\'{key}\'"')
    return conn


def unreadable(path, key=None):
    conn = connection(path, key) if key else sqlite3.connect(str(path))
    try:
        conn.execute('SELECT name FROM sqlite_master').fetchall()
        return False
    except (sqlcipher3.DatabaseError, sqlite3.DatabaseError):
        return True
    finally:
        conn.close()


def probe(root):
    evidence = {}
    key = secrets.token_hex(32)
    path = root / 'synthetic.db'
    conn = connection(path, key)
    try:
        evidence['cipher_version'] = conn.execute('PRAGMA cipher_version').fetchone()[0]
        evidence['wal_mode'] = conn.execute('PRAGMA journal_mode=WAL').fetchone()[0]
        conn.execute('CREATE TABLE sample(value TEXT)')
        conn.execute('INSERT INTO sample VALUES (?)', ('synthetic-only-value',))
        conn.commit()
        evidence['wal_present'] = Path(str(path) + '-wal').exists()
        evidence['wal_no_literal_payload'] = b'synthetic-only-value' not in Path(str(path) + '-wal').read_bytes()
        reopened = connection(path, key)
        try:
            evidence['reopen_reads'] = reopened.execute('SELECT value FROM sample').fetchone()[0] == 'synthetic-only-value'
        finally:
            reopened.close()
        backup_path = root / 'backup.db'
        destination = connection(backup_path, key)
        try:
            conn.backup(destination)
        finally:
            destination.close()
        evidence['encrypted_backup_stdlib_rejected'] = unreadable(backup_path)
        backup = connection(backup_path, key)
        try:
            evidence['backup_reads'] = backup.execute('SELECT count(*) FROM sample').fetchone()[0] == 1
        finally:
            backup.close()
        evidence['stdlib_rejected'] = unreadable(path)
        evidence['wrong_key_rejected'] = unreadable(path, secrets.token_hex(32))
    finally:
        conn.close()
    from dbos import DBOS
    import sqlalchemy as sa
    dbos_path = root / 'dbos-synthetic.db'
    engine = sa.create_engine('sqlite://', module=sqlcipher3,
                              creator=lambda: connection(dbos_path, key))
    try:
        DBOS(config={'name': 'homun-crypto-probe',
                     'system_database_url': f'sqlite:///{dbos_path}',
                     'system_database_engine': engine})
        @DBOS.workflow()
        def synthetic_workflow():
            return 'synthetic-completed'
        DBOS.launch()
        evidence['dbos_workflow'] = synthetic_workflow() == 'synthetic-completed'
        with engine.connect() as conn:
            evidence['dbos_migration_tables'] = conn.exec_driver_sql("SELECT count(*) FROM sqlite_master WHERE type='table'").scalar()
        evidence['dbos_stdlib_rejected'] = unreadable(dbos_path)
        evidence['dbos_wrong_key_rejected'] = unreadable(dbos_path, secrets.token_hex(32))
    finally:
        DBOS.destroy()
        engine.dispose()
    assert all(value is True for value in evidence.values() if isinstance(value, bool)), evidence
    return evidence


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='homun-sqlcipher-data-') as directory:
        print(json.dumps(probe(Path(directory)), indent=2))
