"""Deliverable artifact extraction from assistant message text (H42).

at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Scans agent responses for generated deliverables (PDFs, charts, spreadsheets, audio) while strictly
ignoring paths inside fenced code blocks or backtick expressions, ensuring code examples are never
mutilated or dispatched as uploads.
"""
from __future__ import annotations

import logging
import mimetypes
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from homun.application.deliverable_policy import (
    DELIVERABLE_EXTENSIONS,
    get_deliverable_category,
    validate_deliverable_path,
)

logger = logging.getLogger(__name__)

# Matches fenced code blocks (``` ... ```)
_FENCED_CODE_BLOCK_REGEX = re.compile(r"```[\s\S]*?```")
# Matches inline code blocks (` ... `)
_INLINE_CODE_REGEX = re.compile(r"`[^`\n]+`")

# Regex to detect absolute or home-relative filesystem paths with deliverable extensions
# Matches: /path/to/file.ext or ~/path/to/file.ext or C:\path\file.ext
_PATH_CANDIDATE_REGEX = re.compile(
    r"(?:/[A-Za-z0-9_.\-]+|\~[A-Za-z0-9_.\-]*|[A-Za-z]:\\[A-Za-z0-9_.\-]+)(?:/[A-Za-z0-9_.\-]+|\\[A-Za-z0-9_.\-]+)*\.[A-Za-z0-9]+"
)


@dataclass
class DeliverableAttachment:
    path: str
    filename: str
    category: str  # image, video, audio, document, data, presentation, archive
    mime_type: str = "application/octet-stream"
    exists_on_disk: bool = False
    size_bytes: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)


def _mask_code_spans(text: str) -> Tuple[str, List[Tuple[str, str]]]:
    """Replace fenced code blocks and inline code with placeholders to prevent matching inside them.

    Returns (masked_text, list_of_placeholders).
    """
    placeholders: List[Tuple[str, str]] = []

    def replace_fenced(match: re.Match) -> str:
        token = f"«CODE_BLOCK_{len(placeholders)}»"
        placeholders.append((token, match.group(0)))
        return token

    def replace_inline(match: re.Match) -> str:
        token = f"«INLINE_CODE_{len(placeholders)}»"
        placeholders.append((token, match.group(0)))
        return token

    # First mask multi-line fenced code blocks
    masked = _FENCED_CODE_BLOCK_REGEX.sub(replace_fenced, text)
    # Then mask inline backticks
    masked = _INLINE_CODE_REGEX.sub(replace_inline, masked)
    return masked, placeholders


def _unmask_code_spans(text: str, placeholders: List[Tuple[str, str]]) -> str:
    """Restore code blocks from placeholders."""
    restored = text
    for token, original in placeholders:
        restored = restored.replace(token, original)
    return restored


def extract_deliverables_from_text(
    text: str,
    *,
    allowed_dirs: Optional[List[Path | str]] = None,
    check_exists: bool = False,
) -> Tuple[str, List[DeliverableAttachment]]:
    """Scan text for deliverable file paths, ignoring code blocks.

    Returns (cleaned_text, list_of_attachments).
    """
    if not isinstance(text, str) or not text:
        return text, []

    # 1. Mask code blocks so example paths in code samples are completely protected
    masked_text, placeholders = _mask_code_spans(text)

    attachments: List[DeliverableAttachment] = []
    found_paths: Set[str] = set()

    for match in _PATH_CANDIDATE_REGEX.finditer(masked_text):
        raw_path = match.group(0)
        ext = Path(raw_path).suffix.lower()

        if ext not in DELIVERABLE_EXTENSIONS:
            continue

        valid, _ = validate_deliverable_path(raw_path, allowed_dirs=allowed_dirs)
        if not valid:
            continue

        p = Path(raw_path).expanduser().resolve()
        p_str = str(p)
        if p_str in found_paths:
            continue
        found_paths.add(p_str)

        exists = p.exists() if check_exists else True
        if check_exists and not exists:
            continue

        size = p.stat().st_size if p.exists() else 0
        mime, _ = mimetypes.guess_type(p_str)
        category = get_deliverable_category(p) or "document"

        attachments.append(
            DeliverableAttachment(
                path=p_str,
                filename=p.name,
                category=category,
                mime_type=mime or "application/octet-stream",
                exists_on_disk=p.exists(),
                size_bytes=size,
            )
        )

        # Replace standalone path mentions in masked text cleanly
        # e.g. "Saved to /path/to/report.pdf for download." -> "Saved to [report.pdf] for download."
        masked_text = masked_text.replace(raw_path, f"[{p.name}]")

    # 2. Restore original code blocks untouched
    cleaned_text = _unmask_code_spans(masked_text, placeholders)
    return cleaned_text, attachments
