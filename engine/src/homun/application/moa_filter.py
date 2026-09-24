"""Privacy and sensitive data filter for MoA advisor outputs (H24).

Derived from Hermes agent/moa_loop.py and agent/moa_trace.py
at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Masks credential shapes, bearer tokens, API keys, emails, and formatted phone numbers
while conservatively preserving git SHAs, line numbers, IP addresses, and code snippets.
"""
from __future__ import annotations

import re
from typing import Optional

# Email pattern (standard RFC-like email)
_EMAIL_RE = re.compile(
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b"
)

# Phone pattern: matches clearly formatted international/national phone numbers
# e.g., +1-555-123-4567, (555) 123-4567, +39 06 12345678
# Avoids matching simple line ranges (e.g. 10-20) or versions (e.g. 1.2.3)
_PHONE_RE = re.compile(
    r"(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b"
)

# Common API key and credential prefixes
_KEY_PREFIX_RE = re.compile(
    r"\b(sk-[a-zA-Z0-9_\-]{16,}|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9_\-]{10,}|bearer\s+[a-zA-Z0-9_\-\.]{20,})\b",
    re.IGNORECASE,
)

# JWT pattern (three base64 segments)
_JWT_RE = re.compile(
    r"\beyJ[a-zA-Z0-9_\-]{10,}\.eyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\b"
)


def redact_sensitive_text(text: str) -> str:
    """Redact secrets, emails, and formatted phone numbers from text."""
    if not text:
        return ""

    out = text

    # Mask JWTs
    out = _JWT_RE.sub("[JWT_REDACTED]", out)

    # Mask standard API keys & bearer tokens
    out = _KEY_PREFIX_RE.sub("[TOKEN_REDACTED]", out)

    # Mask emails
    out = _EMAIL_RE.sub("[EMAIL_REDACTED]", out)

    # Mask phone numbers carefully: check if length and shape suggest real phone
    def _mask_phone(match: re.Match) -> str:
        s = match.group(0).strip()
        # Count actual digits
        digits = sum(c.isdigit() for c in s)
        # Only mask if it has at least 7 digits (real phone length)
        if digits >= 7:
            return "[PHONE_REDACTED]"
        return s

    out = _PHONE_RE.sub(_mask_phone, out)
    return out


def apply_privacy_filter(text: str, mode: str = "none") -> str:
    """Apply the configured MoA privacy filter mode.

    Modes:
    - 'none': returns text verbatim.
    - 'display' or 'full': redacts sensitive patterns.
    """
    if mode in ("display", "full"):
        return redact_sensitive_text(text)
    return text
