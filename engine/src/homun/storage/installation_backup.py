"""Offline installation backup/restore with staged atomic publication."""
from datetime import datetime, timezone
from functools import wraps
import sqlite3
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from uuid import uuid4

from homun.storage.backup_types import BackupError, BackupManifest
from homun.storage.backup_io import _sha256_file, _export_sqlite_copy, _assert_clean_destination
from homun.storage.backup_inventory import FORMAT, VERSION, read_inventory, required_files, safe_path
from homun.storage.lease import EngineBusyError, engine_lease


def _io_errors(operation):
    @wraps(operation)
    def wrapped(*args, **kwargs):
        try:
            return operation(*args, **kwargs)
        except (OSError, sqlite3.Error) as exc:
            raise BackupError("Recovery storage operation failed; check available space and permissions") from exc
    return wrapped


def _empty_destination(destination):
    _assert_clean_destination(destination)
    if destination.exists() and any(destination.iterdir()):
        raise BackupError("Installation restore requires a completely empty destination")


def _sync_tree(root):
    for path in root.rglob('*'):
        if path.is_file():
            with path.open('rb') as handle:
                os.fsync(handle.fileno())
    for path in [*sorted((p for p in root.rglob('*') if p.is_dir()), reverse=True), root]:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _sync_parent(path):
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@_io_errors
def create_installation_backup(data_dir: Path, backups_root: Path, *, workspace_id='ws_local') -> Path:
    if not re.fullmatch(r'[A-Za-z0-9_-]+',workspace_id) or not data_dir.is_dir():
        raise BackupError('Invalid workspace or data directory')
    try:
        with engine_lease(data_dir):
            return _create(data_dir,backups_root,workspace_id)
    except EngineBusyError as exc:
        raise BackupError(str(exc)) from exc


def _create(data_dir, backups_root, workspace_id):
    names = required_files(data_dir,workspace_id)
    receipts = data_dir/'receipts'
    if receipts.is_symlink():
        raise BackupError('Symbolic receipt directory is not allowed')
    if receipts.is_dir():
        names.update(str(p.relative_to(data_dir)) for p in receipts.glob('*.json'))
    backups_root.mkdir(parents=True,exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.pending-',dir=backups_root))
    target = backups_root/(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid4().hex[:12])
    try:
        entries=[]
        for name in sorted(names):
            source=safe_path(data_dir,name)
            if not source.is_file():
                raise BackupError('Required recovery file is missing')
            destination=safe_path(stage,name)
            destination.parent.mkdir(parents=True,exist_ok=True)
            if name.endswith(('.sqlite','.sqlite3')) and '/' not in name:
                _export_sqlite_copy(source,destination)
            else:
                shutil.copyfile(source,destination)
            entries.append({'name':name,'bytes':destination.stat().st_size,'sha256':_sha256_file(destination)})
        manifest=BackupManifest(FORMAT,VERSION,datetime.now(timezone.utc).isoformat(),workspace_id,entries,[
            'Offline coherent recovery bundle: workspace, referenced originals, DBOS state and receipts.',
            'Provider credentials/configuration and rebuildable indexes excluded; reconfigure providers after restore.',
            'This archive is not encrypted or authenticated; protect it as application data.'])
        (stage/'manifest.json').write_text(json.dumps(manifest.to_dict(),indent=2)+'\n')
        verify_installation_backup(stage)
        _sync_tree(stage)
        stage.rename(target)
        _sync_parent(target)
        return target
    finally:
        if stage.exists():
            shutil.rmtree(stage)


@_io_errors
def verify_installation_backup(backup_dir: Path) -> BackupManifest:
    manifest=read_inventory(backup_dir)
    for entry in manifest.files:
        path=safe_path(backup_dir,entry['name'])
        if (not path.is_file() or path.stat().st_size!=entry['bytes']
                or _sha256_file(path)!=entry['sha256']):
            raise BackupError('Recovery file missing or checksum mismatch')
    names={e['name'] for e in manifest.files}
    if not required_files(backup_dir,manifest.workspace_id).issubset(names):
        raise BackupError('Inventory omits required workspace references')
    return manifest


@_io_errors
def restore_installation_backup(backup_dir: Path, destination: Path) -> Path:
    manifest=verify_installation_backup(backup_dir)
    _empty_destination(destination)
    destination.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix='.restore-',dir=destination.parent))
    try:
        for entry in manifest.files:
            source=safe_path(backup_dir,entry['name'])
            target=safe_path(stage,entry['name'])
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(source,target)
        (stage/'manifest.json').write_text(json.dumps(manifest.to_dict()))
        verify_installation_backup(stage)
        (stage/'manifest.json').unlink()
        _sync_tree(stage)
        if destination.exists():
            # Recheck immediately before publication. Never replace a populated root.
            _empty_destination(destination)
            destination.rmdir()
        stage.rename(destination)
        _sync_parent(destination)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return destination/f'{manifest.workspace_id}.sqlite3'
