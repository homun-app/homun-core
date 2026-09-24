"""Prompt and personality assembly with nested instructions and threat scanning (H04).

Derived from Hermes agent/prompt_builder.py, agent/system_prompt.py,
agent/context_file_sources.py, and agent/subdirectory_hints.py
at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun builds layered prompts following documented precedence:
  1. Core System Guidance (identity, grounding, tool rules)
  2. Persona / Role Instructions
  3. User Preferences (SOUL.md)
  4. Workspace Root Instructions (AGENTS.override.md > AGENTS.md > .homun/AGENTS.md > CLAUDE.md > .cursorrules)
  5. Subdirectory Instructions (ancestor walk from workspace root down to current working directory)
  6. Assigned Task Instructions & Materials
  7. Active Tools Constraints

Also provides:
  - Per-file context manifest with size, token estimate, and load status (loaded/truncated/shadowed/blocked/empty/unreadable).
  - Security threat / prompt-injection scan blocking untrusted project files and flagging user files.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from homun.models.native_turn import NativeMessage

logger = logging.getLogger(__name__)

# Discovery priority for workspace context files (first match per directory wins)
ROOT_INSTRUCTION_FILENAMES = [
    "AGENTS.override.md",
    "AGENTS.md",
    "agents.md",
    ".homun/AGENTS.md",
    "CLAUDE.md",
    "claude.md",
    ".cursorrules",
]

SUBDIR_INSTRUCTION_FILENAMES = [
    "AGENTS.override.md",
    "AGENTS.md",
    "agents.md",
    "CLAUDE.md",
    "claude.md",
    ".cursorrules",
]

MAX_CONTEXT_FILE_CHARS = 32_000
CHARS_PER_TOKEN = 4

THREAT_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?(previous|prior)\s+instructions", re.IGNORECASE),
    re.compile(r"disregard\s+(all\s+)?(previous|prior)\s+directions", re.IGNORECASE),
    re.compile(r"system\s+override\s*:", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(in\s+)?(developer|god|dan)\s+mode", re.IGNORECASE),
    re.compile(r"do\s+not\s+follow\s+any\s+(rules|guidelines)", re.IGNORECASE),
]


@dataclass
class ContextFileSource:
    label: str
    path: str
    chars: int
    est_tokens: int
    loaded: bool
    status: str                         # loaded | truncated | shadowed | blocked | flagged | empty | unreadable

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def scan_for_threats(content: str) -> bool:
    """Check whether text matches prompt-injection or instruction-override patterns."""
    for pattern in THREAT_PATTERNS:
        if pattern.search(content):
            return True
    return False


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // CHARS_PER_TOKEN)


def discover_workspace_instructions(
    workspace_root: Path,
) -> Tuple[Optional[str], Optional[Path], Optional[str]]:
    """Find winning root instruction file in workspace root."""
    for filename in ROOT_INSTRUCTION_FILENAMES:
        p = (workspace_root / filename).resolve()
        if p.exists() and p.is_file():
            try:
                content = p.read_text(encoding="utf-8", errors="replace").strip()
                return filename, p, content
            except Exception as exc:
                logger.warning("Failed to read context file %s: %s", p, exc)
                return filename, p, None
    return None, None, None


def discover_nested_hints(
    cwd: Path,
    workspace_root: Path,
) -> List[Tuple[str, Path, str]]:
    """Walk from workspace_root down to cwd, gathering subdirectory instructions."""
    try:
        resolved_cwd = cwd.resolve()
        resolved_root = workspace_root.resolve()
        if not resolved_cwd.is_relative_to(resolved_root):
            return []
    except Exception:
        return []

    # Build directory chain from root to cwd
    chain: List[Path] = []
    curr = resolved_cwd
    while curr != resolved_root and curr != curr.parent:
        chain.append(curr)
        curr = curr.parent
    chain.reverse()

    results: List[Tuple[str, Path, str]] = []
    seen_paths: Set[Path] = set()

    for d in chain:
        for filename in SUBDIR_INSTRUCTION_FILENAMES:
            candidate = (d / filename).resolve()
            if candidate.exists() and candidate.is_file() and candidate not in seen_paths:
                try:
                    content = candidate.read_text(encoding="utf-8", errors="replace").strip()
                    if content:
                        rel_path = candidate.relative_to(resolved_root)
                        results.append((str(rel_path), candidate, content))
                        seen_paths.add(candidate)
                        break
                except Exception as exc:
                    logger.warning("Failed reading nested hint %s: %s", candidate, exc)
    return results


def list_context_file_sources(
    cwd: Optional[Path] = None,
    workspace_root: Optional[Path] = None,
    *,
    user_home: Optional[Path] = None,
    max_chars: int = MAX_CONTEXT_FILE_CHARS,
) -> List[ContextFileSource]:
    """Inspect and list all candidate instruction files with status and token estimates."""
    root = workspace_root or (cwd or Path.cwd())
    target_cwd = cwd or root
    sources: List[ContextFileSource] = []

    # 1. User preferences (SOUL.md)
    home_dir = user_home or Path.home()
    soul_path = home_dir / "SOUL.md"
    if soul_path.exists() and soul_path.is_file():
        try:
            content = soul_path.read_text(encoding="utf-8", errors="replace")
            if not content.strip():
                status = "empty"
                loaded = False
            elif scan_for_threats(content):
                status = "flagged"
                loaded = True
            elif len(content) > max_chars:
                status = "truncated"
                loaded = True
            else:
                status = "loaded"
                loaded = True
            sources.append(ContextFileSource(
                label="SOUL.md",
                path=str(soul_path),
                chars=len(content),
                est_tokens=estimate_tokens(content),
                loaded=loaded,
                status=status,
            ))
        except Exception:
            sources.append(ContextFileSource(
                label="SOUL.md",
                path=str(soul_path),
                chars=0,
                est_tokens=0,
                loaded=False,
                status="unreadable",
            ))

    # 2. Workspace root instructions
    winner_name, winner_path, winner_content = discover_workspace_instructions(root)
    for filename in ROOT_INSTRUCTION_FILENAMES:
        cand = (root / filename).resolve()
        if not cand.exists() or not cand.is_file():
            continue

        if cand == winner_path:
            if winner_content is None:
                status = "unreadable"
                loaded = False
                c_len = 0
            elif not winner_content.strip():
                status = "empty"
                loaded = False
                c_len = 0
            elif scan_for_threats(winner_content):
                status = "blocked"
                loaded = False
                c_len = len(winner_content)
            elif len(winner_content) > max_chars:
                status = "truncated"
                loaded = True
                c_len = len(winner_content)
            else:
                status = "loaded"
                loaded = True
                c_len = len(winner_content)
            sources.append(ContextFileSource(
                label=filename,
                path=str(cand),
                chars=c_len,
                est_tokens=estimate_tokens(winner_content or ""),
                loaded=loaded,
                status=status,
            ))
        else:
            # Shadowed by higher-priority file in same directory
            try:
                c_len = cand.stat().st_size
            except Exception:
                c_len = 0
            sources.append(ContextFileSource(
                label=filename,
                path=str(cand),
                chars=c_len,
                est_tokens=c_len // CHARS_PER_TOKEN,
                loaded=False,
                status="shadowed",
            ))

    # 3. Subdirectory instructions
    nested = discover_nested_hints(target_cwd, root)
    for rel_label, path, content in nested:
        if not content.strip():
            status = "empty"
            loaded = False
        elif scan_for_threats(content):
            status = "blocked"
            loaded = False
        elif len(content) > max_chars:
            status = "truncated"
            loaded = True
        else:
            status = "loaded"
            loaded = True
        sources.append(ContextFileSource(
            label=rel_label,
            path=str(path),
            chars=len(content),
            est_tokens=estimate_tokens(content),
            loaded=loaded,
            status=status,
        ))

    return sources


class PromptAssembler:
    """Assembles structured prompt layers honoring documented hierarchy and security bounds."""

    def __init__(
        self,
        base_guidance: str = "",
        max_context_chars: int = MAX_CONTEXT_FILE_CHARS,
    ):
        self.base_guidance = base_guidance
        self.max_context_chars = max_context_chars

    def assemble(
        self,
        objective: str,
        instructions: str,
        *,
        cwd: Optional[Path] = None,
        workspace_root: Optional[Path] = None,
        persona: Optional[str] = None,
        user_home: Optional[Path] = None,
        tools_manifest: Optional[List[Dict[str, Any]]] = None,
    ) -> List[NativeMessage]:
        root = workspace_root or (cwd or Path.cwd())
        target_cwd = cwd or root

        sections: List[str] = [self.base_guidance.strip()] if self.base_guidance.strip() else []

        if persona and persona.strip():
            sections.append(f"## Persona and Identity\n{persona.strip()}")

        # Evaluate context sources
        sources = list_context_file_sources(
            cwd=target_cwd,
            workspace_root=root,
            user_home=user_home,
            max_chars=self.max_context_chars,
        )

        for src in sources:
            if not src.loaded:
                if src.status == "blocked":
                    sections.append(f"## {src.label} [BLOCKED]\nFile {src.path} was blocked due to untrusted instruction patterns.")
                continue

            try:
                p = Path(src.path)
                content = p.read_text(encoding="utf-8", errors="replace").strip()
                if len(content) > self.max_context_chars:
                    half = (self.max_context_chars - 80) // 2
                    content = content[:half] + "\n\n[...truncated due to size...]\n\n" + content[-half:]
                sections.append(f"## Instructions from {src.label}\n{content}")
            except Exception as exc:
                logger.warning("Failed injecting context file %s: %s", src.path, exc)

        if instructions and instructions.strip():
            sections.append(f"## Assigned Instructions\n{instructions.strip()}")

        if tools_manifest:
            tool_lines = [f"- {t.get('name')}: {t.get('description', '')}" for t in tools_manifest if isinstance(t, dict)]
            if tool_lines:
                sections.append("## Available Tools\n" + "\n".join(tool_lines))

        system_content = "\n\n".join(sections)
        return [
            NativeMessage(role="system", content=system_content),
            NativeMessage(role="user", content=objective),
        ]
