"""Update/rollback compatibility uses temporary databases, never user state."""
import hashlib
import json
import sqlite3

import pytest

from homun.storage.backup_types import BackupError
from homun.storage.backup import create_backup, restore_backup, verify_backup
from homun.storage.installation_backup import (
    create_installation_backup,
    restore_installation_backup,
    verify_installation_backup,
)
from homun.storage.sqlite import SqliteWorkspaceRepository


def bundle(tmp_path, version):
    source = tmp_path / 'source'
    repository = SqliteWorkspaceRepository(source / 'ws_local.sqlite3', 'ws_local')
    repository.close()
    backup = create_installation_backup(source, tmp_path / 'backups')
    database = backup / 'ws_local.sqlite3'
    with sqlite3.connect(database) as conn:
        conn.execute(f'PRAGMA user_version={version}')
    manifest = json.loads((backup / 'manifest.json').read_text())
    entry = next(item for item in manifest['files'] if item['name'] == database.name)
    entry.update(bytes=database.stat().st_size, sha256=hashlib.sha256(database.read_bytes()).hexdigest())
    (backup / 'manifest.json').write_text(json.dumps(manifest))
    return backup, database


@pytest.mark.parametrize('version', [2, 999])
def test_future_schema_bundle_rejected_before_restore_publication(tmp_path, version):
    backup, database = bundle(tmp_path, version)
    before = database.read_bytes()
    with pytest.raises(BackupError, match='schema'):
        verify_installation_backup(backup)
    destination = tmp_path / 'restored'
    with pytest.raises(BackupError, match='schema'):
        restore_installation_backup(backup, destination)
    assert not destination.exists()
    assert not list(tmp_path.glob('.restore-*'))
    assert database.read_bytes() == before


@pytest.mark.parametrize('version', [0, 1])
def test_supported_schema_bundle_verifies_without_migrating_source(tmp_path, version):
    backup, database = bundle(tmp_path, version)
    before = database.read_bytes()
    verify_installation_backup(backup)
    restored = restore_installation_backup(backup, tmp_path / 'restored')
    assert database.read_bytes() == before
    repository = SqliteWorkspaceRepository(restored, 'ws_local')
    try:
        assert repository.load().workspace_id == 'ws_local'
    finally:
        repository.close()


def test_failed_legacy_migration_rolls_back_metadata_and_version(tmp_path):
    database = tmp_path / 'workspace.sqlite3'
    repository = SqliteWorkspaceRepository(database, 'ws_local')
    repository.close()
    with sqlite3.connect(database) as conn:
        conn.executescript('''
            PRAGMA user_version=0;
            DELETE FROM meta WHERE key IN ('generation', 'sequence');
            CREATE TRIGGER fail_sequence BEFORE INSERT ON meta
            WHEN NEW.key='sequence' BEGIN SELECT RAISE(ABORT, 'migration failure'); END;
        ''')
    with pytest.raises(sqlite3.IntegrityError, match='migration failure'):
        SqliteWorkspaceRepository(database, 'ws_local')
    with sqlite3.connect(database) as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 0
        assert conn.execute("SELECT key FROM meta WHERE key IN ('generation', 'sequence')").fetchall() == []
        conn.execute('DROP TRIGGER fail_sequence')
    repository = SqliteWorkspaceRepository(database, 'ws_local')
    try:
        assert repository.load()._generation == 0
    finally:
        repository.close()


def test_failed_post_migration_validation_rolls_back_version_bump(tmp_path):
    database = tmp_path / 'workspace.sqlite3'
    repository = SqliteWorkspaceRepository(database, 'ws_local')
    repository.close()
    with sqlite3.connect(database) as conn:
        conn.executescript('''
            PRAGMA user_version=0;
            DELETE FROM meta WHERE key='sequence';
            UPDATE meta SET value='-1' WHERE key='generation';
        ''')
    with pytest.raises(ValueError, match='generation'):
        SqliteWorkspaceRepository(database, 'ws_local')
    with sqlite3.connect(database) as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 0
        assert conn.execute("SELECT value FROM meta WHERE key='sequence'").fetchone() is None


@pytest.mark.parametrize('version', [2, 999])
def test_future_schema_v1_backup_rejected_before_restore(tmp_path, version):
    backup, database = bundle(tmp_path, version)
    manifest = json.loads((backup / 'manifest.json').read_text())
    manifest['version'] = 1
    (backup / 'manifest.json').write_text(json.dumps(manifest))
    before = database.read_bytes()
    with pytest.raises(BackupError, match='schema'):
        verify_backup(backup)
    destination = tmp_path / 'restored'
    with pytest.raises(BackupError, match='schema'):
        restore_backup(backup_dir=backup, destination_data_dir=destination)
    assert not destination.exists()
    assert database.read_bytes() == before


@pytest.mark.parametrize('live', [False, True])
def test_future_schema_v1_backup_creation_cleans_failed_copy(tmp_path, live):
    _, database = bundle(tmp_path, 999)
    before = database.read_bytes()
    backups = tmp_path / 'legacy-backups'
    conn = sqlite3.connect(database)
    try:
        with pytest.raises(BackupError, match='schema'):
            create_backup(workspace_id='ws_local', source_db=database,
                          backups_root=backups, stamp='future',
                          live_connection=conn if live else None)
    finally:
        conn.close()
    assert not list(backups.iterdir())
    assert database.read_bytes() == before


@pytest.mark.parametrize('version', [0, 1])
def test_supported_schema_v1_backup_create_verify_restore(tmp_path, version):
    _, database = bundle(tmp_path, version)
    before = database.read_bytes()
    backup = create_backup(workspace_id='ws_local', source_db=database,
                           backups_root=tmp_path / 'legacy-backups')
    verify_backup(backup)
    restored = restore_backup(backup_dir=backup, destination_data_dir=tmp_path / 'restored')
    assert database.read_bytes() == before
    with sqlite3.connect(restored) as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == version
