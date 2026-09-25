"""Multi-credential pool for same-provider failover and rate-limit rotation (H38).

Maintains multiple credentials per provider, rotates healthy keys, tracks cooldowns
for rate-limits (429/quota), and marks dead revoked tokens.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import logging
import threading
import time
from typing import Dict, List, Optional
from uuid import uuid4

logger = logging.getLogger(__name__)

STATUS_OK = "ok"
STATUS_COOLDOWN = "cooldown"
STATUS_DEAD = "dead"

_TERMINAL_AUTH_ERRORS = frozenset({
    "token_invalidated",
    "token_revoked",
    "invalid_token",
    "invalid_api_key",
    "unauthorized",
    "401",
})


@dataclass
class PooledCredential:
    """A single managed credential within the pool."""

    key_id: str
    provider: str
    secret_value: str
    status: str = STATUS_OK
    cooldown_until: float = 0.0
    usage_count: int = 0
    error_count: int = 0
    last_used_at: float = 0.0
    last_error: Optional[str] = None

    @property
    def is_available(self) -> bool:
        """True if the credential is not dead and any cooldown period has expired."""
        if self.status == STATUS_DEAD:
            return False
        if self.status == STATUS_COOLDOWN:
            return time.time() >= self.cooldown_until
        return True

    def masked_value(self) -> str:
        """Safe display string concealing secrets."""
        if len(self.secret_value) <= 8:
            return "********"
        return f"{self.secret_value[:4]}...{self.secret_value[-4:]}"


class CredentialPool:
    """Thread-safe multi-credential pool per provider."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pools: Dict[str, List[PooledCredential]] = {}
        self._rotation_index: Dict[str, int] = {}

    def add_credential(
        self, provider: str, secret_value: str, key_id: Optional[str] = None
    ) -> PooledCredential:
        """Add a new credential to the provider's pool."""
        norm_provider = provider.lower()
        kid = key_id or f"cred_{uuid4().hex[:8]}"

        with self._lock:
            pool = self._pools.setdefault(norm_provider, [])
            # Avoid duplicate secret values
            for existing in pool:
                if existing.secret_value == secret_value:
                    return existing

            cred = PooledCredential(
                key_id=kid,
                provider=norm_provider,
                secret_value=secret_value,
            )
            pool.append(cred)
            return cred

    def acquire_credential(self, provider: str) -> Optional[PooledCredential]:
        """Acquire the next available healthy credential using round-robin rotation.

        Automatically resets expired cooldowns. Returns None if all credentials are
        exhausted or dead.
        """
        norm_provider = provider.lower()
        now = time.time()

        with self._lock:
            pool = self._pools.get(norm_provider, [])
            if not pool:
                return None

            # Reset expired cooldowns
            for cred in pool:
                if cred.status == STATUS_COOLDOWN and now >= cred.cooldown_until:
                    cred.status = STATUS_OK

            # Available credentials
            available = [c for c in pool if c.is_available]
            if not available:
                logger.warning("No available credentials for provider '%s' (all in cooldown or dead)", norm_provider)
                return None

            # Round-robin selection
            idx = self._rotation_index.get(norm_provider, 0) % len(available)
            chosen = available[idx]
            self._rotation_index[norm_provider] = (idx + 1) % len(available)

            chosen.usage_count += 1
            chosen.last_used_at = now
            return chosen

    def report_success(self, provider: str, key_id: str) -> None:
        """Record a successful API invocation with this credential."""
        norm_provider = provider.lower()
        with self._lock:
            for cred in self._pools.get(norm_provider, []):
                if cred.key_id == key_id:
                    cred.status = STATUS_OK
                    cred.last_error = None
                    return

    def report_failure(
        self, provider: str, key_id: str, error_type: str, cooldown_seconds: float = 60.0
    ) -> None:
        """Record an error and put the credential into cooldown or mark it dead."""
        norm_provider = provider.lower()
        err_lower = error_type.lower()
        now = time.time()

        with self._lock:
            for cred in self._pools.get(norm_provider, []):
                if cred.key_id == key_id:
                    cred.error_count += 1
                    cred.last_error = error_type

                    if any(term in err_lower for term in _TERMINAL_AUTH_ERRORS):
                        cred.status = STATUS_DEAD
                        logger.error("Credential %s for %s marked DEAD: %s", key_id, norm_provider, error_type)
                    else:
                        cred.status = STATUS_COOLDOWN
                        cred.cooldown_until = now + cooldown_seconds
                        logger.info("Credential %s for %s entered cooldown until %s: %s", key_id, norm_provider, cred.cooldown_until, error_type)
                    return

    def list_credentials(self, provider: Optional[str] = None) -> List[PooledCredential]:
        """List credentials, optionally filtered by provider."""
        with self._lock:
            if provider:
                return list(self._pools.get(provider.lower(), []))
            return [c for pool in self._pools.values() for c in pool]

    def clear(self) -> None:
        """Clear all pools."""
        with self._lock:
            self._pools.clear()
            self._rotation_index.clear()


_GLOBAL_CREDENTIAL_POOL: Optional[CredentialPool] = None


def get_credential_pool() -> CredentialPool:
    global _GLOBAL_CREDENTIAL_POOL
    if _GLOBAL_CREDENTIAL_POOL is None:
        _GLOBAL_CREDENTIAL_POOL = CredentialPool()
    return _GLOBAL_CREDENTIAL_POOL


def reset_credential_pool() -> None:
    global _GLOBAL_CREDENTIAL_POOL
    _GLOBAL_CREDENTIAL_POOL = None
