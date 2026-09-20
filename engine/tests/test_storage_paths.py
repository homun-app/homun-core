"""External manifests and stored paths cannot escape their storage roots."""
import hashlib
import json

import pytest

from homun.materials.blob import read_material_blob
from homun.storage.backup import BackupError, verify_backup


def manifest(folder, files, workspace='ws_local'):
    (folder/'manifest.json').write_text(json.dumps({'format':'homun-engine-backup','version':1,
        'workspace_id':workspace,'created_at':'test','files':files,'notes':[]}))


@pytest.mark.parametrize('name', ['../outside', '/tmp/absolute', '..\\outside'])
def test_manifest_rejects_escaping_names_before_read(tmp_path, name):
    backup = tmp_path/'backup'
    backup.mkdir()
    outside = tmp_path/'outside'
    outside.write_bytes(b'private')
    manifest(backup, [{'name':name,'sha256':hashlib.sha256(b'private').hexdigest(),'bytes':7}])
    with pytest.raises(BackupError):
        verify_backup(backup)


@pytest.mark.parametrize('files', [[], [{'name':'ws_local.sqlite3'}, {'name':'ws_local.sqlite3'}]])
def test_manifest_requires_one_workspace_database(tmp_path, files):
    (tmp_path/'ws_local.sqlite3').write_bytes(b'')
    for item in files:
        item['sha256'] = hashlib.sha256(b'').hexdigest()
    manifest(tmp_path, files)
    with pytest.raises(BackupError):
        verify_backup(tmp_path)


def test_manifest_rejects_symlink_to_outside(tmp_path):
    backup = tmp_path/'backup'
    backup.mkdir()
    (tmp_path/'outside').write_bytes(b'data')
    (backup/'ws_local.sqlite3').symlink_to(tmp_path/'outside')
    manifest(backup, [{'name':'ws_local.sqlite3','sha256':hashlib.sha256(b'data').hexdigest()}])
    with pytest.raises(BackupError):
        verify_backup(backup)


def test_blob_rejects_sibling_with_shared_prefix(tmp_path):
    root = tmp_path/'data'
    root.mkdir()
    sibling = tmp_path/'data-private'
    sibling.mkdir()
    (sibling/'secret').write_bytes(b'private')
    with pytest.raises(ValueError):
        read_material_blob(root, '../data-private/secret')


def test_backup_create_validates_identity_before_writing(tmp_path):
    from homun.storage.backup import create_backup
    with pytest.raises(BackupError, match='Invalid backup workspace'):
        create_backup(workspace_id='../outside', source_db=tmp_path/'source.db', backups_root=tmp_path/'backups')
    assert not (tmp_path/'backups').exists()
