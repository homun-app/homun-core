"""Complete offline recovery bundles preserve originals and reject live writers."""
import hashlib
import json
from pathlib import Path

import pytest

from homun.context import create_context
from homun.domain.models import MaterialVersion
from homun.storage.backup import BackupError


def seeded(root):
    root.mkdir()
    ctx = create_context(db_path=root/'ws_local.sqlite3', data_dir=root, for_tests=True)
    data = b'original source bytes'
    path = root/'materials'/'legacy'/'v1'/'original'
    path.parent.mkdir(parents=True)
    path.write_bytes(data)
    ctx.service.store.materials['mat'] = MaterialVersion(id='mat',workspace_id='ws_local',project_id='project',
        title='Original',kind='file_ref',storage_relpath=str(path.relative_to(root)),
        content_hash=hashlib.sha256(data).hexdigest(),byte_size=len(data))
    ctx.persist()
    ctx.close()
    (root/'secrets.json').write_text('{"secret":"do-not-export"}')
    return path


def test_full_backup_roundtrip_and_secret_exclusion(tmp_path):
    from homun.storage.installation_backup import create_installation_backup, restore_installation_backup, verify_installation_backup
    source = tmp_path/'source'
    original = seeded(source)
    backup = create_installation_backup(source, tmp_path/'backups', workspace_id='ws_local')
    manifest = verify_installation_backup(backup)
    assert manifest.version == 2
    assert 'secrets.json' not in [entry['name'] for entry in manifest.files]
    destination = tmp_path/'restored'
    restored_db = restore_installation_backup(backup, destination)
    ctx = create_context(db_path=restored_db,data_dir=destination,for_tests=True)
    try:
        material = ctx.repository.load().materials['mat']
        assert (destination/material.storage_relpath).read_bytes() == original.read_bytes()
    finally:
        ctx.close()
    assert not (destination/'secrets.json').exists()


def test_live_owner_blocks_complete_backup(tmp_path):
    from homun.storage.installation_backup import create_installation_backup
    from homun.storage.lease import engine_lease
    source = tmp_path/'source'
    seeded(source)
    with engine_lease(source):
        with pytest.raises(BackupError, match='running|busy|owner'):
            create_installation_backup(source,tmp_path/'backups',workspace_id='ws_local')
    assert not (tmp_path/'backups').exists()


def test_missing_original_does_not_publish_partial_backup(tmp_path):
    from homun.storage.installation_backup import create_installation_backup
    source = tmp_path/'source'
    seeded(source).unlink()
    with pytest.raises(BackupError):
        create_installation_backup(source,tmp_path/'backups',workspace_id='ws_local')
    assert not list((tmp_path/'backups').glob('*'))


def test_tampered_inventory_and_symlink_rejected(tmp_path):
    from homun.storage.installation_backup import create_installation_backup, verify_installation_backup
    source = tmp_path/'source'
    seeded(source)
    backup = create_installation_backup(source,tmp_path/'backups',workspace_id='ws_local')
    manifest = json.loads((backup/'manifest.json').read_text())
    manifest['files'].append({'name':'../outside','bytes':0,'sha256':hashlib.sha256(b'').hexdigest()})
    (backup/'manifest.json').write_text(json.dumps(manifest))
    with pytest.raises(BackupError):
        verify_installation_backup(backup)


def test_restored_pending_work_resumes_with_originals(tmp_path):
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.context import reset_context_for_tests
    from homun.storage.installation_backup import create_installation_backup, restore_installation_backup
    from test_f41_durable_runtime import _seed_ready_work, _headers
    source=tmp_path/'source'
    original=seeded(source).read_bytes()
    reset_context_for_tests(create_context(db_path=source/'ws_local.sqlite3',data_dir=source,for_tests=True))
    try:
        with TestClient(create_app()) as client:
            work_id,version=_seed_ready_work(client)
            response=client.post('/v1/workspaces/ws_local/commands',headers=_headers(),json={
                'command_id':'start_backup','type':'work.start',
                'payload':{'work_id':work_id,'expected_version':version,'durable':True,'to_actor_id':'person_fabio'}})
            assert response.status_code==200,response.text
            started=response.json()['result']
            with pytest.raises(BackupError,match='busy'):
                create_installation_backup(source,tmp_path/'live-backups')
    finally:
        reset_context_for_tests(None)
    backup=create_installation_backup(source,tmp_path/'backups')
    restored=tmp_path/'restored'
    database=restore_installation_backup(backup,restored)
    assert (restored/'materials/legacy/v1/original').read_bytes()==original
    reset_context_for_tests(create_context(db_path=database,data_dir=restored,for_tests=True))
    try:
        with TestClient(create_app()) as client:
            body={'command_id':'resume_backup','type':'work.provide_contribution',
                  'payload':{'request_id':started['request_id'],'expected_version':started['version'],'text':'Continue'}}
            response=client.post('/v1/workspaces/ws_local/commands',headers=_headers(),json=body)
            assert response.status_code==200,response.text
            assert response.json()['result']['status']=='completed'
            assert client.post('/v1/workspaces/ws_local/commands',headers=_headers(),json=body).json()==response.json()
        assert len(list((restored/'receipts').glob('*.json')))==1
    finally:
        reset_context_for_tests(None)


def test_restore_failure_does_not_publish_partial_destination(tmp_path, monkeypatch):
    from homun.storage import installation_backup as api
    source=tmp_path/'source'
    seeded(source)
    backup=api.create_installation_backup(source,tmp_path/'backups')
    original=api.shutil.copyfile
    def failed(source,target):
        original(source,target)
        raise OSError('disk full')
    monkeypatch.setattr(api.shutil,'copyfile',failed)
    with pytest.raises(BackupError):
        api.restore_installation_backup(backup,tmp_path/'restored')
    assert not (tmp_path/'restored').exists()
    assert not list(tmp_path.glob('.restore-*'))


