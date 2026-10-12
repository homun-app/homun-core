"""La recovery scatta SOLO sulla corruzione vera.

Errori temporanei (database bloccato) o di configurazione (permessi, chiave)
devono fermare l'avvio con un errore tipizzato e leggibile, lasciando i file
del workspace esattamente al loro posto. La classificazione vive in
`storage.recovery.is_corruption`; il possesso del lock della cartella dati è
prerequisito per muovere file (`storage.lease`).
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError as PydanticValidationError

from homun.context import create_context, create_context_with_recovery
from homun.domain.models import Actor
from homun.storage.encryption import EncryptionError
from homun.storage.recovery import WorkspaceUnavailableError, db_state, is_corruption
from homun.storage.lease import RecoveryLeaseError


class _SqliteError(sqlite3.DatabaseError):
    """Errore sqlite con verdetto esplicito, come quelli raising da sqlite3."""

    def __init__(self, name: str | None):
        super().__init__(name or 'sqlite error')
        self.sqlite_errorname = name


class _Model(BaseModel):
    x: int


try:
    _Model.model_validate({'x': 'non è un intero'})
except PydanticValidationError as _exc:
    _PYDANTIC_ERROR = _exc


def _wrapped_encryption(cause: Exception) -> EncryptionError:
    try:
        raise EncryptionError('Cannot unlock workspace with the supplied key') from cause
    except EncryptionError as exc:
        return exc


IS_CORRUPTION_CASES = [
    # (eccezione, chiave configurata, corruzione attesa)
    (_SqliteError('SQLITE_CORRUPT'), False, True),
    (_SqliteError('SQLITE_CORRUPT'), True, True),
    (_SqliteError('SQLITE_CORRUPT_INDEX'), False, True),   # variante estesa: prefisso
    (_SqliteError('SQLITE_CORRUPT_SEQUENCE'), False, True),
    (_SqliteError('SQLITE_NOTADB'), False, True),
    (_SqliteError('SQLITE_BUSY'), False, False),
    (_SqliteError('SQLITE_BUSY_SNAPSHOT'), False, False),
    (_SqliteError('SQLITE_LOCKED'), False, False),
    (_SqliteError('SQLITE_CANTOPEN'), False, False),
    (_SqliteError('SQLITE_PERM'), False, False),
    (_SqliteError('SQLITE_READONLY'), False, False),
    (_SqliteError('SQLITE_IOERR'), False, False),
    (_SqliteError('SQLITE_IOERR_READ'), False, False),
    (_SqliteError('SQLITE_FULL'), False, False),
    (_SqliteError(None), False, False),                    # errorname None → fatale
    (sqlite3.DatabaseError('senza errorname'), False, False),  # attributo assente
    (_PYDANTIC_ERROR, False, True),                        # righe che non validano più
    (_PYDANTIC_ERROR, True, True),
    (EncryptionError('Workspace is encrypted or invalid'), False, False),  # senza chiave: mai quarantena
    (EncryptionError('Cannot unlock workspace with the supplied key'), True, False),
    (_wrapped_encryption(_SqliteError('SQLITE_CORRUPT')), True, False),    # avvolta, con chiave
    (_wrapped_encryption(_SqliteError('SQLITE_BUSY')), True, False),
    (PermissionError('permesso negato'), False, False),
    (ValueError('workspace_id mismatch'), False, False),
]


@pytest.mark.parametrize('exc, key_configured, expected', IS_CORRUPTION_CASES,
                         ids=[f'{type(e).__name__}-{getattr(e, "sqlite_errorname", None)}'
                              f'-key{int(k)}-{"corrupt" if c else "fatal"}'
                              for e, k, c in IS_CORRUPTION_CASES])
def test_is_corruption_classifies_sqlite_verdicts(exc, key_configured, expected):
    assert is_corruption(exc, key_configured=key_configured) is expected


def test_database_error_without_errorname_is_fatal():
    assert is_corruption(sqlite3.DatabaseError('errore opaco'), key_configured=False) is False


# ---------------------------------------------------------------- helper boot

def _seed(tmp_path, count=1, name='engine.db'):
    ctx = create_context(db_path=tmp_path / name, data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            for index in range(count):
                ctx.service.for_store(store).apply(
                    actor, f'c{index}', 'conversation.create', {'title': f'Conv {index}'})
    db_path = ctx.repository.path
    ctx.close()
    return db_path


def _hash(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _quick_check(db_path) -> str:
    try:
        conn = sqlite3.connect(db_path)
        try:
            return conn.execute('PRAGMA quick_check').fetchone()[0]
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        return 'database disk image is malformed'


# ------------------------------------------------------- corruzione → recovery

def test_corrupted_pages_still_trigger_recovery(tmp_path):
    db_path = _seed(tmp_path, count=40)
    size = db_path.stat().st_size
    data = bytearray(db_path.read_bytes())
    # pagine corrotte al centro del file, mai l'header della prima pagina
    for start in (max(4096, size // 3), max(4096, size // 2)):
        data[start:start + 2048] = b'\xde\xad\xbe\xef' * 512
    db_path.write_bytes(bytes(data))

    check = _quick_check(db_path)
    recovered = create_context_with_recovery(db_path=db_path, data_dir=tmp_path,
                                             for_tests=True)
    try:
        state = db_state(tmp_path)
        if check == 'ok':
            assert state['state'] == 'ok'
        else:
            assert state['state'] in {'repaired', 'minimal'}
        assert _quick_check(db_path) == 'ok'
    finally:
        recovered.close()


# Intestazione SQLite seguita da dati illeggibili: SQLite stesso dichiara
# SQLITE_NOTADB, quindi è corruzione dimostrata e la recovery scatta.
CORRUPT_SQLITE_BYTES = b'SQLite format 3\x00' + b'this is not a database' * 100


def test_corrupt_sqlite_file_still_boots_via_recovery(tmp_path):
    db_path = tmp_path / 'engine.db'
    db_path.write_bytes(CORRUPT_SQLITE_BYTES)
    ctx = create_context_with_recovery(db_path=db_path, data_dir=tmp_path, for_tests=True)
    try:
        assert db_state(tmp_path)['state'] == 'minimal'
        assert ctx.repository.load().workspace_id == ctx.workspace_id
    finally:
        ctx.close()


def test_non_sqlite_file_without_key_is_fatal_and_untouched(tmp_path, monkeypatch):
    """Un workspace cifrato avviato senza chiave non deve diventare un workspace vuoto.

    Senza chiave, un file privo dell'intestazione SQLite (cifrato o garbage,
    indistinguibili) è un errore fatale: nessuna quarantena, file intatto.
    """
    monkeypatch.delenv('HOMUN_WORKSPACE_KEY_FILE', raising=False)
    db_path = tmp_path / 'engine.db'
    db_path.write_bytes(os.urandom(4096))  # come appare un database SQLCipher
    before = _hash(db_path)
    with pytest.raises(WorkspaceUnavailableError) as info:
        create_context_with_recovery(db_path=db_path, data_dir=tmp_path, for_tests=True)
    assert 'HOMUN_WORKSPACE_KEY_FILE' in str(info.value)
    assert _hash(db_path) == before
    assert not (tmp_path / 'recovery').exists()


# ---------------------------------------------------- errori temporanei → fatali

def test_locked_database_is_fatal_and_untouched(tmp_path):
    """Il caso del bug vero: SQLITE_BUSY su un database sano non è corruzione."""
    db_path = _seed(tmp_path)
    before = _hash(db_path)
    blocker = sqlite3.connect(db_path, isolation_level=None)
    blocker.execute('BEGIN EXCLUSIVE')
    try:
        with pytest.raises(WorkspaceUnavailableError) as info:
            create_context_with_recovery(db_path=db_path, data_dir=tmp_path, for_tests=True)
        assert info.value.sqlite_errorname == 'SQLITE_BUSY'
        assert Path(info.value.db_path) == db_path
        assert _hash(db_path) == before, 'il file è stato modificato: era sano'
        assert not (tmp_path / 'recovery').exists()
    finally:
        blocker.close()


@pytest.mark.skipif(sys.platform == 'win32', reason='chmod sui Unix')
@pytest.mark.skipif(os.name == 'posix' and os.geteuid() == 0, reason='root ignora i permessi')
def test_unreadable_permissions_are_fatal(tmp_path):
    db_path = _seed(tmp_path)
    before = _hash(db_path)
    db_path.chmod(0o000)
    try:
        with pytest.raises((OSError, WorkspaceUnavailableError)):
            create_context_with_recovery(db_path=db_path, data_dir=tmp_path, for_tests=True)
        assert not (tmp_path / 'recovery').exists()
    finally:
        db_path.chmod(0o600)
    assert _hash(db_path) == before


# ------------------------------------------------------------ gate sul lock

def test_recovery_refused_without_data_dir_lease(tmp_path):
    """Corruzione vera, ma la cartella dati è di un altro: niente file mossi."""
    # file SQLite corrotto → recovery certa (vedi test_corrupt_sqlite_file_still_boots);
    # qui deve scattare solo il rifiuto: il lock della cartella è di un altro
    db_path = tmp_path / 'engine.db'
    db_path.write_bytes(CORRUPT_SQLITE_BYTES)
    before = _hash(db_path)

    lock_fd = os.open(tmp_path / 'engine.lock', os.O_CREAT | os.O_RDWR)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        with pytest.raises(RecoveryLeaseError):
            create_context_with_recovery(db_path=db_path, data_dir=tmp_path, for_tests=True)
        assert _hash(db_path) == before
        assert not (tmp_path / 'recovery').exists()
    finally:
        os.close(lock_fd)


def test_recovery_reuses_engine_lease_already_held(tmp_path):
    """Con la lease del lifespan attiva la recovery procede senza deadlock."""
    from homun.storage.lease import engine_lease, owns_engine_lease

    db_path = tmp_path / 'engine.db'
    db_path.write_bytes(CORRUPT_SQLITE_BYTES)
    with engine_lease(tmp_path):
        assert owns_engine_lease(tmp_path)
        ctx = create_context_with_recovery(db_path=db_path, data_dir=tmp_path,
                                            for_tests=True)
        try:
            assert db_state(tmp_path)['state'] == 'minimal'
        finally:
            ctx.close()
    assert not owns_engine_lease(tmp_path)


# ----------------------------------------------- avvio fatale leggibile (stdout)

def test_startup_logs_workspace_path(tmp_path, caplog):
    """Diagnosi "quale database sto usando?": il percorso in uso va nel log."""
    import logging

    db_path = _seed(tmp_path)
    caplog.set_level(logging.INFO, logger="homun.context")
    ctx = create_context_with_recovery(db_path=db_path, data_dir=tmp_path, for_tests=True)
    try:
        lines = [record.getMessage() for record in caplog.records
                 if record.getMessage().startswith("Workspace: ")]
        assert lines == [f"Workspace: {db_path.resolve()}"]
    finally:
        ctx.close()


def test_unavailable_workspace_announces_on_stdout(tmp_path, monkeypatch, capsys):
    from fastapi.testclient import TestClient
    from homun import app, context

    db_path = _seed(tmp_path, name='ws_local.sqlite3')
    blocker = sqlite3.connect(db_path, isolation_level=None)
    blocker.execute('BEGIN EXCLUSIVE')
    monkeypatch.setenv('HOMUN_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(context, '_CONTEXT', None)
    try:
        with pytest.raises(WorkspaceUnavailableError):
            with TestClient(app.create_app()):
                pass
    finally:
        blocker.close()
    out = capsys.readouterr().out
    line = next(l for l in out.splitlines() if l.startswith('HOMUN_STARTUP_FAILED ')
                and 'workspace-unavailable' in l)
    payload = json.loads(line.split(' ', 1)[1])
    assert payload['reason'] == 'workspace-unavailable'
    assert payload['sqlite_error'] == 'SQLITE_BUSY'
    assert payload['db_path'] == str(db_path)
    assert not (tmp_path / 'recovery').exists()
