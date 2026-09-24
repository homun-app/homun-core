import os
import pytest
from homun.domain.errors import PermissionDeniedError, ValidationError


def test_scoped_read_and_bounded_listing(tmp_path):
    from homun.execution.files import WorkspaceFiles
    (tmp_path/'note.txt').write_text('Ciao mondo')
    files=WorkspaceFiles(tmp_path)
    assert files.read('note.txt')==b'Ciao mondo'
    assert files.list()['items'][0]['name']=='note.txt'


@pytest.mark.parametrize('name',['../secret','/etc/passwd','a/../secret','a\\secret'])
def test_path_escape_is_rejected(tmp_path,name):
    from homun.execution.files import WorkspaceFiles
    with pytest.raises(PermissionDeniedError):WorkspaceFiles(tmp_path).read(name)


def test_symlink_fifo_and_hardlink_are_not_read(tmp_path):
    from homun.execution.files import WorkspaceFiles
    (tmp_path/'target').write_text('private')
    (tmp_path/'link').symlink_to(tmp_path/'target')
    os.mkfifo(tmp_path/'pipe')
    os.link(tmp_path/'target',tmp_path/'hard')
    for name in ['link','pipe','hard']:
        with pytest.raises(PermissionDeniedError):WorkspaceFiles(tmp_path).read(name)


def test_intermediate_symlink_and_size_limit(tmp_path):
    from homun.execution.files import WorkspaceFiles
    (tmp_path/'dir').mkdir();(tmp_path/'dir'/'big').write_bytes(b'x'*20)
    (tmp_path/'alias').symlink_to(tmp_path/'dir',target_is_directory=True)
    with pytest.raises(PermissionDeniedError):WorkspaceFiles(tmp_path).read('alias/big')
    with pytest.raises(ValidationError):WorkspaceFiles(tmp_path).read('dir/big',max_bytes=10)


def test_file_mutation_during_read_is_detected(tmp_path,monkeypatch):
    from homun.execution.files import WorkspaceFiles,FileChangedError
    path=tmp_path/'file';path.write_bytes(b'original');original=os.read;first=True
    def changed(fd,n):
        nonlocal first
        data=original(fd,n)
        if first:first=False;path.write_bytes(b'changed!')
        return data
    monkeypatch.setattr(os,'read',changed)
    with pytest.raises(FileChangedError):WorkspaceFiles(tmp_path).read('file')


def test_list_reports_incomplete_results(tmp_path):
    from homun.execution.files import WorkspaceFiles
    for i in range(3):(tmp_path/str(i)).write_text(str(i))
    result=WorkspaceFiles(tmp_path).list(limit=2)
    assert result['truncated'] and len(result['items'])==2
