"""Turn lease management: per-session serialization of execution turns (H32).

Derived from Hermes gateway/turn_lease.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun serializes execution turns per session/routing key, ensuring race-free transcript
updates, fail-closed timeouts, and identity-checked releases.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Dict, Optional

from homun.application.gateway_contracts import TurnLeaseToken

logger = logging.getLogger(__name__)

DEFAULT_LEASE_TIMEOUT = 5.0
DEFAULT_MAX_LEASES = 512


class TurnLeaseTimeout(TimeoutError):
    """Raised when turn lease acquisition times out (fail-closed)."""

    def __init__(self, session_id: str, owner_key: str, wait_seconds: float):
        self.session_id = session_id
        self.owner_key = owner_key
        self.wait_seconds = wait_seconds
        super().__init__(
            f"Turn lease wait timed out after {wait_seconds:.1f}s for session {session_id} (owner: {owner_key})"
        )


class _SessionLease:
    def __init__(self):
        self.cond = threading.Condition(threading.Lock())
        self.holder: Optional[TurnLeaseToken] = None
        self.generation = 0
        self.last_used = time.time()
        self.waiters = 0


class TurnLeaseManager:
    """Thread-safe turn lease manager serializing [history -> execute -> flush] turns."""

    def __init__(self, max_leases: int = DEFAULT_MAX_LEASES, default_ttl: float = 30.0):
        self._lock = threading.Lock()
        self._leases: Dict[str, _SessionLease] = {}
        self.max_leases = max_leases
        self.default_ttl = default_ttl

    def acquire(
        self,
        session_id: str,
        owner_key: str,
        *,
        timeout: float = DEFAULT_LEASE_TIMEOUT,
    ) -> TurnLeaseToken:
        """Acquire exclusive execution lease on session_id. Raises TurnLeaseTimeout on timeout."""
        with self._lock:
            if session_id not in self._leases:
                self._evict_idle_if_needed()
                self._leases[session_id] = _SessionLease()
            lease = self._leases[session_id]

        deadline = time.time() + float(timeout)
        with lease.cond:
            lease.waiters += 1
            try:
                while lease.holder is not None:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        raise TurnLeaseTimeout(session_id, owner_key, timeout)
                    lease.cond.wait(remaining)

                # Lease acquired
                lease.generation += 1
                token = TurnLeaseToken(
                    session_id=session_id,
                    owner_key=owner_key,
                    generation=lease.generation,
                    acquired_at=time.time(),
                    released=False,
                )
                lease.holder = token
                lease.last_used = time.time()
                return token
            finally:
                lease.waiters -= 1

    def release(self, token: TurnLeaseToken) -> bool:
        """Release held lease if token generation matches."""
        if not token or token.released:
            return False

        with self._lock:
            lease = self._leases.get(token.session_id)
            if not lease:
                return False

        with lease.cond:
            if lease.holder and lease.holder.generation == token.generation:
                token.released = True
                lease.holder = None
                lease.last_used = time.time()
                lease.cond.notify()
                return True
        return False

    def is_locked(self, session_id: str) -> bool:
        with self._lock:
            lease = self._leases.get(session_id)
            if not lease:
                return False
            with lease.cond:
                return lease.holder is not None

    def _evict_idle_if_needed(self) -> None:
        if len(self._leases) < self.max_leases:
            return
        # Evict oldest idle lease
        candidates = [
            (sid, l.last_used)
            for sid, l in self._leases.items()
            if l.holder is None and l.waiters == 0
        ]
        if candidates:
            candidates.sort(key=lambda c: c[1])
            oldest_sid = candidates[0][0]
            self._leases.pop(oldest_sid, None)

    def reset(self) -> None:
        with self._lock:
            self._leases.clear()
