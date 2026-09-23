"""Encryption at rest: SQLCipher workspace, key management, migration safety."""
import importlib.util
import sqlite3
import pytest
from pathlib import Path

from homun.domain.models import Work
from homun.storage.encryption import load_or_create_key, derive_database_key
from homun.storage.sqlite import SqliteWorkspaceRepository

requires_sqlcipher = pytest.mark.skipif(
    importlib.util.find_spec('sqlcipher3') is None,
    reason='optional homun-engine[encryption] extra not installed')


def test_encrypted_database_unreadable_without_key(tmp_path):
    key = load_or_create_key(tmp_path)
    repo = SqliteWorkspaceRepository(tmp_path / 'enc.db', 'ws_test', encryption_key=key)
    repo.close()
    conn = sqlite3.connect(str(tmp_path / 'enc.db'))
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute('SELECT name FROM sqlite_master').fetchall()
    conn.close()


def test_encrypted_database_works_with_key(tmp_path):
    key = load_or_create_key(tmp_path)
    repo = SqliteWorkspaceRepository(tmp_path / 'enc.db', 'ws_test', encryption_key=key)
    with repo.locked():
        with repo.transaction() as store:
            store.works['w1'] = Work(
                id='w1', workspace_id='ws_test', title='Encrypted',
                objective='Test', primary_conversation_id='c1',
                requester_id='p1', owner_id='p1')
    repo.close()
    repo2 = SqliteWorkspaceRepository(tmp_path / 'enc.db', 'ws_test', encryption_key=key)
    store = repo2.load()
    assert 'w1' in store.works and store.works['w1'].title == 'Encrypted'
    repo2.close()


def test_wrong_key_rejected(tmp_path):
    key1 = load_or_create_key(tmp_path)
    repo = SqliteWorkspaceRepository(tmp_path / 'enc.db', 'ws_test', encryption_key=key1)
    repo.close()
    key2 = derive_database_key(b'\xff' * 32, 'wrong-purpose')
    with pytest.raises(Exception):
        repo = SqliteWorkspaceRepository(tmp_path / 'enc.db', 'ws_test', encryption_key=key2)
        repo.load()
        repo.close()


def test_key_deterministic_and_persistent(tmp_path):
    key1 = load_or_create_key(tmp_path)
    key2 = load_or_create_key(tmp_path)
    assert key1 == key2
    assert len(key1) == 32


def test_derived_keys_differ_by_purpose():
    master = b'\x00' * 32
    db_key = derive_database_key(master, 'workspace-db')
    blob_key = derive_database_key(master, 'material-blob')
    assert db_key != blob_key
    assert len(db_key) == 32 and len(blob_key) == 32


@requires_sqlcipher
def test_workspace_with_encryption_end_to_end(tmp_path):
    from homun.context import create_context
    from homun.domain.models import Actor
    key = load_or_create_key(tmp_path)
    ctx = create_context(
        db_path=tmp_path / 'enc_ws.db', data_dir=tmp_path, for_tests=True, encryption_key=key)
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'Encrypted'})
    ctx.persist()
    store = ctx.repository.load()
    assert any(c.title == 'Encrypted' for c in store.conversations.values())
    ctx.close()
    # Reopen and verify persistence.
    ctx2 = create_context(
        db_path=tmp_path / 'enc_ws.db', data_dir=tmp_path, for_tests=True, encryption_key=key)
    store2 = ctx2.repository.load()
    assert any(c.title == 'Encrypted' for c in store2.conversations.values())
    ctx2.close()


@requires_sqlcipher
def test_context_database_is_encrypted_and_key_is_required(tmp_path):
    from homun.context import create_context
    path = tmp_path / 'workspace.db'
    ctx = create_context(db_path=path, for_tests=True, encryption_key=b'a' * 32)
    assert ctx.memory_connection.execute('SELECT count(*) FROM sqlite_master').fetchone()[0] > 0
    ctx.close()
    with sqlite3.connect(path) as conn, pytest.raises(sqlite3.DatabaseError):
        conn.execute('SELECT * FROM sqlite_master').fetchall()
    from homun.storage.encryption import EncryptionError
    for key in (None, b'b' * 32):
        with pytest.raises(EncryptionError):
            create_context(db_path=path, for_tests=True, encryption_key=key)


@requires_sqlcipher
def test_opt_in_does_not_migrate_plaintext_database(tmp_path):
    from homun.context import create_context
    from homun.storage.encryption import EncryptionError
    path = tmp_path / 'workspace.db'
    create_context(db_path=path, for_tests=True).close()
    original = path.read_bytes()
    with pytest.raises(EncryptionError):
        create_context(db_path=path, for_tests=True, encryption_key=b'a' * 32)
    assert path.read_bytes() == original
    create_context(db_path=path, for_tests=True).close()


def test_key_file_configuration_is_explicit_and_never_regenerated(tmp_path, monkeypatch):
    from homun.context import create_context
    from homun.storage.encryption import EncryptionError
    key_file = tmp_path / 'external-key'
    monkeypatch.setenv('HOMUN_WORKSPACE_KEY_FILE', str(key_file))
    with pytest.raises(EncryptionError):
        create_context(db_path=tmp_path / 'workspace.db', for_tests=True)
    assert not key_file.exists()
    key_file.write_text('ab' * 32)
    create_context(db_path=tmp_path / 'workspace.db', for_tests=True).close()
    with sqlite3.connect(tmp_path / 'workspace.db') as conn, pytest.raises(sqlite3.DatabaseError):
        conn.execute('SELECT * FROM sqlite_master').fetchall()


def test_encrypted_backup_restore_preserves_encryption(tmp_path):
    from homun.context import create_context
    from homun.storage.backup import create_backup, restore_backup, verify_backup, BackupError
    key = b'c' * 32
    path = tmp_path / 'workspace.db'
    ctx = create_context(db_path=path, for_tests=True, encryption_key=key)
    for live in (ctx.repository.connection(), None):
        backup = create_backup(workspace_id='ws_local', source_db=path,
                               backups_root=tmp_path / 'backups', stamp='live' if live else 'offline',
                               live_connection=live, encryption_key=key)
        with pytest.raises(BackupError):
            verify_backup(backup)
        with pytest.raises(BackupError):
            verify_backup(backup, encryption_key=b'd' * 32)
        restored = restore_backup(backup_dir=backup, destination_data_dir=tmp_path / backup.name,
                                  encryption_key=key)
        with sqlite3.connect(restored) as conn, pytest.raises(sqlite3.DatabaseError):
            conn.execute('SELECT * FROM sqlite_master').fetchall()
        create_context(db_path=restored, for_tests=True, encryption_key=key).close()
    ctx.close()
