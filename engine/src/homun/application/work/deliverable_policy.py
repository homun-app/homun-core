"""Deliverable media policy and allowed extension validator (H42).

Defines categories of user-facing deliverables (PDF, images, spreadsheets, audio, presentations),
confines delivery paths to authorized scratch/workspace roots, and rejects code files (.py, .sh, .env)
from auto-delivery.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

DELIVERABLE_EXTENSIONS: Dict[str, str] = {
    # Images
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".webp": "image",
    ".svg": "image",
    ".bmp": "image",
    # Video
    ".mp4": "video",
    ".mov": "video",
    ".webm": "video",
    ".mkv": "video",
    # Audio
    ".mp3": "audio",
    ".wav": "audio",
    ".ogg": "audio",
    ".opus": "audio",
    ".m4a": "audio",
    ".flac": "audio",
    # Documents
    ".pdf": "document",
    ".docx": "document",
    ".doc": "document",
    ".odt": "document",
    ".rtf": "document",
    ".epub": "document",
    ".txt": "document",
    # Data & Tables
    ".xlsx": "data",
    ".xls": "data",
    ".csv": "data",
    ".tsv": "data",
    ".json": "data",
    # Presentations
    ".pptx": "presentation",
    ".key": "presentation",
    # Archives
    ".zip": "archive",
    ".tar.gz": "archive",
}

# Blocked extensions from automatic delivery (e.g. source code, secrets, logs)
BLOCKED_DELIVERABLE_EXTENSIONS: Set[str] = frozenset({
    ".py",
    ".sh",
    ".bash",
    ".zsh",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".env",
    ".log",
    ".key",
    ".pem",
    ".crt",
    ".exe",
    ".bin",
})


def get_deliverable_category(path: Path | str) -> Optional[str]:
    """Return deliverable category (image, document, data, audio, etc.) or None if excluded."""
    ext = Path(path).suffix.lower()
    return DELIVERABLE_EXTENSIONS.get(ext)


def validate_deliverable_path(
    path: Path | str,
    *,
    strict: bool = False,
    allowed_dirs: Optional[List[Path | str]] = None,
    must_exist: bool = False,
) -> Tuple[bool, Optional[str]]:
    """Validate whether a file path qualifies as a safe user deliverable."""
    p = Path(path).expanduser().resolve()
    ext = p.suffix.lower()

    if ext in BLOCKED_DELIVERABLE_EXTENSIONS:
        return False, f"Extension '{ext}' is forbidden from auto-delivery (source code / executable policy)."

    if ext not in DELIVERABLE_EXTENSIONS:
        return False, f"Extension '{ext}' is not a recognized deliverable format."

    if must_exist and not p.exists():
        return False, f"Deliverable file '{p}' does not exist on disk."

    if strict or allowed_dirs:
        dirs = [Path(d).expanduser().resolve() for d in (allowed_dirs or [])]
        if not dirs:
            # Default allowlist is workspace and scratch cache
            homun_home = Path(os.getenv("HOMUN_HOME") or os.path.expanduser("~/.homun")).resolve()
            dirs = [homun_home / "scratch", homun_home / "artifacts", Path.cwd().resolve()]

        is_allowed = False
        for allowed in dirs:
            try:
                p.relative_to(allowed)
                is_allowed = True
                break
            except ValueError:
                continue

        if not is_allowed:
            return False, f"Deliverable path '{p}' is outside allowed directories."

    return True, None
