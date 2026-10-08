"""Exclusive process ownership of a local engine directory (macOS/Linux)."""
from contextlib import contextmanager
import json
import os
from pathlib import Path


class EngineBusyError(RuntimeError):
    def __init__(self, message: str, holder_pid: int | None = None):
        super().__init__(message)
        self.holder_pid = holder_pid


def _holder_pid(fd: int) -> int | None:
    # Best effort: the current owner writes {"pid": ...} after acquiring the
    # lease, so a refused contender can name the process holding the directory.
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        record = json.loads(os.read(fd, 128).decode() or 'null')
        pid = record.get('pid') if isinstance(record, dict) else None
        return pid if isinstance(pid, int) and pid > 0 else None
    except (OSError, ValueError):
        return None


@contextmanager
def engine_lease(data_dir: Path, *, on_busy=None):
    # Never unlink the lock file: replacing its inode would admit a second owner.
    import fcntl
    data_dir.mkdir(parents=True, exist_ok=True)
    fd = os.open(data_dir/'engine.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            error = EngineBusyError('Engine directory busy: another owner is running',
                                    holder_pid=_holder_pid(fd))
            if on_busy is not None:
                on_busy(error)
            raise error from exc
        try:
            os.ftruncate(fd, 0)
            os.write(fd, json.dumps({'pid': os.getpid()}).encode())
        except OSError:
            pass  # The lease holds regardless; the pid record is diagnostic only.
        yield
    finally:
        os.close(fd)
