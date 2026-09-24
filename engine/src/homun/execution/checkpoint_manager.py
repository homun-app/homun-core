"""Filesystem checkpoint snapshots, selective rollback, and agent-write tracking (H12).

Derived from Hermes tools/checkpoint_manager.py (MIT).
Transparent shadow git store snapshots working directories before mutations.
Tracks agent writes in a ledger so selective rollback preserves later user edits.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

DEFAULT_EXCLUDES = [
    "node_modules/", "dist/", "build/", "target/", "out/", ".next/",
    "__pycache__/", "*.pyc", "*.pyo", ".cache/", ".pytest_cache/",
    ".venv/", "venv/", "env/",
    ".git/", ".worktrees/",
    "*.so", "*.dylib", "*.dll", "*.o", "*.a",
    "*.zip", "*.tar", "*.tar.gz", "*.tgz",
    ".env", ".DS_Store", "*.log",
]

_GIT_TIMEOUT = 30
_SHORTSTAT_FIELDS = (
    ("files_changed", r"(\d+) file"),
    ("insertions", r"(\d+) insertion"),
    ("deletions", r"(\d+) deletion"),
)


def _normalize_path(path_val: str | Path) -> Path:
    return Path(path_val).expanduser().resolve()


def _project_hash(working_dir: str | Path) -> str:
    return hashlib.sha256(str(_normalize_path(working_dir)).encode()).hexdigest()[:16]


def _hash_file(path: Path) -> Optional[str]:
    try:
        with open(path, "rb") as fh:
            return hashlib.file_digest(fh, "sha256").hexdigest()
    except OSError:
        return None


def _git_env(store: Path, working_dir: Path, index_file: Optional[Path] = None) -> dict:
    env = os.environ.copy()
    env.update(
        GIT_TERMINAL_PROMPT="0",
        GIT_PAGER="cat",
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_DIR=str(store),
        GIT_WORK_TREE=str(working_dir),
    )
    if index_file:
        env["GIT_INDEX_FILE"] = str(index_file)
    for k in ("GIT_NAMESPACE", "GIT_ALTERNATE_OBJECT_DIRECTORIES"):
        env.pop(k, None)
    return env


def _run_git(
    args: list[str],
    store: Path,
    working_dir: Path,
    index_file: Optional[Path] = None,
    timeout: int = _GIT_TIMEOUT,
    allowed_returncodes: Optional[Set[int]] = None,
) -> tuple[bool, str, str]:
    cmd = ["git"] + args
    try:
        res = subprocess.run(
            cmd,
            cwd=str(working_dir),
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
            stdin=subprocess.DEVNULL,
            env=_git_env(store, working_dir, index_file=index_file),
        )
    except Exception as exc:
        return False, "", str(exc)

    ok = res.returncode == 0
    stdout = res.stdout.strip()
    stderr = res.stderr.strip()
    if not ok and res.returncode not in (allowed_returncodes or set()):
        logger.debug("Git command %s returned %d: %s", " ".join(cmd), res.returncode, stderr)
    return ok, stdout, stderr


class CheckpointManager:
    """Manages workspace snapshots and selective rollbacks via a shadow git repository."""

    def __init__(
        self,
        enabled: bool = True,
        base: Optional[Path] = None,
        max_snapshots: int = 50,
    ):
        self.enabled = enabled
        self.base = base or Path.home() / ".homun" / "checkpoints"
        self.store = self.base / "store"
        self.max_snapshots = max(1, max_snapshots)
        self._checkpointed_dirs: Set[str] = set()

    def new_turn(self) -> None:
        """Clear per-turn deduplication set."""
        self._checkpointed_dirs.clear()

    def _init_store(self, working_dir: Path) -> Optional[str]:
        if (self.store / "HEAD").exists():
            return None
        self.store.mkdir(parents=True, exist_ok=True)
        (self.store / "indexes").mkdir(parents=True, exist_ok=True)
        (self.store / "ledgers").mkdir(parents=True, exist_ok=True)
        (self.store / "projects").mkdir(parents=True, exist_ok=True)

        res = subprocess.run(
            ["git", "init", "--bare", str(self.store)],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT,
        )
        if res.returncode != 0:
            return f"Store init failed: {res.stderr}"

        # Config bare repo
        for k, v in [
            ("user.email", "homun@local"),
            ("user.name", "Homun Checkpoint"),
            ("commit.gpgsign", "false"),
        ]:
            _run_git(["config", k, v], self.store, working_dir)

        (self.store / "info").mkdir(exist_ok=True)
        (self.store / "info" / "exclude").write_text(
            "\n".join(DEFAULT_EXCLUDES) + "\n", encoding="utf-8"
        )
        return None

    def record_agent_write(self, working_dir: str | Path, file_path: str | Path) -> None:
        """Record file written by agent with sha256 to distinguish from later user edits."""
        if not self.enabled:
            return
        try:
            wd = _normalize_path(working_dir)
            fp = _normalize_path(file_path)
            digest = _hash_file(fp)
            if not digest:
                return
            dir_hash = _project_hash(wd)
            ledger_file = self.store / "ledgers" / f"{dir_hash}.json"
            ledger = {}
            if ledger_file.exists():
                with open(ledger_file, "r", encoding="utf-8") as fh:
                    ledger = json.load(fh)
            ledger[str(fp)] = {"sha256": digest, "ts": time.time()}
            ledger_file.parent.mkdir(parents=True, exist_ok=True)
            with open(ledger_file, "w", encoding="utf-8") as fh:
                json.dump(ledger, fh)
        except Exception as exc:
            logger.debug("record_agent_write failed: %s", exc)

    def _load_ledger(self, dir_hash: str) -> dict:
        ledger_file = self.store / "ledgers" / f"{dir_hash}.json"
        if not ledger_file.exists():
            return {}
        try:
            with open(ledger_file, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            return {}

    def ensure_checkpoint(self, working_dir: str | Path, reason: str = "auto") -> bool:
        """Create a snapshot of working_dir if not already taken this turn."""
        if not self.enabled:
            return False
        wd = _normalize_path(working_dir)
        if not wd.is_dir():
            return False
        wd_str = str(wd)
        if wd_str in self._checkpointed_dirs:
            return False
        self._checkpointed_dirs.add(wd_str)

        err = self._init_store(wd)
        if err:
            logger.warning("Checkpoint store init failed: %s", err)
            return False

        dir_hash = _project_hash(wd)
        index_file = self.store / "indexes" / dir_hash
        ref = f"refs/homun/{dir_hash}"

        # 1. Update index with working directory
        ok, _, err_msg = _run_git(["add", "-A"], self.store, wd, index_file=index_file)
        if not ok:
            logger.warning("Checkpoint git add failed: %s", err_msg)
            return False

        # 2. Write tree
        ok, tree_sha, _ = _run_git(["write-tree"], self.store, wd, index_file=index_file)
        if not ok or not tree_sha:
            return False

        # 3. Get parent commit if ref exists
        ok, parent_sha, _ = _run_git(
            ["rev-parse", "--verify", f"{ref}^{{commit}}"],
            self.store,
            wd,
            allowed_returncodes={1, 128},
        )
        parent_arg = ["-p", parent_sha] if ok and parent_sha else []

        # 4. Commit tree
        ok, commit_sha, _ = _run_git(
            ["commit-tree", tree_sha, *parent_arg, "-m", reason],
            self.store,
            wd,
        )
        if not ok or not commit_sha:
            return False

        # 5. Update ref
        ok, _, _ = _run_git(["update-ref", ref, commit_sha], self.store, wd)
        return ok

    def list_checkpoints(self, working_dir: str | Path) -> List[Dict[str, Any]]:
        """List snapshots for a directory from most recent to oldest."""
        wd = _normalize_path(working_dir)
        dir_hash = _project_hash(wd)
        ref = f"refs/homun/{dir_hash}"
        ok, log_out, _ = _run_git(
            ["log", ref, f"--format=%H|%h|%aI|%s", f"-n{self.max_snapshots}"],
            self.store,
            wd,
            allowed_returncodes={1, 128},
        )
        if not ok or not log_out:
            return []

        results = []
        for line in log_out.splitlines():
            parts = line.split("|", 3)
            if len(parts) != 4:
                continue
            entry = {
                "hash": parts[0],
                "short_hash": parts[1],
                "timestamp": parts[2],
                "reason": parts[3],
                "files_changed": 0,
                "insertions": 0,
                "deletions": 0,
            }
            # stat against parent commit
            ok_stat, stat_out, _ = _run_git(
                ["diff", "--shortstat", f"{parts[0]}~1", parts[0]],
                self.store,
                wd,
                allowed_returncodes={1, 128},
            )
            if ok_stat and stat_out:
                for key, pattern in _SHORTSTAT_FIELDS:
                    m = re.search(pattern, stat_out)
                    if m:
                        entry[key] = int(m.group(1))
            results.append(entry)
        return results

    def diff(self, working_dir: str | Path, commit_hash: str) -> Dict[str, Any]:
        """Show diff between a checkpoint and current working tree."""
        wd = _normalize_path(working_dir)
        dir_hash = _project_hash(wd)
        index_file = self.store / "indexes" / dir_hash

        # Update index to match current working tree
        _run_git(["add", "-A"], self.store, wd, index_file=index_file)

        ok_stat, stat_out, _ = _run_git(
            ["diff", "--stat", commit_hash, "--cached"],
            self.store,
            wd,
            index_file=index_file,
        )
        ok_diff, diff_out, _ = _run_git(
            ["diff", commit_hash, "--cached", "--no-color"],
            self.store,
            wd,
            index_file=index_file,
        )
        return {
            "success": ok_stat or ok_diff,
            "stat": stat_out if ok_stat else "",
            "diff": diff_out if ok_diff else "",
        }

    def safe_restore_plan(self, working_dir: str | Path, commit_hash: str) -> Dict[str, Any]:
        """Classify files into restore vs skipped (preserving subsequent user edits)."""
        wd = _normalize_path(working_dir)
        dir_hash = _project_hash(wd)
        index_file = self.store / "indexes" / dir_hash

        _run_git(["add", "-A"], self.store, wd, index_file=index_file)
        ok, names_out, err = _run_git(
            ["diff", "--name-only", commit_hash, "--cached"],
            self.store,
            wd,
            index_file=index_file,
        )
        if not ok:
            return {"success": False, "error": f"Could not compute changed files: {err}"}

        ledger = self._load_ledger(dir_hash)
        if not ledger:
            return {"success": True, "restore": [], "skipped": [], "ledger_empty": True}

        restore: List[str] = []
        skipped: List[str] = []
        for rel in filter(None, names_out.splitlines()):
            abs_path = wd / rel
            recorded = ledger.get(str(abs_path), {}).get("sha256")
            current_hash = _hash_file(abs_path)
            # If current file matches agent's recorded write (or was deleted by agent), it's safe to restore
            if recorded is not None and current_hash == recorded:
                restore.append(rel)
            elif not abs_path.exists() and recorded is not None:
                restore.append(rel)
            else:
                # User edited this file after the agent write -> preserve user edits!
                skipped.append(rel)

        return {"success": True, "restore": restore, "skipped": skipped, "ledger_empty": False}

    def restore(
        self,
        working_dir: str | Path,
        commit_hash: str,
        file_path: Optional[str | Path] = None,
        safe: bool = False,
    ) -> Dict[str, Any]:
        """Restore files to a checkpoint. safe=True preserves user hand-edits."""
        wd = _normalize_path(working_dir)
        dir_hash = _project_hash(wd)
        index_file = self.store / "indexes" / dir_hash

        # Pre-rollback snapshot so rollback can be undone
        self.ensure_checkpoint(wd, f"pre-rollback snapshot restoring {commit_hash[:8]}")

        skipped_user_edits: List[str] = []
        restore_targets: List[str] = []

        if file_path:
            fp = Path(file_path)
            abs_file = fp.resolve() if fp.is_absolute() else (wd / fp).resolve()
            rel = os.path.relpath(str(abs_file), str(wd))
            restore_targets = [rel]
        elif safe:
            plan = self.safe_restore_plan(wd, commit_hash)
            if not plan.get("success"):
                return {"success": False, "error": plan.get("error")}
            if not plan.get("ledger_empty"):
                restore_targets = plan.get("restore", [])
                skipped_user_edits = plan.get("skipped", [])
                if not restore_targets:
                    return {
                        "success": True,
                        "commit": commit_hash,
                        "restored_files": [],
                        "skipped_user_edits": skipped_user_edits,
                        "message": "Nothing to restore: all modified files were user-edited.",
                    }
            else:
                restore_targets = ["."]
        else:
            restore_targets = ["."]

        ok, _, err = _run_git(
            ["checkout", commit_hash, "--", *restore_targets],
            self.store,
            wd,
            index_file=index_file,
        )
        if not ok:
            return {"success": False, "error": f"Restore failed: {err}"}

        return {
            "success": True,
            "commit": commit_hash,
            "restored_files": restore_targets if restore_targets != ["."] else ["all"],
            "skipped_user_edits": skipped_user_edits,
        }
