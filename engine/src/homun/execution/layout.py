"""Shared checks for engine-owned execution directories."""
from pathlib import Path

from homun.domain.errors import PermissionDeniedError


def confine_directory(path: Path) -> Path:
    """Create a private directory. Reject a symlink at the path or any parent."""
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise PermissionDeniedError("Execution paths must not contain symlinks")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.is_dir():
        raise PermissionDeniedError("Execution path is not a directory")
    return path
