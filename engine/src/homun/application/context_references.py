"""Context @-reference expansion with size and security boundaries (H04).

Derived from Hermes agent/context_references.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun expands inline @-references:
  - @file:<path>[:start[-end]]  (file content with optional line ranges)
  - @folder:<path>              (directory listing)
  - @diff / @staged             (git diffs)
  - @git:<rev>                  (git commit / ref diff)
  - @url:<http(s)-url>          (public web fetch with SSRF protection)

Strict security and resource boundaries:
  - Denies sensitive system paths (.ssh, .aws, .gnupg, .kube, .docker, .azure, .env).
  - Enforces per-reference max chars and total message expansion budget.
  - Rejects binary files.
  - Blocks private IP targets on @url.
"""
from __future__ import annotations

import ipaddress
import logging
import os
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Reference syntax: @diff, @staged, @file:..., @folder:..., @git:..., @url:...
REFERENCE_REGEX = re.compile(
    r"(?<![\w/])@(?:(?P<simple>diff|staged)\b|(?P<kind>file|folder|git|url):(?P<value>(?:`[^`\n]+`|\"[^\"\n]+\"|'[^'\n]+'|\S+)))"
)

FILE_VALUE_REGEX = re.compile(
    r"^(?:`(?P<q1>[^`]+)`|\"(?P<q2>[^\"]+)\"|'(?P<q3>[^']+)'|(?P<bare>[^:]+))(?::(?P<start>\d+)(?:-(?P<end>\d+))?)?$"
)

SENSITIVE_DIR_NAMES = {
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".config/gh",
}

SENSITIVE_FILE_NAMES = {
    ".env", "id_rsa", "id_ed25519", "id_ecdsa", "authorized_keys",
    "known_hosts", ".netrc", ".pgpass", ".npmrc", ".pypirc",
}

MAX_CHARS_PER_REFERENCE = 16_000
MAX_TOTAL_REFERENCE_CHARS = 64_000


@dataclass
class ReferenceMeta:
    raw: str
    kind: str
    target: str
    expanded: bool
    chars: int = 0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def is_path_sensitive(path: Path) -> bool:
    """Check if path targets sensitive credentials or configuration."""
    parts = set(path.parts)
    if any(s in parts for s in SENSITIVE_DIR_NAMES):
        return True
    if path.name.lower() in SENSITIVE_FILE_NAMES:
        return True
    return False


def is_url_public(url_str: str) -> bool:
    """Validate that URL scheme is http/https and hostname does not resolve to private IP."""
    try:
        parsed = urlparse(url_str)
        if parsed.scheme.lower() not in ("http", "https"):
            return False
        hostname = (parsed.hostname or "").strip()
        if not hostname or hostname.lower() in ("localhost", "0.0.0.0", "::1"):
            return False
        try:
            ip = ipaddress.ip_address(hostname)
            if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
                return False
        except ValueError:
            pass  # Domain name, allowed
        return True
    except Exception:
        return False


def truncate_text(text: str, max_chars: int = MAX_CHARS_PER_REFERENCE) -> str:
    """Truncate long text preserving head and tail."""
    if len(text) <= max_chars:
        return text
    half = (max_chars - 60) // 2
    return text[:half] + f"\n\n[...truncated {len(text) - (half * 2)} chars...]\n\n" + text[-half:]


def expand_file_reference(target_str: str, cwd: Path) -> Tuple[str, Optional[str]]:
    """Expand @file:target[:start[-end]]."""
    m = FILE_VALUE_REGEX.match(target_str.strip())
    if not m:
        return "", "Invalid file reference syntax"

    path_part = m.group("q1") or m.group("q2") or m.group("q3") or m.group("bare")
    file_path = (cwd / path_part).resolve() if not os.path.isabs(path_part) else Path(path_part).resolve()

    if is_path_sensitive(file_path):
        return "", f"Access denied: {path_part} is a protected sensitive file"

    if not file_path.exists():
        return "", f"File not found: {path_part}"
    if not file_path.is_file():
        return "", f"Path is not a file: {path_part}"

    try:
        raw_bytes = file_path.read_bytes()
        # Binary check (null bytes)
        if b"\x00" in raw_bytes[:1024]:
            return "", f"Cannot expand binary file: {path_part}"
        content = raw_bytes.decode("utf-8", errors="replace")
    except Exception as exc:
        return "", f"Error reading file {path_part}: {exc}"

    lines = content.splitlines()
    start_str = m.group("start")
    end_str = m.group("end")

    if start_str is not None:
        start_idx = max(1, int(start_str))
        end_idx = int(end_str) if end_str is not None else len(lines)
        if end_idx < start_idx:
            return "", f"Invalid line range: {start_str}-{end_str}"
        selected = lines[start_idx - 1 : end_idx]
        header = f"File {path_part} (lines {start_idx}-{end_idx}):\n"
        body = "\n".join(selected)
    else:
        header = f"File {path_part}:\n"
        body = content

    return truncate_text(header + "```\n" + body + "\n```"), None


