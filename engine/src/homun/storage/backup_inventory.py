"""Validated installation inventory and workspace reference checks."""
from contextlib import closing
import json
import re
import sqlite3
from pathlib import Path, PurePosixPath

from homun.storage.backup_types import BackupError, BackupManifest
from homun.storage.backup_io import _sha256_file
from homun.storage.schema import UnsupportedSchemaVersion, validate_schema_version

FORMAT = 'homun-engine-backup'
VERSION = 2


def safe_path(root: Path, name: str) -> Path:
    posix = PurePosixPath(name)
    if (not name or '\\' in name or '\x00' in name or posix.is_absolute()
            or '..' in posix.parts or str(posix) != name):
        raise BackupError('Invalid inventory path')
    path = root
    for part in posix.parts:
        path = path/part
        if path.is_symlink():
            raise BackupError('Symbolic links are not permitted in a recovery bundle')
    if not path.resolve().is_relative_to(root.resolve()):
        raise BackupError('Inventory path escapes its directory')
    return path


def workspace_references(database: Path, workspace_id: str):
    try:
        with closing(sqlite3.connect(database.resolve().as_uri()+'?mode=ro', uri=True)) as conn:
            validate_schema_version(conn)
            if conn.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise BackupError('Workspace database failed integrity check')
            identity = conn.execute("SELECT value FROM meta WHERE key='workspace_id'").fetchone()
            if identity != (workspace_id,):
                raise BackupError('Workspace identity mismatch')
            materials = [json.loads(row[0]) for row in conn.execute("SELECT payload FROM entities WHERE kind='material'")]
            runs = [json.loads(row[0]) for row in conn.execute("SELECT payload FROM entities WHERE kind='run'")]
        return materials, runs
    except UnsupportedSchemaVersion as exc:
        raise BackupError(str(exc)) from exc
    except (sqlite3.Error, ValueError, TypeError) as exc:
        raise BackupError('Invalid workspace database') from exc


def required_files(root: Path, workspace_id: str) -> set[str]:
    materials, runs = workspace_references(safe_path(root, f'{workspace_id}.sqlite3'), workspace_id)
    names = {f'{workspace_id}.sqlite3'}
    if runs or (root/'dbos.sqlite').exists():
        database = safe_path(root, 'dbos.sqlite')
        try:
            with closing(sqlite3.connect(database.resolve().as_uri()+'?mode=ro', uri=True)) as conn:
                if conn.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise BackupError('Runtime database failed integrity check')
        except sqlite3.Error as exc:
            raise BackupError('Invalid or missing runtime database') from exc
        names.add('dbos.sqlite')
    for item in materials:
        relative = item.get('storage_relpath')
        if not relative:
            continue
        if not isinstance(relative,str) or not relative.startswith('materials/'):
            raise BackupError('Invalid original reference in workspace')
        path = safe_path(root, relative)
        if not path.is_file():
            raise BackupError('Original material is missing')
        if item.get('content_hash') and _sha256_file(path) != item['content_hash']:
            raise BackupError('Original material hash mismatch')
        names.add(relative)
    for run in runs:
        if run.get('effect_status') in {'applied','reconciled'}:
            name = 'receipts/'+str(run['command_id'])+'.json'
            if not safe_path(root,name).is_file():
                raise BackupError('Required runtime receipt is missing')
            names.add(name)
    return names


def read_inventory(root: Path) -> BackupManifest:
    try:
        raw = json.loads(safe_path(root,'manifest.json').read_text())
        manifest = BackupManifest.from_dict(raw)
    except (ValueError,TypeError,AttributeError,OSError) as exc:
        raise BackupError('Invalid installation manifest') from exc
    if manifest.format != FORMAT or manifest.version != VERSION:
        raise BackupError('Unsupported installation backup format')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', manifest.workspace_id):
        raise BackupError('Invalid workspace identity')
    seen = set()
    for entry in manifest.files:
        if not isinstance(entry,dict):
            raise BackupError('Invalid inventory entry')
        name = entry.get('name')
        if not isinstance(name,str):
            raise BackupError('Invalid inventory path')
        safe_path(root,name)
        if (name in seen or not (name in {f'{manifest.workspace_id}.sqlite3','dbos.sqlite'}
                or name.startswith('materials/') or (name.startswith('receipts/') and name.endswith('.json')))):
            raise BackupError('Duplicate or unsupported inventory entry')
        if not re.fullmatch(r'[a-f0-9]{64}', str(entry.get('sha256',''))):
            raise BackupError('Invalid inventory hash')
        if type(entry.get('bytes')) is not int or entry['bytes'] < 0:
            raise BackupError('Invalid inventory size')
        seen.add(name)
    if f'{manifest.workspace_id}.sqlite3' not in seen:
        raise BackupError('Workspace database is missing from inventory')
    return manifest
