"""Immutable filesystem capture rejects hazards and never invents completeness."""
import os
from pathlib import Path
import pytest
from homun.application.session_workspace_capture import capture
from homun.domain.errors import DomainError


def take(tmp_path, **kwargs):
    root = tmp_path/'source'
    root.mkdir(exist_ok=True)
    return capture(tmp_path, root, workspace_id='ws', work_id='work', run_id='run', backend='local-private-v1', **kwargs)


@pytest.mark.parametrize('hazard', ['symlink', 'fifo', 'hardlink', 'root-symlink'])
def test_capture_refuses_unsafe_files_and_roots(tmp_path, hazard):
    source = tmp_path/'source'
    source.mkdir()
    (source/'note').write_text('content')
    if hazard == 'symlink':
        (source/'link').symlink_to(source/'note')
    elif hazard == 'fifo':
        os.mkfifo(source/'pipe')
    elif hazard == 'hardlink':
        os.link(source/'note', source/'hard')
    else:
        source.rename(tmp_path/'actual')
        source.symlink_to(tmp_path/'actual', target_is_directory=True)
    with pytest.raises(DomainError):
        take(tmp_path)


def test_capture_lists_secret_exclusions_and_binds_executable_and_empty_directory(tmp_path):
    source = tmp_path/'source'
    source.mkdir()
    (source/'note').write_text('ordinary')
    (source/'note').chmod(0o700)
    (source/'.env').write_text('PASSWORD=secret')
    (source/'private.txt').write_text('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----')
    (source/'empty').mkdir()
    value = take(tmp_path, cwd='empty')
    assert [entry['path'] for entry in value['files']] == ['note']
    assert value['files'][0]['executable']
    assert {entry['path'] for entry in value['exclusions']} == {'.env', 'private.txt'}
    assert value['directories'] == ['empty']


def test_published_recovery_rejects_extra_files_and_changed_modes(tmp_path):
    from homun.application.session_workspace import _verify
    source = tmp_path/'source'
    source.mkdir()
    (source/'note').write_text('ordinary')
    manifest = take(tmp_path)
    (source/'unexpected').write_text('not approved')
    with pytest.raises(DomainError):
        _verify(source, manifest)
    (source/'unexpected').unlink()
    (source/'note').chmod(0o700)
    with pytest.raises(DomainError):
        _verify(source, manifest)


@pytest.mark.parametrize('path', ['../outside', '/absolute', 'nested/../outside', 'a\\b'])
def test_manifest_schema_rejects_escaped_paths(tmp_path, path):
    from homun.application.session_workspace_capture import WorkspaceManifest
    manifest = take(tmp_path)
    manifest['directories'] = [path]
    with pytest.raises((DomainError, ValueError)):
        WorkspaceManifest.model_validate(manifest)


def test_interrupted_blob_write_does_not_poison_retry(tmp_path, monkeypatch):
    from homun.application import session_workspace_capture as module
    source = tmp_path/'source'
    source.mkdir()
    (source/'note').write_bytes(b'complete content')
    original = module.os.fdopen
    class Interrupted:
        def __init__(self, stream):
            self.stream = stream
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.stream.close()
        def write(self, data):
            self.stream.write(data[:2])
            raise OSError('interrupted write')
    monkeypatch.setattr(module.os, 'fdopen', lambda *a, **k: Interrupted(original(*a, **k)))
    with pytest.raises(OSError):
        take(tmp_path)
    monkeypatch.setattr(module.os, 'fdopen', original)
    assert take(tmp_path)['files'][0]['size'] == len(b'complete content')


def test_capture_detects_concurrent_changes_and_limits(tmp_path, monkeypatch):
    from homun.application import session_workspace_capture as module
    source = tmp_path/'source'
    source.mkdir()
    (source/'note').write_text('original')
    original = module._publish_blob
    def changed(*args, **kwargs):
        original(*args, **kwargs)
        (source/'new').write_text('changed during capture')
    monkeypatch.setattr(module, '_publish_blob', changed)
    with pytest.raises(DomainError):
        take(tmp_path)
    monkeypatch.setattr(module, '_publish_blob', original)
    monkeypatch.setattr(module, 'MAX_FILES', 1)
    with pytest.raises(DomainError):
        take(tmp_path)


@pytest.mark.parametrize('cwd', ['missing', '../outside', '/outside'])
def test_capture_rejects_missing_or_escaped_cwd(tmp_path, cwd):
    with pytest.raises(DomainError):
        take(tmp_path, cwd=cwd)


def test_process_exit_at_blob_publication_leaves_readable_immutable_blob(tmp_path):
    import subprocess
    import sys
    source = tmp_path/'source'
    source.mkdir()
    (source/'note').write_bytes(b'crash-safe')
    script = '''import os,sys
from pathlib import Path
from homun.application.session_workspace_capture import capture
for name in ('link','rename'):
    original=getattr(os,name)
    def crashed(src,dst,*a,_original=original,**k):
        result=_original(src,dst,*a,**k)
        if Path(src).name.startswith('.capture-'): os._exit(41)
        return result
    setattr(os,name,crashed)
capture(Path(sys.argv[1]),Path(sys.argv[1])/'source',workspace_id='ws',work_id='work',run_id='run',backend='local-private-v1')
'''
    result = subprocess.run([sys.executable, '-c', script, str(tmp_path)])
    assert result.returncode == 41
    assert take(tmp_path)['files'][0]['size'] == len(b'crash-safe')