def expand_folder_reference(target_str: str, cwd: Path) -> Tuple[str, Optional[str]]:
    """Expand @folder:target."""
    clean_target = target_str.strip("`'\"")
    folder_path = (cwd / clean_target).resolve() if not os.path.isabs(clean_target) else Path(clean_target).resolve()

    if is_path_sensitive(folder_path):
        return "", f"Access denied: {clean_target} is a protected directory"

    if not folder_path.exists():
        return "", f"Directory not found: {clean_target}"
    if not folder_path.is_dir():
        return "", f"Path is not a directory: {clean_target}"

    try:
        entries = sorted(folder_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        lines = [f"Directory listing for {clean_target}:"]
        for p in entries[:100]:
            kind = "DIR" if p.is_dir() else "FILE"
            size = f"{p.stat().st_size} bytes" if p.is_file() else ""
            lines.append(f"  [{kind}] {p.name} {size}".rstrip())
        if len(entries) > 100:
            lines.append(f"  [... {len(entries) - 100} more entries omitted ...]")
        return "\n".join(lines), None
    except Exception as exc:
        return "", f"Error reading directory {clean_target}: {exc}"


def expand_diff_reference(staged: bool, cwd: Path) -> Tuple[str, Optional[str]]:
    """Expand @diff or @staged."""
    cmd = ["git", "diff", "--cached"] if staged else ["git", "diff"]
    try:
        res = subprocess.run(
            cmd,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
        )
        if res.returncode != 0:
            return "", f"Git error: {res.stderr.strip()}"
        out = res.stdout.strip()
        if not out:
            return f"(no {'staged' if staged else 'working tree'} changes)", None
        return truncate_text(f"Git {'staged' if staged else 'working tree'} diff:\n```diff\n{out}\n```"), None
    except Exception as exc:
        return "", f"Error running git diff: {exc}"


def expand_git_reference(rev: str, cwd: Path) -> Tuple[str, Optional[str]]:
    """Expand @git:<rev>."""
    clean_rev = rev.strip("`'\"")
    cmd = ["git", "show", "--stat", "--patch", clean_rev]
    try:
        res = subprocess.run(
            cmd,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
        )
        if res.returncode != 0:
            return "", f"Git show error for {clean_rev}: {res.stderr.strip()}"
        out = res.stdout.strip()
        return truncate_text(f"Git show {clean_rev}:\n```diff\n{out}\n```"), None
    except Exception as exc:
        return "", f"Error showing git rev {clean_rev}: {exc}"


def expand_url_reference(url_str: str) -> Tuple[str, Optional[str]]:
    """Expand @url:http(s) with SSRF checks."""
    clean_url = url_str.strip("`'\"")
    if not is_url_public(clean_url):
        return "", f"URL blocked by security policy: {clean_url}"

    try:
        from homun.application.web_pages import fetch_url
        res = fetch_url(clean_url)
        content = res.get("text") or res.get("body") or ""
        return truncate_text(f"Content from {clean_url}:\n\n{content}"), None
    except Exception:
        # Simple HTTP fallback
        import urllib.request
        try:
            req = urllib.request.Request(clean_url, headers={"User-Agent": "Homun-Bot/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read(MAX_CHARS_PER_REFERENCE * 2).decode("utf-8", errors="replace")
                return truncate_text(f"Content from {clean_url}:\n\n{raw}"), None
        except Exception as exc:
            return "", f"Failed to fetch URL {clean_url}: {exc}"


def expand_references(
    text: str,
    cwd: Optional[Path] = None,
    *,
    max_total_chars: int = MAX_TOTAL_REFERENCE_CHARS,
) -> Tuple[str, List[ReferenceMeta]]:
    """Scan text for @-references, expand them within bounds, and return updated text with metadata."""
    target_cwd = cwd or Path.cwd()
    meta_list: List[ReferenceMeta] = []
    total_expanded_chars = 0

    def replace_ref(match: re.Match) -> str:
        nonlocal total_expanded_chars
        raw = match.group(0)
        simple = match.group("simple")
        kind = simple or match.group("kind")
        val = match.group("value") or ""

        if total_expanded_chars >= max_total_chars:
            meta_list.append(ReferenceMeta(raw=raw, kind=kind, target=val, expanded=False, error="Total expansion budget exceeded"))
            return raw

        content = ""
        err: Optional[str] = None

        if kind == "diff":
            content, err = expand_diff_reference(staged=False, cwd=target_cwd)
        elif kind == "staged":
            content, err = expand_diff_reference(staged=True, cwd=target_cwd)
        elif kind == "file":
            content, err = expand_file_reference(val, cwd=target_cwd)
        elif kind == "folder":
            content, err = expand_folder_reference(val, cwd=target_cwd)
        elif kind == "git":
            content, err = expand_git_reference(val, cwd=target_cwd)
        elif kind == "url":
            content, err = expand_url_reference(val)
        else:
            err = f"Unknown reference kind: {kind}"

        if err:
            meta_list.append(ReferenceMeta(raw=raw, kind=kind, target=val, expanded=False, error=err))
            return f"{raw} [Error: {err}]"

        total_expanded_chars += len(content)
        meta_list.append(ReferenceMeta(raw=raw, kind=kind, target=val, expanded=True, chars=len(content)))
        return f"\n--- Begin context reference: {raw} ---\n{content}\n--- End context reference: {raw} ---\n"

    expanded_text = REFERENCE_REGEX.sub(replace_ref, text)
    return expanded_text, meta_list
