"""Immutable content originals. Publication and recovery share one OS lock."""
from contextlib import contextmanager
import fcntl
import hashlib
import os
from pathlib import Path
import re
import tempfile
from threading import RLock

from homun.domain.errors import ConflictError, ValidationError

_LOCK = RLock()


def _root(data_dir: Path) -> Path:
    root = data_dir.resolve()
    path = root / 'materials' / 'content'
    # Refuse symlinked namespaces, even when the link points inside the root.
    if (root / 'materials').is_symlink() or path.is_symlink():
        raise ValidationError('Managed material namespace must not be a symlink')
    path.mkdir(parents=True, exist_ok=True)
    return path


@contextmanager
def materials_lock(data_dir: Path):
    with _LOCK:
        root = _root(data_dir)
        fd = os.open(root.parent / '.publication.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield root
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)


def _sync_dir(path: Path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish(data_dir: Path, data: bytes, digest: str) -> tuple[str, bool]:
    """Caller holds materials_lock until its metadata transaction commits."""
    root = _root(data_dir)
    directory = root / digest
    if not re.fullmatch('[0-9a-f]{64}', digest) or directory.is_symlink():
        raise ValidationError('Invalid managed material digest')
    directory.mkdir(exist_ok=True)
    path = directory / 'original'
    if path.is_symlink():
        raise ValidationError('Managed original must not be a symlink')
    relpath = path.relative_to(data_dir.resolve()).as_posix()
    if path.exists():
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ConflictError('Stored material failed content integrity verification')
        for parent in (directory, root, root.parent, data_dir.resolve()):
            _sync_dir(parent)
        return relpath, False
    fd, temporary = tempfile.mkstemp(prefix='.pending-', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _sync_dir(directory)
        _sync_dir(root)
        _sync_dir(root.parent)
        _sync_dir(data_dir.resolve())
    finally:
        Path(temporary).unlink(missing_ok=True)
    return relpath, True


def collect_unreferenced(data_dir: Path, referenced: set[str]) -> list[str]:
    """Only known managed originals/temporary writes; legacy files are untouched."""
    root = _root(data_dir)
    protected = {(data_dir / name).resolve() for name in referenced}
    removed = []
    for directory in root.iterdir():
        if directory.is_symlink() or not directory.is_dir() or not re.fullmatch('[0-9a-f]{64}', directory.name):
            continue
        for path in directory.iterdir():
            if path.is_symlink() or not path.is_file():
                continue
            if path.name != 'original' and not path.name.startswith('.pending-'):
                continue
            if path.resolve() not in protected:
                path.unlink()
                removed.append(path.relative_to(data_dir.resolve()).as_posix())
        _sync_dir(directory)
    return removed
