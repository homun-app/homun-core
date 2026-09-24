"""Git worktree isolation for subagents (H12).

Derived from Hermes tools/subagent_worktree.py (MIT).
Creates isolated worktree branches under <repo>/.worktrees/subagent-<id>.
Prunes worktrees safely upon verifying zero uncommitted/unmerged changes.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)
_GIT_TIMEOUT = 30


def _noninteractive_git_env() -> dict:
    env = os.environ.copy()
    env.update(
        GIT_TERMINAL_PROMPT="0",
        GIT_PAGER="cat",
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_OPTIONAL_LOCKS="0",
    )
    return env


def _run_git(args: list[str], cwd: str, timeout: int = _GIT_TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        stdin=subprocess.DEVNULL,
        env=_noninteractive_git_env(),
    )


def resolve_repo_root(path: Optional[str]) -> Optional[str]:
    """Return the git toplevel for path, or None when not in a work tree."""
    candidate = os.path.abspath(os.path.expanduser(str(path))) if path else ""
    if not candidate or not os.path.isdir(candidate):
        return None
    try:
        result = _run_git(["rev-parse", "--show-toplevel"], cwd=candidate)
    except Exception as exc:
        logger.debug("subagent worktree: rev-parse failed: %s", exc)
        return None
    return (result.stdout.strip() or None) if result.returncode == 0 else None


def _ensure_gitignore_entry(repo_root: str) -> None:
    gitignore = Path(repo_root) / ".gitignore"
    try:
        existing = gitignore.read_text(encoding="utf-8", errors="replace") if gitignore.exists() else ""
        if ".worktrees/" not in existing.splitlines():
            with open(gitignore, "a", encoding="utf-8") as f:
                sep = "\n" if existing and not existing.endswith("\n") else ""
                f.write(f"{sep}.worktrees/\n")
    except Exception as exc:
        logger.debug("subagent worktree: could not update .gitignore: %s", exc)


def create_subagent_worktree(
    parent_cwd: Optional[str], subagent_id: Optional[str] = None
) -> Optional[Dict[str, str]]:
    """Create an isolated worktree for a child subagent."""
    repo_root = resolve_repo_root(parent_cwd)
    if not repo_root:
        return None
    wt_name = f"subagent-{(subagent_id or uuid.uuid4().hex[:8]).replace('/', '-')}"
    branch = f"homun-subagent/{wt_name}"
    wt_path = Path(repo_root) / ".worktrees" / wt_name
    try:
        wt_path.parent.mkdir(parents=True, exist_ok=True)
        _ensure_gitignore_entry(repo_root)
        base = _run_git(["rev-parse", "HEAD"], cwd=repo_root)
        base_commit = base.stdout.strip() if base.returncode == 0 else ""
        result = _run_git(["worktree", "add", str(wt_path), "-b", branch, "HEAD"], cwd=repo_root)
    except Exception as exc:
        logger.warning("subagent worktree: creation failed: %s", exc)
        return None
    if result.returncode != 0:
        logger.warning("subagent worktree: git worktree add failed: %s", result.stderr.strip())
        return None
    return {
        "path": str(wt_path),
        "branch": branch,
        "repo_root": repo_root,
        "base_commit": base_commit,
    }


def cleanup_subagent_worktree(worktree_info: Dict[str, Any], force: bool = False) -> Dict[str, Any]:
    """Clean up subagent worktree if clean and uncommitted changes are absent."""
    wt_path_str = worktree_info.get("path")
    repo_root = worktree_info.get("repo_root")
    branch = worktree_info.get("branch")
    if not wt_path_str or not repo_root:
        return {"cleaned": False, "reason": "invalid_worktree_info"}

    wt_path = Path(wt_path_str)
    if not wt_path.exists():
        return {"cleaned": True, "path": wt_path_str}

    # Check status for uncommitted changes
    status = _run_git(["status", "--porcelain"], cwd=wt_path_str)
    has_uncommitted = bool(status.stdout.strip())
    if has_uncommitted and not force:
        return {
            "cleaned": False,
            "reason": "uncommitted_changes",
            "path": wt_path_str,
            "status": status.stdout.strip(),
        }

    # Remove worktree
    cmd = ["worktree", "remove", str(wt_path)]
    if force:
        cmd.append("--force")
    rm_res = _run_git(cmd, cwd=repo_root)
    if rm_res.returncode != 0:
        # Fallback to directory deletion if worktree remove encounters issue
        if force:
            shutil.rmtree(wt_path_str, ignore_errors=True)
            _run_git(["worktree", "prune"], cwd=repo_root)
        else:
            return {"cleaned": False, "reason": rm_res.stderr.strip(), "path": wt_path_str}

    # Delete branch if specified
    if branch:
        del_flag = "-D" if force else "-d"
        _run_git(["branch", del_flag, branch], cwd=repo_root)

    return {"cleaned": True, "path": wt_path_str}
