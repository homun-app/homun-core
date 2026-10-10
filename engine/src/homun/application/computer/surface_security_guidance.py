"""Security guidance and advisory pattern scanner for Homun.

Analyzes proposed commands, code patches, and scripts against known vulnerability
and misconfiguration patterns to provide proactive remediation advice.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class SecurityAdvisory(BaseModel):
    rule_id: str
    severity: str = Field(..., description="critical, high, medium, low")
    title: str
    description: str
    matched_text: str
    remediation: str


_SECURITY_PATTERNS = [
    (
        "SEC-001",
        "critical",
        "Piped Shell Execution",
        "Piping remote web content directly into bash or sh bypasses integrity verification and review.",
        re.compile(r"(curl|wget)\s+[^|]+\|\s*(bash|sh|zsh)", re.IGNORECASE),
        "Download the script first, inspect its contents, and execute with explicit arguments.",
    ),
    (
        "SEC-002",
        "high",
        "Overly Permissive File Permissions",
        "Setting permissions to 777 grants full read/write/execute rights to all users on the system.",
        re.compile(r"chmod\s+(-R\s+)?777\b", re.IGNORECASE),
        "Use more restrictive permissions such as 755 for executables or 644 for regular files.",
    ),
    (
        "SEC-003",
        "critical",
        "Hardcoded Secret or Access Token",
        "A plaintext API token or private key was detected in the payload.",
        re.compile(r"(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{30,}|AKIA[0-9A-Z]{16})"),
        "Store secrets in environment variables or the encrypted Homun VaultStore, referencing them by opaque handle.",
    ),
    (
        "SEC-004",
        "high",
        "Unsafe Python Deserialization",
        "Unpickling untrusted binary data can lead to arbitrary code execution.",
        re.compile(r"(pickle\.loads?\b|_pickle\.loads?\b|yaml\.load\([^,)]+Loader=yaml\.Loader\))"),
        "Use safe serialization formats like JSON (json.loads) or yaml.safe_load.",
    ),
    (
        "SEC-005",
        "high",
        "Potential SQL Injection Pattern",
        "String concatenation inside an SQL query introduces SQL injection vulnerabilities.",
        re.compile(r"execute\s*\(\s*f[\"'].*SELECT.*\{.*\}", re.IGNORECASE),
        "Use parameterized SQL queries with bind variables instead of f-string formatting.",
    ),
]


class SecurityGuidanceScanner:
    """Scans content for security advisories and policy violations."""

    def scan(self, text: str) -> List[SecurityAdvisory]:
        """Scan input string against security pattern rules."""
        if not text:
            return []

        advisories: List[SecurityAdvisory] = []
        for rule_id, sev, title, desc, pattern, remed in _SECURITY_PATTERNS:
            match = pattern.search(text)
            if match:
                matched_snippet = match.group(0)
                advisories.append(
                    SecurityAdvisory(
                        rule_id=rule_id,
                        severity=sev,
                        title=title,
                        description=desc,
                        matched_text=matched_snippet[:100],
                        remediation=remed,
                    )
                )

        return advisories
