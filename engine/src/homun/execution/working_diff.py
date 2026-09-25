"""Working-tree git diff collection (H12).

Collects diffs across working (unstaged + untracked), staged, or all states.
Untracked files are rendered via git diff --no-index against os.devnull.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from contextlib import suppress
from typing import Dict, List, Optional

_GIT_TIMEOUT = 15
_MAX_UNTRACKED_FILES = 50

_MODE_ARGS = {
    "working": ["diff"],
    "staged": ["diff", "--cached"],
    "all": ["diff", "HEAD"],
}
VALID_MODES = tuple(_MODE_ARGS)


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


def _harden_git_argv(args: list[str]) -> list[str]:
    out = list(args)
    diff_subcmds = {"diff", "show", "log", "blame"}
    for idx, token in enumerate(out):
        if token in diff_subcmds:
            out[idx + 1 : idx + 1] = ["--no-ext-diff", "--no-textconv"]
            break
    return out


def _run(args: List[str], cwd: str, timeout: int = _GIT_TIMEOUT) -> tuple[int, str]:
    proc = subprocess.run(
        ["git", "-c", "core.quotePath=false", *_harden_git_argv(args)],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
        stdin=subprocess.DEVNULL,
        env=_noninteractive_git_env(),
    )
    return proc.returncode, proc.stdout


def _untracked_files(cwd: str) -> List[str]:
    code, out = _run(["ls-files", "--others", "--exclude-standard"], cwd)
    return [line for line in out.splitlines() if line.strip()] if code == 0 else []


def _untracked_diff(cwd: str, files: List[str]) -> str:
    chunks: List[str] = []
    for rel in files[:_MAX_UNTRACKED_FILES]:
        with suppress(subprocess.TimeoutExpired, OSError):
            _, out = _run(["diff", "--no-index", "--", os.devnull, rel], cwd)
            if out.strip():
                chunks.append(out.rstrip("\n"))
    if len(files) > _MAX_UNTRACKED_FILES:
        chunks.append(f"... ({len(files) - _MAX_UNTRACKED_FILES} more untracked files not shown)")
    return "\n".join(chunks)


def collect_working_diff(
    cwd: str, mode: str = "working", paths: Optional[List[str]] = None
) -> Dict:
    """Collect git diff of the working directory."""
    if mode not in _MODE_ARGS:
        return {"success": False, "error": f"Unknown mode '{mode}'. Use: {', '.join(VALID_MODES)}"}
    if not shutil.which("git"):
        return {"success": False, "error": "git is not installed or not on PATH."}
    try:
        code, _ = _run(["rev-parse", "--is-inside-work-tree"], cwd, timeout=5)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return {"success": False, "error": f"git failed: {exc}"}
    if code != 0:
        return {"success": False, "error": "Not a git repository."}

    base_args = _MODE_ARGS[mode]
    pathspec = ["--", *paths] if paths else []
    try:
        _, stat_out = _run([*base_args, "--stat", *pathspec], cwd)
        _, diff_out = _run([*base_args, *pathspec], cwd, timeout=_GIT_TIMEOUT * 2)
        untracked = _untracked_files(cwd) if mode in ("working", "all") and not paths else []
        untracked_diff = _untracked_diff(cwd, untracked) if untracked else ""
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "git diff timed out."}
    except OSError as exc:
        return {"success": False, "error": f"git failed: {exc}"}

    stat, diff = stat_out.strip(), diff_out.strip()
    if untracked_diff:
        diff = f"{diff}\n{untracked_diff}".strip() if diff else untracked_diff
    result = {"success": True, "stat": stat, "diff": diff, "untracked": untracked}
    if not stat and not diff and not untracked:
        result["empty"] = True
    return result
