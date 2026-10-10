"""Progressive subdirectory hint discovery during agent tool execution (C4 / H04).

As the agent navigates into subdirectories via file and terminal tool calls,
discovers project context files (AGENTS.override.md, AGENTS.md, CLAUDE.md, etc.)
and attaches them to tool observations as context without rewriting the approved
system prompt, preserving prompt caching (H05).
"""
from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
import shlex
from typing import Any, Dict, List, Optional, Set, Tuple

from homun.application.path_security import is_sensitive_system_path, validate_within_dir
from homun.application.prompt_assembler import (
    EXCLUDED_SUBDIR_NAMES,
    MAX_CONTEXT_FILE_CHARS,
    SUBDIR_INSTRUCTION_FILENAMES,
    scan_for_threats,
)

logger = logging.getLogger(__name__)

HINT_FILENAMES: List[str] = list(SUBDIR_INSTRUCTION_FILENAMES)
MAX_HINT_CHARS: int = MAX_CONTEXT_FILE_CHARS  # 32,000 characters ceiling
MAX_ANCESTOR_WALK: int = 5
PATH_ARG_KEYS: Set[str] = {"path", "file_path", "workdir"}
COMMAND_TOOLS: Set[str] = {
    "terminal",
    "terminal_start",
    "terminal_command",
    "terminal_exec",
    "terminal_execute",
    "execute_code",
}
NAV_COMMANDS: frozenset[str] = frozenset({"cd", "pushd"})
SHELL_OPERATORS: frozenset[str] = frozenset({"&&", "||", "|", ";", "&", ";;", "|&", "(", ")"})
EXTRA_EXCLUDED_DIRS: Set[str] = {"backups", "backup", "vendor", ".cache", ".tox"}
EXCLUDED_DIR_NAMES: Set[str] = set(EXCLUDED_SUBDIR_NAMES) | EXTRA_EXCLUDED_DIRS


