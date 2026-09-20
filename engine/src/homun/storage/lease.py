"""Exclusive process ownership of a local engine directory (macOS/Linux)."""
from contextlib import contextmanager
import os
from pathlib import Path


class EngineBusyError(RuntimeError):
    pass


@contextmanager
def engine_lease(data_dir: Path):
    # Never unlink the lock file: replacing its inode would admit a second owner.
    import fcntl
    data_dir.mkdir(parents=True, exist_ok=True)
    fd = os.open(data_dir/'engine.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise EngineBusyError('Engine directory busy: another owner is running') from exc
        yield
    finally:
        os.close(fd)
