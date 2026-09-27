"""Typed sanitized failures for native model calls; Native failure heuristics.

Classification taxonomy of error types and recovery.
Retry-After / jittered base-2 backoff of agent/retry_utils.py and
agent/turn_recovery.py. Homun keeps a
smaller code set: provider bodies are only pattern-matched, never persisted, and
the carried usage is whatever the provider reported before validation failed.
Overload/5xx share one code here; a distinct overload reason arrives with the
provider-fallback tranche.
"""
from __future__ import annotations

import re
import ssl
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from random import Random

RETRY_AFTER_CAP = 600.0
MESSAGE_LIMIT = 300

CANCELLED = 'agent_model_cancelled'
NETWORK = 'agent_model_network'
TIMEOUT = 'agent_model_timeout'
RATE_LIMITED = 'agent_model_rate_limited'
SERVER = 'agent_model_server_error'
AUTH = 'agent_model_auth'
QUOTA = 'agent_model_quota'
INVALID_REQUEST = 'agent_model_invalid_request'
TLS = 'agent_model_tls'
OVERFLOW = 'agent_model_overflow'
EMPTY = 'agent_model_empty_response'
TRUNCATED = 'agent_model_truncated'
MALFORMED = 'agent_model_malformed'
REPETITION = 'agent_model_repetition'

RETRYABLE_CODES = frozenset({NETWORK, TIMEOUT, RATE_LIMITED, SERVER, EMPTY, MALFORMED})

_LABELS = {
    CANCELLED: 'Model stream was cancelled',
    REPETITION: 'Model output entered a repetition loop',
    NETWORK: 'Provider unreachable', TIMEOUT: 'Model call timed out',
    RATE_LIMITED: 'Provider rate limit', SERVER: 'Provider server error',
    AUTH: 'Provider rejected credentials', QUOTA: 'Provider quota or billing exhausted',
    INVALID_REQUEST: 'Provider rejected the request', TLS: 'TLS verification failed',
    OVERFLOW: 'Request exceeds the model context window', EMPTY: 'Model returned an empty response',
    TRUNCATED: 'Model response was truncated', MALFORMED: 'Model response was malformed',
}

# Error classifier pattern tables, lowercased substrings.
_BILLING_PATTERNS = (
    'insufficient_quota', 'insufficient credits', 'insufficient balance', 'credit balance',
    'credits exhausted', 'payment required', 'exceeded your current quota', 'billing hard limit',
    'account is deactivated', 'balance_depleted', 'plan does not include',
)
_OVERFLOW_PATTERNS = (
    'context_length_exceeded', 'context length', 'maximum context length', 'too many tokens',
    'prompt is too long', 'exceed context limit', 'request too large', 'payload too large',
    'reduced context window', 'input length and `max_tokens`',
)
_RESETS_IN_RE = re.compile(
    r"resets?\s+in\s+"
    r"(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b\s*)?"
    r"(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b\s*)?"
    r"(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b)?", re.IGNORECASE)
_RETRY_AFTER_SECONDS_RE = re.compile(r"retry\s+(?:after\s+)?(\d+(?:\.\d+)?)\s*(?:sec|secs|seconds|s\b)",
                                     re.IGNORECASE)
_RESETS_IN_SECONDS_FIELD_RE = re.compile(r"resets_in_seconds\W{1,4}(\d+(?:\.\d+)?)", re.IGNORECASE)


def sanitize(message) -> str:
    """Single-line, length-capped text: safe for logs and exception messages."""
    return ' '.join(str(message or '').split())[:MESSAGE_LIMIT]


class NativeModelError(RuntimeError):
    """A native model call failed with a sanitized, typed reason.

    ``usage`` carries the provider-reported counters extracted before response
    validation; unknown counters stay ``None`` — never zero. Raw provider
    bodies are not stored on the exception. A separately classified visible text
    fragment may be carried explicitly for bounded application continuation.
    """

    def __init__(self, code, message='', *, retryable=None, retry_after_seconds=None,
                 status_code=None, usage=None, partial_text=None):
        if code not in _LABELS:
            raise ValueError(f'Unknown native model error code: {code}')
        self.code = code
        self.retryable = code in RETRYABLE_CODES if retryable is None else bool(retryable)
        self.retry_after_seconds = (min(float(retry_after_seconds), RETRY_AFTER_CAP)
                                    if retry_after_seconds is not None else None)
        self.status_code = status_code
        self.usage = usage
        self.partial_text = partial_text if code == TRUNCATED else None
        super().__init__(sanitize(message) or _LABELS[code])


