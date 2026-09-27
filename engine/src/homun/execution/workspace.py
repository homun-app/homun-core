"""One backend-owned workspace identity and confined relative working directory."""
from pathlib import Path, PurePosixPath
from homun.domain.errors import PermissionDeniedError, ValidationError
from homun.execution.layout import confine_directory


def relative_cwd(value: str) -> str:
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        raise ValidationError('Working directory must be a relative POSIX path')
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or str(path) != value:
        raise ValidationError('Working directory must be a normalized relative path')
    return value


def owned_root(execution_root: Path, workspace_id: str, run_id: str, *, create=True) -> Path:
    from homun.execution.identity import digest
    path = Path(execution_root).absolute() / 'workspaces' / digest([workspace_id, run_id])
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise PermissionDeniedError('Execution paths must not contain symlinks')
    return confine_directory(path) if create else path


def working_directory(root: Path, cwd: str) -> Path:
    path = root / relative_cwd(cwd)
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise PermissionDeniedError('Working directory must not contain symlinks')
    if not path.is_dir():
        raise ValidationError('Approved working directory does not exist')
    return path
