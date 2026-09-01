#!/usr/bin/env python3
"""Preview and apply metadata-safe redaction for Homun diagnostic logs."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from scripts.audit_homun_state import LOG_EXTENSIONS, SENSITIVE_PATTERNS, default_data_dir
except ModuleNotFoundError:
    sys.path.insert(0, os.fspath(Path(__file__).resolve().parent.parent))
    from scripts.audit_homun_state import LOG_EXTENSIONS, SENSITIVE_PATTERNS, default_data_dir


REDACTION_BY_DETECTOR = {
    "identity:codice_fiscale": "[REDACTED:identity]",
    "credentials:openai_key": "[REDACTED:credential]",
    "credentials:bearer": "[REDACTED:credential]",
}


@dataclass(frozen=True)
class LogRepairFile:
    path: Path
    relative_path: Path
    redaction_count: int
    changed_lines: int


def redact_sensitive_text(text: str) -> tuple[str, int]:
    redacted = text
    count = 0
    for detector, pattern in SENSITIVE_PATTERNS:
        replacement = REDACTION_BY_DETECTOR[detector]
        redacted, substitutions = pattern.subn(replacement, redacted)
        count += substitutions
    return redacted, count


def iter_log_files(logs_dir: Path) -> list[Path]:
    if not logs_dir.exists():
        return []
    return [
        path
        for path in sorted(logs_dir.rglob("*"))
        if path.is_file() and not path.is_symlink() and path.suffix.lower() in LOG_EXTENSIONS
    ]


def scan_log_repairs(logs_dir: Path) -> list[LogRepairFile]:
    repairs: list[LogRepairFile] = []
    for path in iter_log_files(logs_dir):
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        redaction_count = 0
        changed_lines = 0
        for line in raw.splitlines(keepends=True):
            redacted, count = redact_sensitive_text(line)
            redaction_count += count
            if redacted != line:
                changed_lines += 1
        if redaction_count:
            repairs.append(
                LogRepairFile(
                    path=path,
                    relative_path=path.relative_to(logs_dir),
                    redaction_count=redaction_count,
                    changed_lines=changed_lines,
                )
            )
    return repairs


def preview_log_repair(logs_dir: Path) -> dict[str, Any]:
    repairs = scan_log_repairs(logs_dir)
    return {
        "ok": True,
        "logs_dir": os.fspath(logs_dir),
        "files": [
            {
                "path": os.fspath(item.relative_path),
                "redaction_count": item.redaction_count,
                "changed_lines": item.changed_lines,
            }
            for item in repairs
        ],
        "total_files": len(repairs),
        "total_redactions": sum(item.redaction_count for item in repairs),
    }


def default_backup_dir(logs_dir: Path) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return (
        logs_dir.parent
        / "backups"
        / "privacy-logs"
        / f"{timestamp}-{uuid.uuid4().hex}"
    )


def apply_log_repair(logs_dir: Path, backup_dir: Path | None = None, *, confirm: bool = False) -> dict[str, Any]:
    if not confirm:
        raise ValueError("log repair requires confirm=True")
    repairs = scan_log_repairs(logs_dir)
    if not repairs:
        return {
            "ok": True,
            "backup": {"created": False, "files": 0, "bytes": 0},
            "applied": [],
            "total_redactions": 0,
        }
    backup_root = backup_dir or default_backup_dir(logs_dir)
    if backup_root.exists():
        raise ValueError("backup directory already exists")
    backup_root.mkdir(parents=True)
    applied: list[dict[str, Any]] = []
    for item in repairs:
        destination = backup_root / item.relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item.path, destination)
        raw = item.path.read_text(encoding="utf-8", errors="replace")
        redacted, _ = redact_sensitive_text(raw)
        temp_path = item.path.with_name(f".{item.path.name}.redacting")
        temp_path.write_text(redacted, encoding="utf-8")
        shutil.copymode(item.path, temp_path)
        temp_path.replace(item.path)
        applied.append(
            {
                "path": os.fspath(item.relative_path),
                "redaction_count": item.redaction_count,
                "changed_lines": item.changed_lines,
            }
        )
    return {
        "ok": True,
        "backup": {
            "created": True,
            "files": len(applied),
            "bytes": sum((backup_root / item.relative_path).stat().st_size for item in repairs),
        },
        "applied": applied,
        "total_redactions": sum(item["redaction_count"] for item in applied),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--logs-dir", type=Path, default=default_data_dir() / "logs")
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--apply", action="store_true", help="Apply redaction instead of previewing it")
    parser.add_argument("--confirm", action="store_true", help="Required with --apply")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.apply:
            report = apply_log_repair(args.logs_dir, args.backup_dir, confirm=args.confirm)
        else:
            report = preview_log_repair(args.logs_dir)
    except ValueError as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2, sort_keys=True))
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
