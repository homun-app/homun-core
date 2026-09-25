"""Path security validation and traversal prevention (H40).

Confines path resolution within allowed root directories, detects directory traversal (..),
filters dangerous control characters, and blocks access to sensitive system/credential paths.
"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Optional, Set

logger = logging.getLogger(__name__)

# Control chars + Unicode line separators (NEL, LS, PS) that can corrupt protocols or forge logs
_UNSAFE_PATH_CHARS = re.compile(r"[\x00-\x1f\x7f\x85\u2028\u2029]")

_SENSITIVE_BASENAMES: Set[str] = frozenset({
    ".env",
    ".env.local",
    ".env.production",
    "id_rsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials",
    "shadow",
    "master.passwd",
    "wallet.dat",
    "keystore.json",
})

_SENSITIVE_EXACT_PATHS: Set[str] = frozenset({
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/master.passwd",
    "/etc/pam.d",
})


def has_traversal_component(path_str: str) -> bool:
    """Check for a literal '..' component in the path before full resolution."""
    return ".." in Path(path_str).parts


def has_unsafe_path_chars(path_str: str) -> bool:
    """Check if path string contains control characters or line separators."""
    return bool(_UNSAFE_PATH_CHARS.search(path_str))


def validate_within_dir(path: Path | str, root: Path | str) -> Optional[str]:
    """Validate that path resolves strictly inside root directory (symlinks and '..' followed).

    Returns None on success, or an error description string if it escapes.
    """
    p = Path(path)
    r = Path(root)
    try:
        p.resolve().relative_to(r.resolve())
    except (ValueError, OSError) as exc:
        return f"Path escapes allowed directory: {exc}"
    return None


def is_sensitive_system_path(path: Path | str) -> bool:
    """Check if the path targets well-known sensitive system credentials or files."""
    p = Path(path)
    # Check exact system paths
    resolved_str = str(p.resolve())
    if resolved_str in _SENSITIVE_EXACT_PATHS:
        return True

    # Check sensitive basenames
    if p.name.lower() in _SENSITIVE_BASENAMES:
        return True

    # Check user credential directories (.ssh, .aws, .gnupg)
    parts = set(p.parts)
    if any(part in {".ssh", ".aws", ".gnupg"} for part in parts):
        return True

    return False


def check_path_safety(
    path: Path | str,
    root: Optional[Path | str] = None,
    *,
    allow_sensitive: bool = False,
) -> tuple[bool, Optional[str]]:
    """Comprehensive safety check for filesystem paths.

    Returns (is_safe, error_reason).
    """
    path_str = str(path).strip()
    if not path_str:
        return False, "Path cannot be empty."

    if has_unsafe_path_chars(path_str):
        return False, "Path contains unsafe control characters or line separators."

    if has_traversal_component(path_str) and root is None:
        return False, "Path contains unconfined traversal components ('..')."

    if root is not None:
        err = validate_within_dir(path_str, root)
        if err:
            return False, err

    if not allow_sensitive and is_sensitive_system_path(path_str):
        return False, f"Access to sensitive path '{Path(path_str).name}' is denied by policy."

    return True, None
