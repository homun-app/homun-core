"""Encryption key management: derive, persist and retrieve the workspace key.

On macOS the key lives in the user's Keychain (via the `security` CLI);
everywhere else, or when the Keychain is unavailable, a key file inside the
data directory is used. The key is a random 256-bit value, never logged and
never written to the database it protects.
"""
from __future__ import annotations

import hashlib
import os
import secrets
import subprocess
from pathlib import Path

from homun.domain.errors import DomainError


class EncryptionError(DomainError):
    code = "workspace_encryption_error"


def configured_workspace_key(key: bytes | None = None) -> bytes | None:
    """Explicit opt-in only. Never create/replace keys during engine startup."""
    if key is None and (filename := os.environ.get("HOMUN_WORKSPACE_KEY_FILE")):
        try:
            key = bytes.fromhex(Path(filename).expanduser().read_text().strip())
        except (OSError, ValueError, UnicodeError) as exc:
            raise EncryptionError("Cannot read the configured workspace key file") from exc
    if key is not None and (not isinstance(key, bytes) or len(key) != 32):
        raise EncryptionError("Workspace key must contain exactly 32 bytes")
    return key


KEY_SIZE = 32  # bytes; SQLCipher 4 default key length
KEYCHAIN_SERVICE = 'dev.homun.engine.workspace-key'


def _keychain_available() -> bool:
    if os.uname().sysname != 'Darwin':
        return False
    result = subprocess.run(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE],
                           capture_output=True, timeout=5)
    return result.returncode == 0 or result.returncode == 44  # 44 = not found but Keychain works


def _keychain_read() -> bytes | None:
    try:
        result = subprocess.run(
            ['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
            capture_output=True, timeout=5)
        if result.returncode != 0:
            return None
        return bytes.fromhex(result.stdout.decode().strip())
    except (subprocess.TimeoutExpired, ValueError):
        return None


def _keychain_write(key: bytes) -> bool:
    try:
        result = subprocess.run(
            ['security', 'add-generic-password', '-U',
             '-s', KEYCHAIN_SERVICE,
             '-a', os.environ.get('USER', 'homun'),
             '-w', key.hex()],
            capture_output=True, timeout=5)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        return False


def _key_file_path(data_dir: Path) -> Path:
    return data_dir / '.workspace-key'


def _file_read(data_dir: Path) -> bytes | None:
    path = _key_file_path(data_dir)
    if not path.is_file():
        return None
    data = path.read_bytes().strip()
    if len(data) != KEY_SIZE * 2:  # hex-encoded
        return None
    try:
        return bytes.fromhex(data.decode())
    except (ValueError, UnicodeDecodeError):
        return None


def _file_write(data_dir: Path, key: bytes) -> None:
    path = _key_file_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(key.hex().encode() + b'\n')
    path.chmod(0o600)


def load_or_create_key(data_dir: Path) -> bytes:
    """Retrieve the existing workspace key, or generate and persist a new one.

    Order: Keychain (macOS) → key file → generate. A newly generated key is
    written to the Keychain when available, falling back to a file with
    restrictive permissions. Losing the key means losing the data: there is
    no escrow or recovery by design.
    """
    if _keychain_available():
        existing = _keychain_read()
        if existing and len(existing) == KEY_SIZE:
            return existing
    existing = _file_read(data_dir)
    if existing and len(existing) == KEY_SIZE:
        return existing
    key = secrets.token_bytes(KEY_SIZE)
    if _keychain_available() and _keychain_write(key):
        return key
    _file_write(data_dir, key)
    return key


def derive_database_key(master_key: bytes, purpose: str) -> bytes:
    """Derive a purpose-specific key from the master (PBKDF2-HMAC-SHA256 domain separation, no logging)."""
    return hashlib.pbkdf2_hmac('sha256', master_key, purpose.encode(), iterations=1, dklen=KEY_SIZE)
