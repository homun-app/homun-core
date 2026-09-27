"""Bounded, immutable workspace captures with explicit excluded paths."""
import hashlib
import os
import stat
import secrets
import fcntl
from pathlib import Path
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from typing import Literal
from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError
from homun.execution.files import WorkspaceFiles, FileChangedError
from homun.execution.identity import digest
from homun.execution.layout import confine_directory
from homun.execution.workspace import relative_cwd, working_directory

MAX_FILES = 1000
MAX_TOTAL = 50 * 1024 * 1024
MAX_FILE = 5 * 1024 * 1024
EXCLUDED = {'.git', '.tmp', '.ssh', '.aws', '.gnupg', '.homun-transfer.json'}


class ManifestEntry(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)
    path: str
    size: int = Field(ge=0)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    executable: bool

    @field_validator('path')
    @classmethod
    def safe_path(cls, value):
        if relative_cwd(value) == '.':
            raise ValidationError('A file path cannot name the workspace root')
        return value


class WorkspaceManifest(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)
    version: Literal[1] = 1
    workspace_id: str
    work_id: str
    run_id: str
    backend: Literal["local-private-v1", "docker-offline-v1"]
    cwd: str
    files: list[ManifestEntry] = Field(max_length=MAX_FILES)
    directories: list[str] = Field(max_length=MAX_FILES)
    exclusions: list[dict[str, str]]

    @field_validator('cwd')
    @classmethod
    def safe_cwd(cls, value):
        return relative_cwd(value)

    @field_validator('directories')
    @classmethod
    def safe_directories(cls, values):
        for value in values:
            if relative_cwd(value) == '.':
                raise ValidationError('Manifest directory must be below the root')
        return values

    @model_validator(mode='after')
    def bounded_unique_tree(self):
        paths = self.directories + [entry.path for entry in self.files]
        if len(paths) != len(set(paths)) or sum(entry.size for entry in self.files) > MAX_TOTAL:
            raise ValidationError('Workspace manifest is duplicate or oversized')
        if any(entry.size > MAX_FILE for entry in self.files):
            raise ValidationError('Workspace manifest file is oversized')
        return self


def blob_root(data_dir):
    return confine_directory(Path(data_dir).resolve()/'execution'/'session-blobs')


def _secret_path(path):
    name = path.rsplit('/', 1)[-1].lower()
    return name in EXCLUDED or name == '.env' or name.startswith('.env.') or name.endswith(('.pem', '.key', '.p12', '.pfx')) or name in {'credentials', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519'}


def _secret_bytes(data):
    from homun.application.secret_redaction import redact_secrets
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return False
    return 'PRIVATE KEY-----' in text or redact_secrets(text) != text


def _scan(root):
    files = WorkspaceFiles(root)
    inventory = []
    def visit(relative=''):
        with files._open(relative, directory=True) as fd:
            for entry in sorted(os.scandir(fd), key=lambda entry: entry.name):
                path = '/'.join(filter(None, [relative, entry.name]))
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
                    raise PermissionDeniedError('Workspace capture refuses links and special files')
                inventory.append((path, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino))
                if len(inventory) > MAX_FILES:
                    raise ValidationError('Workspace capture exceeds the entry limit')
                if stat.S_ISDIR(info.st_mode) and not _secret_path(path):
                    visit(path)
    visit()
    return inventory


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _publish_blob(directory, key, data):
    # Serialize immutable publication; rename avoids a crash leaving a second
    # hardlink that would invalidate descriptor-confined blob reads.
    lock = os.open(directory/'.publication.lock', os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW, 0o600)
    temporary = None
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = directory/key
        if path.exists() or path.is_symlink():
            if WorkspaceFiles(directory).read(key, max_bytes=MAX_FILE) != data:
                raise ConflictError('Immutable workspace blob changed')
        else:
            temporary = directory/('.capture-'+secrets.token_hex(16))
            fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o400)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.rename(temporary, path)
        sync_directory(directory)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)


def capture(data_dir, root, *, workspace_id, work_id, run_id, backend, cwd='.'):
    relative_cwd(cwd)
    working_directory(root, cwd)
    before = _scan(root)
    files, directories, exclusions = [], [], []
    total = 0
    blobs = blob_root(data_dir)
    reader = WorkspaceFiles(root)
    for path, mode, size, *_ in before:
        if _secret_path(path):
            exclusions.append({'path': path, 'reason': 'secret-or-runtime-path'})
        elif stat.S_ISDIR(mode):
            directories.append(path)
        else:
            data = reader.read(path, max_bytes=MAX_FILE)
            if _secret_bytes(data):
                exclusions.append({'path': path, 'reason': 'detected-secret-content'})
                continue
            total += len(data)
            if total > MAX_TOTAL:
                raise ValidationError('Workspace capture exceeds the byte limit')
            sha = hashlib.sha256(data).hexdigest()
            _publish_blob(blobs, sha, data)
            files.append(ManifestEntry(path=path, size=len(data), sha256=sha, executable=bool(mode & 0o111)))
    if before != _scan(root):
        raise FileChangedError('Workspace changed during capture')
    if cwd != '.' and cwd not in directories:
        raise ValidationError('Working directory was excluded from the capture')
    return WorkspaceManifest(workspace_id=workspace_id, work_id=work_id, run_id=run_id,
        backend=backend, cwd=cwd, files=files, directories=directories, exclusions=exclusions).model_dump()


def read_blob(data_dir, entry):
    data = WorkspaceFiles(blob_root(data_dir)).read(entry['sha256'], max_bytes=MAX_FILE)
    if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise ConflictError('Workspace capture bytes changed')
    return data
