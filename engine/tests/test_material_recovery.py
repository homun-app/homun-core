"""Durable upload identities and managed original recovery."""
import hashlib
import pytest
from test_f42_materials_ingest import client, _headers, _project
from homun.context import get_context


def upload(tc, project, content=b'hello', command='upload-1', **kwargs):
    return tc.post(f'/v1/workspaces/ws_local/projects/{project}/materials/ingest',
                   headers={**_headers(), 'X-Homun-Command-Id': command},
                   files={'file': ('a.txt', content, 'text/plain')}, **kwargs)


def test_upload_retry_is_one_material_and_conflicting_bytes_rejected(client):
    tc, root = client
    project = _project(tc)
    first = upload(tc, project)
    retry = upload(tc, project)
    assert first.status_code == 200
    assert retry.json() == first.json()
    assert upload(tc, project, b'changed').status_code == 409
    assert len(get_context().repository.load().materials) == 1
    assert (root / 'materials/content' / hashlib.sha256(b'hello').hexdigest() / 'original').read_bytes() == b'hello'


def test_commit_failure_leaves_no_new_original(client, monkeypatch):
    tc, root = client
    project = _project(tc)
    repo = get_context().repository
    def fail(store):
        raise RuntimeError('SQL commit failed')
    monkeypatch.setattr(repo, '_save', fail)
    with pytest.raises(RuntimeError, match='SQL commit failed'):
        upload(tc, project)
    assert not list(root.glob('materials/**/original'))


def test_recovery_preserves_shared_references_and_legacy_files(client):
    from homun.application.material_ingest import recover_materials
    tc, root = client
    project = _project(tc)
    first = upload(tc, project).json()
    # Identical bytes in the same project are one material; a second project
    # keeps its own reference to the shared content-addressed original.
    other = tc.post('/v1/workspaces/ws_local/commands', headers=_headers(),
                    json={'command_id': 'cmd_recovery_proj2', 'type': 'project.create',
                          'payload': {'name': 'Altro'}})
    other_project = str(other.json()['result']['project_id'])
    second = upload(tc, other_project, command='upload-2').json()
    assert second['material_id'] != first['material_id']
    ctx = get_context()
    with ctx.repository.transaction() as store:
        del store.materials[first['material_id']]
    orphan = root / 'materials/content' / ('f' * 64) / 'original'
    orphan.parent.mkdir(parents=True)
    orphan.write_bytes(b'orphan')
    pending = orphan.parent / '.pending-crash'
    pending.write_bytes(b'partial')
    legacy = root / 'materials/mat_old/v1/original'
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes(b'legacy')
    removed = recover_materials(ctx)
    assert len(removed) == 2
    assert not orphan.exists() and not pending.exists()
    assert legacy.read_bytes() == b'legacy'
    stored = ctx.repository.load().materials[second['material_id']]
    assert (root / stored.storage_relpath).read_bytes() == b'hello'
    assert recover_materials(ctx) == []


def test_existing_original_integrity_failure_is_explicit(client):
    tc, root = client
    project = _project(tc)
    material_id = upload(tc, project).json()['material_id']
    material = get_context().repository.load().materials[material_id]
    (root / material.storage_relpath).write_bytes(b'corrupt')
    assert upload(tc, project).status_code == 409
    download = tc.get(f'/v1/workspaces/ws_local/materials/{material_id}/blob', headers=_headers())
    assert download.status_code == 409
    assert download.json()['detail']['code'] == 'material_integrity_error'
    assert len(get_context().repository.load().materials) == 1


def test_shared_original_survives_failed_registration(client, monkeypatch):
    tc, root = client
    project = _project(tc)
    original = upload(tc, project).json()
    repo = get_context().repository
    def fail(store):
        raise RuntimeError('SQL commit failed')
    monkeypatch.setattr(repo, '_save', fail)
    with pytest.raises(RuntimeError):
        upload(tc, project, command='upload-2')
    assert len(repo.load().materials) == 1
    assert (root / repo.load().materials[original['material_id']].storage_relpath).read_bytes() == b'hello'


