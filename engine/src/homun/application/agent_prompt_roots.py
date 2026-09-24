"""Authorize cwd/workspace roots for prompt assembly and @-references (H04)."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional, Tuple

from homun.application.path_security import validate_within_dir
from homun.domain.errors import ValidationError


def agent_workspaces_root(data_dir: Path) -> Path:
    root = (Path(data_dir) / "agent-workspaces").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_prompt_roots(
    data_dir: Path,
    workspace_id: str,
    *,
    cwd: Optional[str] = None,
    workspace_root: Optional[str] = None,
) -> Tuple[Path, Path]:
    """Return (cwd, workspace_root) confined under data_dir/agent-workspaces."""
    allowed = agent_workspaces_root(data_dir)
    default_root = (allowed / str(workspace_id or "default")).resolve()
    default_root.mkdir(parents=True, exist_ok=True)

    if workspace_root:
        root = Path(workspace_root).expanduser().resolve()
        err = validate_within_dir(root, allowed)
        if err:
            raise ValidationError(
                "workspace_root must stay inside the Homun agent-workspaces directory"
            )
    else:
        root = default_root

    if cwd:
        cwd_path = Path(cwd).expanduser().resolve()
        err = validate_within_dir(cwd_path, root)
        if err:
            raise ValidationError("cwd must stay inside the authorized workspace_root")
    else:
        cwd_path = root

    return cwd_path, root


def roots_from_propose_body(data_dir: Path, workspace_id: str, body: dict[str, Any]) -> Tuple[Path, Path]:
    return resolve_prompt_roots(
        data_dir,
        workspace_id,
        cwd=body.get("cwd"),
        workspace_root=body.get("workspace_root"),
    )
