"""Secret and credential redaction engine (H40).

Masks known API tokens, private keys, authorization headers, and dynamically registered
vault secrets from model transcripts, tool outputs, and logs.
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Dict, List, Optional, Set

logger = logging.getLogger(__name__)

# Registered exact vault values to scrub
_VAULT_REDACTION_LOCK = threading.Lock()
_VAULT_REGISTERED_VALUES: Dict[str, None] = {}
_MAX_REGISTERED_VAULT_VALUES = 128


def mask_token(token: str) -> str:
    """Mask a secret token. Short tokens (<18 chars) are fully masked as '***'.
    Longer tokens retain the first 6 and last 4 characters for debug identification.
    """
    if not token:
        return ""
    if len(token) < 18:
        return "***"
    return f"{token[:6]}...{token[-4:]}"


def register_vault_redaction_value(value: str) -> None:
    """Register an exact secret value (e.g. from password vault) for redaction."""
    if not isinstance(value, str) or not value.strip():
        return
    clean = value.strip()
    norm = clean.replace("\r", "").replace("\n", "")
    with _VAULT_REDACTION_LOCK:
        for v in (clean, norm):
            if v:
                _VAULT_REGISTERED_VALUES.pop(v, None)
                _VAULT_REGISTERED_VALUES[v] = None
        while len(_VAULT_REGISTERED_VALUES) > _MAX_REGISTERED_VAULT_VALUES:
            del _VAULT_REGISTERED_VALUES[next(iter(_VAULT_REGISTERED_VALUES))]


def clear_vault_redaction_values() -> None:
    """Clear all registered vault values."""
    with _VAULT_REDACTION_LOCK:
        _VAULT_REGISTERED_VALUES.clear()


# Known API key token prefixes
_TOKEN_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{10,}"),
    re.compile(r"ghp_[A-Za-z0-9]{10,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{10,}"),
    re.compile(r"gh[ousr]_[A-Za-z0-9]{10,}"),
    re.compile(r"xapp-\d+-[A-Za-z0-9-]{10,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"AIza[A-Za-z0-9_-]{30,}"),
    re.compile(r"pplx-[A-Za-z0-9]{10,}"),
    re.compile(r"fal_[A-Za-z0-9_-]{10,}"),
    re.compile(r"AKIA[A-Z0-9]{16}"),
    re.compile(r"sk_(?:live|test)_[A-Za-z0-9]{10,}"),
    re.compile(r"hf_[A-Za-z0-9]{10,}"),
    re.compile(r"tvly-[A-Za-z0-9]{10,}"),
    re.compile(r"xai-[A-Za-z0-9]{30,}"),
    re.compile(r"fw-[A-Za-z0-9]{30,}"),
    re.compile(r"mem0_[A-Za-z0-9]{10,}"),
]

# Private key blocks
_PRIVATE_KEY_REGEX = re.compile(
    r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"
)

# Sensitive query params
_QUERY_PARAM_REGEX = re.compile(
    r"(?<=[?&])(access_token|api_key|token|secret|password|jwt)=([^&\s]+)"
)

# Authorization header bearer token
_BEARER_TOKEN_REGEX = re.compile(
    r"(?i)(Authorization:\s*Bearer\s+)([A-Za-z0-9\-._~+/]+=*)"
)


def redact_secrets(text: str) -> str:
    """Scrub known secret tokens, private keys, sensitive query params, and vault entries."""
    if not isinstance(text, str) or not text:
        return text

    redacted = text

    # 1. Scrub registered vault secrets (exact match, longest first)
    with _VAULT_REDACTION_LOCK:
        vault_vals = sorted(_VAULT_REGISTERED_VALUES.keys(), key=len, reverse=True)
    for v in vault_vals:
        if v in redacted:
            redacted = redacted.replace(v, "«redacted-vault-secret»")

    # 2. Scrub private keys
    redacted = _PRIVATE_KEY_REGEX.sub("«redacted-private-key»", redacted)

    # 3. Scrub Bearer tokens in headers
    def replace_bearer(match: re.Match) -> str:
        prefix = match.group(1)
        raw_tok = match.group(2)
        return f"{prefix}{mask_token(raw_tok)}"

    redacted = _BEARER_TOKEN_REGEX.sub(replace_bearer, redacted)

    # 4. Scrub sensitive query parameters
    def replace_query(match: re.Match) -> str:
        param = match.group(1)
        val = match.group(2)
        return f"{param}={mask_token(val)}"

    redacted = _QUERY_PARAM_REGEX.sub(replace_query, redacted)

    # 5. Scrub well-known token prefix patterns
    for pat in _TOKEN_PATTERNS:
        redacted = pat.sub(lambda m: mask_token(m.group(0)), redacted)

    return redacted
