"""Exclusive process ownership of a local engine directory (macOS/Linux)."""
from contextlib import contextmanager
import json
import os
from pathlib import Path


class EngineBusyError(RuntimeError):
    def __init__(self, message: str, holder_pid: int | None = None):
        super().__init__(message)
        self.holder_pid = holder_pid


class RecoveryLeaseError(RuntimeError):
    """Recovery rifiutata: la lease della cartella dati è di un altro processo."""

    def __init__(self, message: str, holder_pid: int | None = None):
        super().__init__(message)
        self.holder_pid = holder_pid


# Registro in-process delle cartelle di cui questo processo detiene la lease:
# rende verificabile il possesso senza ritentare il flock (che in questo
# processo, su un nuovo fd, confliggerebbe con sé stesso).
_OWNED_DIRS: set[str] = set()


def _resolved(data_dir: Path) -> str:
    return str(Path(data_dir).resolve())


def owns_engine_lease(data_dir: Path) -> bool:
    """True se questo processo detiene la lease della cartella dati."""
    return _resolved(data_dir) in _OWNED_DIRS


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
        key = _resolved(data_dir)
        _OWNED_DIRS.add(key)
        try:
            os.ftruncate(fd, 0)
            os.write(fd, json.dumps({'pid': os.getpid()}).encode())
        except OSError:
            pass  # The lease holds regardless; the pid record is diagnostic only.
        try:
            yield
        finally:
            _OWNED_DIRS.discard(key)
    finally:
        os.close(fd)


@contextmanager
def recovery_lease(data_dir: Path):
    """Possesso esclusivo della cartella dati: prerequisito per la recovery.

    `salvage_workspace` sposta i file del workspace: deve essere impossibile
    farlo mentre un altro processo possiede la directory. Riusa la lease che
    questo processo già detiene (registro in-process, es. il lifespan con
    `engine_lease`); altrimenti acquisisce lo stesso `engine.lock` in modo non
    bloccante e lo rilascia all'uscita. Mai cancella `engine.lock`.
    """
    import fcntl
    if owns_engine_lease(data_dir):
        yield
        return
    data_dir.mkdir(parents=True, exist_ok=True)
    fd = os.open(data_dir/'engine.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    owned = False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RecoveryLeaseError(
                'Recovery refused: another owner holds the data directory lease',
                holder_pid=_holder_pid(fd)) from exc
        key = _resolved(data_dir)
        _OWNED_DIRS.add(key)
        owned = True
        try:
            os.ftruncate(fd, 0)
            os.write(fd, json.dumps({'pid': os.getpid()}).encode())
        except OSError:
            pass  # The lease holds regardless; the pid record is diagnostic only.
        yield
    finally:
        if owned:
            _OWNED_DIRS.discard(_resolved(data_dir))
        os.close(fd)
