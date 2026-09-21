"""Encryption at rest: SQLCipher workspace, key management, migration safety."""
import sqlite3
import pytest
from pathlib import Path

from homun.domain.models import Work
from homun.storage.encryption import load_or_create_key, derive_database_key
from homun.storage.sqlite import SqliteWorkspaceRepository


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


def test_workspace_with_encryption_end_to_end(tmp_path):
    from homun.context import create_context
    from homun.domain.models import Actor
    key = load_or_create_key(tmp_path)
    ctx = create_context(
        db_path=tmp_path / 'enc_ws.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'Encrypted'})
    ctx.persist()
    store = ctx.repository.load()
    assert any(c.title == 'Encrypted' for c in store.conversations.values())
    ctx.close()
    # Reopen and verify persistence.
    ctx2 = create_context(
        db_path=tmp_path / 'enc_ws.db', data_dir=tmp_path, for_tests=True)
    store2 = ctx2.repository.load()
    assert any(c.title == 'Encrypted' for c in store2.conversations.values())
    ctx2.close()