def test_corrupt_dbos_rejected_even_with_matching_manifest_hash(tmp_path):
    from homun.storage.installation_backup import create_installation_backup
    source = tmp_path/'source'
    seeded(source)
    (source/'dbos.sqlite').write_bytes(b'corrupt database')
    with pytest.raises(BackupError):
        create_installation_backup(source, tmp_path/'backups')


def test_symlinked_original_rejected(tmp_path):
    from homun.storage.installation_backup import create_installation_backup
    source = tmp_path/'source'
    original = seeded(source)
    outside = tmp_path/'original'
    original.rename(outside)
    original.symlink_to(outside)
    with pytest.raises(BackupError, match='Symbolic'):
        create_installation_backup(source, tmp_path/'backups')


def test_server_obtains_lease_before_creating_context(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from homun import app, context
    from homun.storage.lease import engine_lease, EngineBusyError
    source = tmp_path/'source'
    seeded(source)
    monkeypatch.setenv('HOMUN_DATA_DIR', str(source))
    monkeypatch.setattr(context, '_CONTEXT', None)
    def unexpected():
        pytest.fail('Context initialized while another owner holds the engine lease')
    monkeypatch.setattr(app, 'create_context', unexpected)
    with engine_lease(source), pytest.raises(EngineBusyError):
        with TestClient(app.create_app()):
            pass


def test_installation_restore_rejects_nonempty_ds_store_destination(tmp_path):
    from homun.storage.installation_backup import create_installation_backup, restore_installation_backup
    source = tmp_path/'source'
    seeded(source)
    backup = create_installation_backup(source, tmp_path/'backups')
    destination = tmp_path/'restored'
    destination.mkdir()
    (destination/'.DS_Store').write_bytes(b'metadata')
    with pytest.raises(BackupError, match='completely empty'):
        restore_installation_backup(backup, destination)
    assert (destination/'.DS_Store').read_bytes() == b'metadata'


def test_killed_backup_staging_is_never_listed_as_published(tmp_path):
    import signal
    import subprocess
    import sys
    from homun.storage.backup import list_backups
    from homun.storage.installation_backup import create_installation_backup

    source = tmp_path/'source'
    seeded(source)
    backups = tmp_path/'backups'
    completed = create_installation_backup(source, backups)
    # Kill after writing/validating the manifest but before syncing/publication.
    script = '''
import os, signal, sys
from pathlib import Path
from homun.storage import installation_backup as api
api._sync_tree = lambda root: os.kill(os.getpid(), signal.SIGKILL)
api.create_installation_backup(Path(sys.argv[1]), Path(sys.argv[2]))
'''
    result = subprocess.run([sys.executable, '-c', script, str(source), str(backups)],
                            capture_output=True, timeout=15)
    assert result.returncode == -signal.SIGKILL
    pending = list(backups.glob('.pending-*'))
    assert len(pending) == 1 and (pending[0]/'manifest.json').is_file()
    assert [item['id'] for item in list_backups(backups)] == [completed.name]
    # Crash releases the lease: another complete backup must still succeed.
    resumed = create_installation_backup(source, backups)
    assert {item['id'] for item in list_backups(backups)} == {completed.name, resumed.name}


@pytest.mark.parametrize('failure_point', ['sqlite_copy', 'material_copy', 'sync'])
def test_storage_failure_preserves_existing_backup_and_releases_owner(tmp_path, monkeypatch, failure_point):
    import errno
    from homun.storage import installation_backup as api
    from homun.storage.backup import list_backups

    source = tmp_path/'source'
    original = seeded(source)
    original_bytes = original.read_bytes()
    backups = tmp_path/'backups'
    completed = api.create_installation_backup(source, backups)
    manifest = (completed/'manifest.json').read_bytes()

    def disk_full(*args, **kwargs):
        raise OSError(errno.ENOSPC, 'synthetic storage exhausted')

    with monkeypatch.context() as patch:
        if failure_point == 'sqlite_copy':
            patch.setattr(api, '_export_sqlite_copy', disk_full)
        elif failure_point == 'material_copy':
            patch.setattr(api.shutil, 'copyfile', disk_full)
        else:
            patch.setattr(api, '_sync_tree', disk_full)
        with pytest.raises(BackupError, match='space and permissions'):
            api.create_installation_backup(source, backups)
    assert [entry['id'] for entry in list_backups(backups)] == [completed.name]
    assert not list(backups.glob('.pending-*'))
    assert (completed/'manifest.json').read_bytes() == manifest
    assert original.read_bytes() == original_bytes
    api.verify_installation_backup(completed)
    assert api.create_installation_backup(source, backups).is_dir()


def test_restore_sync_failure_keeps_empty_destination_and_backup(tmp_path, monkeypatch):
    import errno
    from homun.storage import installation_backup as api
    source = tmp_path/'source'
    seeded(source)
    backup = api.create_installation_backup(source, tmp_path/'backups')
    destination = tmp_path/'destination'
    destination.mkdir()
    def disk_full(*args):
        raise OSError(errno.ENOSPC, 'synthetic sync failure')
    with monkeypatch.context() as patch:
        patch.setattr(api, '_sync_tree', disk_full)
        with pytest.raises(BackupError, match='space and permissions'):
            api.restore_installation_backup(backup, destination)
    assert destination.is_dir() and not list(destination.iterdir())
    assert not list(tmp_path.glob('.restore-*'))
    api.verify_installation_backup(backup)
    assert api.restore_installation_backup(backup, destination).is_file()
