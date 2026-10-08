"""Disk cleanup and workspace maintenance engine for Homun.

Identifies and safely purges temporary artifacts, obsolete caches, dangling logs,
and ephemeral build outputs with dry-run support.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

SAFE_CLEANUP_CATEGORIES = {
    "python_cache": ["__pycache__", ".pytest_cache", ".mypy_cache"],
    "temp_files": ["*.tmp", "*.bak", ".DS_Store"],
    "obsolete_logs": ["*.log.old", "*.log.1", "*.log.2"],
    "build_artifacts": [".ruff_cache", "build/tmp"],
}


class CleanupCandidate(BaseModel):
    path: str
    category: str
    size_bytes: int
    is_dir: bool


class CleanupScanReport(BaseModel):
    target_root: str
    total_reclaimable_bytes: int
    candidate_count: int
    by_category: Dict[str, int] = Field(default_factory=dict)
    candidates: List[CleanupCandidate] = Field(default_factory=list)


class CleanupExecutionReport(BaseModel):
    success: bool
    purged_count: int
    reclaimed_bytes: int
    errors: List[str] = Field(default_factory=list)


class DiskCleanupEngine:
    """Scans and safely purges disposable workspace data."""

    def __init__(self, root_dir: Path) -> None:
        self.root_dir = root_dir

    def scan(self, target_dir: Optional[Path] = None) -> CleanupScanReport:
        """Scan workspace for safe disposable artifacts (dry-run)."""
        root = target_dir or self.root_dir
        if not root.exists():
            return CleanupScanReport(target_root=str(root), total_reclaimable_bytes=0, candidate_count=0)

        candidates: List[CleanupCandidate] = []
        by_cat: Dict[str, int] = {cat: 0 for cat in SAFE_CLEANUP_CATEGORIES}

        for cat, patterns in SAFE_CLEANUP_CATEGORIES.items():
            for pat in patterns:
                if pat.startswith("*"):
                    # File glob
                    ext = pat.lstrip("*")
                    for p in root.rglob(f"*{ext}"):
                        if p.is_file():
                            sz = p.stat().st_size
                            candidates.append(CleanupCandidate(path=str(p), category=cat, size_bytes=sz, is_dir=False))
                            by_cat[cat] += sz
                else:
                    # Directory or specific name glob
                    for p in root.rglob(pat):
                        if p.is_dir():
                            sz = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
                            candidates.append(CleanupCandidate(path=str(p), category=cat, size_bytes=sz, is_dir=True))
                            by_cat[cat] += sz
                        elif p.is_file():
                            sz = p.stat().st_size
                            candidates.append(CleanupCandidate(path=str(p), category=cat, size_bytes=sz, is_dir=False))
                            by_cat[cat] += sz

        # Deduplicate paths
        unique_candidates: Dict[str, CleanupCandidate] = {c.path: c for c in candidates}
        final_list = list(unique_candidates.values())
        total_bytes = sum(c.size_bytes for c in final_list)

        return CleanupScanReport(
            target_root=str(root),
            total_reclaimable_bytes=total_bytes,
            candidate_count=len(final_list),
            by_category=by_cat,
            candidates=final_list,
        )

    def execute(self, target_dir: Optional[Path] = None, categories: Optional[List[str]] = None) -> CleanupExecutionReport:
        """Purge identified safe cleanup candidates."""
        scan_report = self.scan(target_dir=target_dir)
        allowed_cats = set(categories) if categories else set(SAFE_CLEANUP_CATEGORIES.keys())

        purged_count = 0
        reclaimed_bytes = 0
        errors = []

        for candidate in scan_report.candidates:
            if candidate.category not in allowed_cats:
                continue

            p = Path(candidate.path)
            if not p.exists():
                continue

            try:
                if candidate.is_dir:
                    shutil.rmtree(p)
                else:
                    p.unlink()
                purged_count += 1
                reclaimed_bytes += candidate.size_bytes
            except Exception as exc:
                errors.append(f"Failed to remove {candidate.path}: {exc}")

        return CleanupExecutionReport(
            success=(len(errors) == 0),
            purged_count=purged_count,
            reclaimed_bytes=reclaimed_bytes,
            errors=errors,
        )