def test_replay_rechecks_current_project_permission(client):
    tc, _ = client
    project = _project(tc)
    assert upload(tc, project).status_code == 200
    ctx = get_context()
    with ctx.repository.transaction() as store:
        store.grants.clear()
    assert upload(tc, project).status_code == 403


def test_upload_size_limit(client, monkeypatch):
    import homun.routes.materials as routes
    tc, root = client
    project = _project(tc)
    monkeypatch.setattr(routes, 'MAX_UPLOAD_BYTES', 3)
    result = upload(tc, project)
    assert result.status_code == 413
    assert result.json()['detail']['code'] == 'material_too_large'
    assert not list(root.glob('materials/**/original'))


def test_identity_rejects_changed_metadata_and_authorized_other_actor(client):
    tc, _ = client
    project = _project(tc)
    assert upload(tc, project).status_code == 200
    assert upload(tc, project, data={'title': 'changed'}).status_code == 409
    ctx = get_context()
    with ctx.repository.transaction() as store:
        grant = next(iter(store.grants.values())).model_copy(deep=True)
        grant.id = 'other-grant'
        grant.subject_id = 'person_other'
        store.grants[grant.id] = grant
    result = tc.post(f'/v1/workspaces/ws_local/projects/{project}/materials/ingest',
                     headers={'X-Homun-Actor-Id': 'person_other', 'X-Homun-Command-Id': 'upload-1'},
                     files={'file': ('a.txt', b'hello', 'text/plain')})
    assert result.status_code == 409


def test_symlinked_managed_namespace_cannot_escape_data_directory(client, tmp_path):
    tc, root = client
    project = _project(tc)
    outside = tmp_path / 'outside'
    outside.mkdir()
    materials = root / 'materials'
    materials.mkdir(exist_ok=True)
    content = materials / 'content'
    if content.exists():
        content.rmdir()
    content.symlink_to(outside, target_is_directory=True)
    result = upload(tc, project)
    assert result.status_code == 400
    assert list(outside.iterdir()) == []
    assert not get_context().repository.load().materials


def test_retry_identity_does_not_depend_on_extractor_version(client, monkeypatch):
    from homun.application import material_ingest
    from homun.materials.extract import ExtractResult
    tc, root = client
    project = _project(tc)
    first = upload(tc, project)
    monkeypatch.setattr(material_ingest, 'extract_text', lambda *a, **kw: ExtractResult('failed', '', 'application/octet-stream'))
    retry = upload(tc, project)
    assert retry.status_code == 200, retry.text
    assert retry.json() == first.json()


def test_disk_failure_is_typed_and_does_not_leak_path(client, monkeypatch):
    from homun.application import material_ingest
    tc, _ = client
    project = _project(tc)
    def unavailable(*args):
        raise OSError('/private/sensitive/path is full')
    monkeypatch.setattr(material_ingest, 'publish', unavailable)
    response = upload(tc, project)
    assert response.status_code == 503
    assert response.json()['detail']['code'] == 'storage_unavailable'
    assert 'sensitive' not in response.text


def test_retry_after_failed_publication_sync_repeats_durability_barrier(tmp_path, monkeypatch):
    from homun.materials import managed_blobs as blobs
    data = b'file content'
    digest = hashlib.sha256(data).hexdigest()
    original_sync = blobs._sync_dir
    def failed(path):
        raise OSError('sync failed')
    with blobs.materials_lock(tmp_path):
        monkeypatch.setattr(blobs, '_sync_dir', failed)
        with pytest.raises(OSError):
            blobs.publish(tmp_path, data, digest)
        synced = []
        def record(path):
            synced.append(path)
            original_sync(path)
        monkeypatch.setattr(blobs, '_sync_dir', record)
        blobs.publish(tmp_path, data, digest)
        assert tmp_path.resolve() in synced
        assert len(synced) == 4