def _digest(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _is_denied_target(path: Path) -> bool:
    if is_sensitive_system_path(path):
        return True
    name = path.name.lower()
    if name.startswith(".env") or name in {".env", "id_rsa", "id_ecdsa", "id_ed25519", "credentials"}:
        return True
    return False


def _resolved_hint_target(hint_path: Path, working_dir: Path) -> Optional[Path]:
    """Resolve symlink target and verify strict containment and safety."""
    try:
        resolved = hint_path.resolve()
    except (OSError, RuntimeError):
        return None
    try:
        if not resolved.is_relative_to(working_dir):
            return None
    except (ValueError, OSError, RuntimeError):
        return None
    if validate_within_dir(resolved, working_dir) is not None:
        return None
    if _is_denied_target(resolved):
        return None
    return resolved


def _first_hint_file(directory: Path, working_dir: Path) -> Optional[Tuple[Path, str]]:
    """Return (hint_file_path, content) for the winning hint file in directory."""
    for filename in HINT_FILENAMES:
        candidate = directory / filename
        try:
            if not candidate.is_file():
                continue
            target = _resolved_hint_target(candidate, working_dir)
            if target is None:
                continue
            content = target.read_text(encoding="utf-8", errors="replace").strip()
            if not content:
                continue
            return candidate, content
        except (OSError, UnicodeDecodeError):
            continue
    return None


def _nav_targets(cmd: str) -> List[str]:
    """Extract directory operands of cd/pushd at shell segment boundaries."""
    lexer = shlex.shlex(cmd, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        return []
    targets: List[str] = []
    segment_start = True
    for idx, token in enumerate(tokens):
        if token in SHELL_OPERATORS:
            segment_start = True
            continue
        if segment_start and token in NAV_COMMANDS:
            operand = next((t for t in tokens[idx + 1 :] if t in SHELL_OPERATORS or not t.startswith("-")), None)
            if operand and operand not in SHELL_OPERATORS:
                targets.append(operand)
        segment_start = False
    return targets


def _extract_paths_from_command(cmd: str, candidates: Set[str]) -> None:
    """Extract path candidates from a shell command string."""
    for target in _nav_targets(cmd):
        candidates.add(target)
    try:
        tokens = shlex.split(cmd)
    except ValueError:
        tokens = cmd.split()
    for token in tokens:
        if token.startswith(("-", "http://", "https://", "git@")) or ("/" not in token and "." not in token):
            continue
        candidates.add(token)


def _truncate_content(content: str, filename: str, rel_path: str, max_chars: int = MAX_HINT_CHARS) -> str:
    """Truncate large instructions preserving head and tail with marker."""
    if len(content) <= max_chars:
        return content
    head_len = int(max_chars * 0.4)
    tail_len = int(max_chars * 0.6)
    head = content[:head_len]
    tail = content[-tail_len:]
    marker = (
        f"\n\n[... truncated {filename} ({len(content)} chars > {max_chars}); read full file at {rel_path} ...]\n\n"
    )
    logger.warning("Subdirectory hint %s truncated (%d chars > %d)", rel_path, len(content), max_chars)
    return head + marker + tail


class SubdirectoryHintTracker:
    """Track visited directories per run and load nested hints on first navigation."""

    def __init__(
        self,
        working_dir: Path | str,
        *,
        enabled: bool = True,
        state: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.enabled = enabled
        self.working_dir = Path(working_dir).resolve()
        if state:
            self._loaded_dirs: Set[Path] = {Path(p) for p in state.get("loaded_dirs", [])}
            self._loaded_digests: Set[str] = set(state.get("loaded_digests", []))
        else:
            self._loaded_dirs = {self.working_dir}
            self._loaded_digests = set()
            found = _first_hint_file(self.working_dir, self.working_dir)
            if found and found[1]:
                self._loaded_digests.add(_digest(found[1]))

    def dump_state(self) -> Dict[str, Any]:
        return {
            "loaded_dirs": [str(d) for d in self._loaded_dirs],
            "loaded_digests": sorted(self._loaded_digests),
        }

    def check_tool_call(self, tool_name: str, tool_args: Dict[str, Any]) -> Optional[str]:
        if not self.enabled:
            return None
        dirs = self._extract_directories(tool_name, tool_args)
        hints: List[str] = []
        for d in dirs:
            hint = self._load_hints_for_directory(d)
            if hint:
                hints.append(hint)
        return ("\n\n" + "\n\n".join(hints)) if hints else None

    def _extract_directories(self, tool_name: str, args: Dict[str, Any]) -> List[Path]:
        raw_candidates: Set[str] = set()
        for key in PATH_ARG_KEYS:
            val = args.get(key)
            if isinstance(val, str) and val.strip():
                raw_candidates.add(val.strip())
        if tool_name in COMMAND_TOOLS:
            cmd = args.get("command") or args.get("cmd") or ""
            if isinstance(cmd, str) and cmd.strip():
                _extract_paths_from_command(cmd, raw_candidates)

        resolved_dirs: Set[Path] = set()
        for raw in raw_candidates:
            self._add_path_candidate(raw, resolved_dirs)
        return sorted(resolved_dirs)

    def _add_path_candidate(self, raw_path: str, candidates: Set[Path]) -> None:
        try:
            p = Path(raw_path).expanduser()
            if not p.is_absolute():
                p = self.working_dir / p
            p = p.resolve()
            if p.suffix or (p.exists() and p.is_file()):
                p = p.parent
            for _ in range(MAX_ANCESTOR_WALK):
                if p in self._loaded_dirs:
                    break
                if self._is_valid_subdir(p):
                    candidates.add(p)
                if p.parent == p:
                    break
                p = p.parent
        except (OSError, ValueError, RuntimeError):
            pass

    def _is_valid_subdir(self, path: Path) -> bool:
        try:
            if not path.is_dir():
                return False
            if path in self._loaded_dirs:
                return False
            if not path.is_relative_to(self.working_dir):
                return False
            rel_parts = path.relative_to(self.working_dir).parts
            if any(part in EXCLUDED_DIR_NAMES for part in rel_parts):
                return False
            return True
        except (OSError, ValueError, RuntimeError):
            return False

    def _load_hints_for_directory(self, directory: Path) -> Optional[str]:
        self._loaded_dirs.add(directory)
        try:
            if not directory.is_relative_to(self.working_dir):
                return None
        except (ValueError, OSError):
            return None

        found = _first_hint_file(directory, self.working_dir)
        if not found:
            return None
        hint_path, content = found
        digest_val = _digest(content)
        if digest_val in self._loaded_digests:
            return None
        self._loaded_digests.add(digest_val)

        if scan_for_threats(content):
            logger.warning("Threat/override detected in context file %s, skipping", hint_path)
            return None

        rel_path = self._display_path(hint_path)
        content = _truncate_content(content, hint_path.name, rel_path)
        logger.debug("Loaded subdirectory hints from %s: %s", directory, rel_path)
        return f"[Subdirectory context discovered: {rel_path}]\n{content}"

    def _display_path(self, hint_path: Path) -> str:
        try:
            return str(hint_path.relative_to(self.working_dir))
        except (ValueError, RuntimeError):
            return str(hint_path)


def track_and_attach_hints(
    run: Dict[str, Any],
    tool_name: str,
    tool_args: Dict[str, Any],
    observation: Any,
    working_dir: Optional[Path | str] = None,
) -> Tuple[Any, Optional[str]]:
    """Inspect tool invocation, track accessed subdirectories, and attach new hints."""
    if run.get("skip_context_files"):
        return observation, None

    wd = working_dir or run.get("_workspace_root") or run.get("_cwd")
    if not wd:
        return observation, None

    state = run.get("_subdirectory_hints")
    tracker = SubdirectoryHintTracker(wd, enabled=True, state=state)
    hints = tracker.check_tool_call(tool_name, tool_args or {})
    run["_subdirectory_hints"] = tracker.dump_state()

    if not hints:
        return observation, None

    cleaned_hints = hints.strip()
    if isinstance(observation, dict):
        observation["subdirectory_context"] = cleaned_hints
    elif isinstance(observation, str):
        observation = observation + "\n\n" + cleaned_hints

    return observation, cleaned_hints