def parse_retry_after(value) -> float | None:
    """Retry utilities: numeric or HTTP-date seconds, clamped at 0.

    Accepts a raw value or a headers mapping (both casings tried); ``None``
    when absent or unparseable.
    """
    raw = value
    if raw is not None and not isinstance(raw, (str, int, float)):
        getter = getattr(raw, 'get', None)
        if not callable(getter):
            return None
        try:
            raw = getter('Retry-After')
            if raw is None:
                raw = getter('retry-after')
        except Exception:  # noqa: BLE001 — header mappings may be odd mappings
            return None
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return max(0.0, float(raw))
    text = str(raw).strip()
    if not text:
        return None
    try:
        return max(0.0, float(text))
    except (TypeError, ValueError):
        pass
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def retry_after_from_text(text) -> float | None:
    """Seconds until reset parsed from sanitized free-text error messages."""
    if not text:
        return None
    match = _RETRY_AFTER_SECONDS_RE.search(text)
    if match:
        return float(match.group(1))
    match = _RESETS_IN_SECONDS_FIELD_RE.search(text)
    if match:
        return float(match.group(1))
    match = _RESETS_IN_RE.search(text)
    if match and any(match.groups()):
        return (float(match.group(1) or 0) * 3600 + float(match.group(2) or 0) * 60
                + float(match.group(3) or 0))
    return None


def retry_delay(attempts, error, *, base_delay=2.0, max_delay=60.0, jitter_ratio=0.5) -> float:
    """Backoff computation order: Retry-After (capped) wins, else
    jittered base-2 backoff min(base*2^(attempts-1), max) + U[0, jitter*delay].
    A zero/expired Retry-After is treated as absent so we never hot-loop."""
    retry_after = error.retry_after_seconds
    if retry_after is not None and retry_after > 0:
        return min(retry_after, RETRY_AFTER_CAP)
    exponent = max(0, attempts - 1)
    delay = max_delay if exponent >= 30 else min(base_delay * (2 ** exponent), max_delay)
    return delay + Random().uniform(0, jitter_ratio * delay)


def _matches(text, patterns) -> bool:
    lowered = text.lower()
    return any(pattern in lowered for pattern in patterns)


def _code_for_status(status_code, text) -> str:
    if status_code in {401, 403}:
        return AUTH
    if status_code == 402:
        return QUOTA
    if status_code == 408:
        return TIMEOUT
    if status_code == 429:
        return QUOTA if _matches(text, _BILLING_PATTERNS) else RATE_LIMITED
    if status_code == 413:
        return OVERFLOW
    if status_code == 400:
        return OVERFLOW if _matches(text, _OVERFLOW_PATTERNS) else INVALID_REQUEST
    if 500 <= (status_code or 0) <= 599:
        return SERVER
    return INVALID_REQUEST


def classify_transport(exc) -> NativeModelError:
    """Map a provider HTTP/transport exception to a typed native failure."""
    detail = sanitize(exc)
    status_code = getattr(exc, 'status_code', None)
    if status_code is None:
        match = re.search(r'\bHTTP (\d{3})\b', detail)
        status_code = int(match.group(1)) if match else None
    if status_code is not None:
        retry_after = (parse_retry_after(getattr(exc, 'headers', None))
                       or retry_after_from_text(detail))
        return NativeModelError(_code_for_status(status_code, detail),
                                f'HTTP {status_code}: {detail or "provider error"}',
                                retry_after_seconds=retry_after, status_code=status_code)
    if isinstance(exc, ssl.SSLError) or 'certificate' in detail.lower() or 'ssl' in detail.lower():
        return NativeModelError(TLS, detail or 'TLS failure')
    reason = getattr(exc, 'reason', None)
    reason_text = sanitize(reason) if reason is not None else detail
    if (isinstance(exc, (TimeoutError, asyncio.TimeoutError))
            or 'timeout' in type(exc).__name__.lower()
            or 'timed out' in reason_text.lower()
            or 'timeout' in reason_text.lower()):
        return NativeModelError(TIMEOUT, reason_text or 'timed out')
    return NativeModelError(NETWORK, reason_text or 'network failure')


def classify_response(exc, *, usage=None) -> NativeModelError:
    """Map a response-validation failure to a typed error, preserving usage.

    Truncated and content-filtered replies are not retried here. Eligible visible
    text is carried to the durable application continuation handler. Empty and malformed replies are retried,
    as empty-response and transient-parse handling does.
    """
    text = sanitize(exc)
    lowered = text.lower()
    from homun.models.repetition import RepetitionError
    if isinstance(exc, RepetitionError):
        code = REPETITION
    elif lowered.startswith('incomplete agent response'):
        reason = text.split(':', 1)[-1].strip().lower()
        code = INVALID_REQUEST if 'filter' in reason else TRUNCATED
    elif 'neither tools nor a final answer' in lowered:
        code = EMPTY
    else:
        code = MALFORMED
    error_usage = None
    if usage is not None:
        error_usage = usage.model_copy(update={'status': 'error', 'error_code': code}) \
            if hasattr(usage, 'model_copy') else usage
    from homun.models.truncation import TruncatedTextError
    partial = exc.partial_text if isinstance(exc, TruncatedTextError) else None
    return NativeModelError(code, text, usage=error_usage, partial_text=partial)
