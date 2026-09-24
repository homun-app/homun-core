"""Gateway DM pairing and authorization management (H32).

Derived from Hermes gateway/pairing.py and gateway/authz_mixin.py
at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun manages code-based DM pairing following NIST SP 800-63-4 / OWASP principles:
8-character unambiguous codes, 1-hour expiry, rate limiting, failed attempt lockout,
and operator approval allowlisting.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from homun.application.gateway_contracts import PairingRequest
from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
CODE_TTL_SECONDS = 3600.0             # 1 hour
RATE_LIMIT_SECONDS = 600.0            # 1 request per 10 min
LOCKOUT_SECONDS = 3600.0              # 1 hour lockout after 5 failures
MAX_PENDING_PER_PLATFORM = 3
MAX_FAILED_ATTEMPTS = 5


def generate_pairing_code() -> str:
    """Generate 8-character cryptographic unambiguous pairing code."""
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))


class GatewayPairingManager:
    """Manager for platform pairing requests, code validation, and allowlist authorization."""

    def __init__(
        self,
        workspace_id: str = "default",
        *,
        code_ttl_seconds: float = CODE_TTL_SECONDS,
        rate_limit_seconds: float = RATE_LIMIT_SECONDS,
        lockout_seconds: float = LOCKOUT_SECONDS,
        max_pending_per_platform: int = MAX_PENDING_PER_PLATFORM,
        max_pending_per_user: Optional[int] = None,
        max_failed_attempts: int = MAX_FAILED_ATTEMPTS,
        max_verification_failures: Optional[int] = None,
        allowlist_users: Optional[Set[str]] = None,
        denylist_users: Optional[Set[str]] = None,
        db_path: Optional[str | Path] = None,
    ):
        self.workspace_id = workspace_id
        self.code_ttl_seconds = code_ttl_seconds
        self.rate_limit_seconds = rate_limit_seconds
        self.lockout_seconds = lockout_seconds
        self.max_pending_per_platform = max_pending_per_user if max_pending_per_user is not None else max_pending_per_platform
        self.max_failed_attempts = max_verification_failures or max_failed_attempts
        self._denylist_users: Set[str] = set(denylist_users or [])

        self._pairing: Dict[str, PairingRequest] = {}
        self._user_requests: Dict[Tuple[str, str], float] = {}
        self._failed_attempts: Dict[Tuple[str, str], int] = {}
        self._lockouts: Dict[Tuple[str, str], float] = {}
        self._allowed_users: Dict[str, Set[str]] = {}
        self._global_failures: int = 0

        if allowlist_users:
            for item in allowlist_users:
                if ":" in item:
                    plat, uid = item.split(":", 1)
                    self._allowed_users.setdefault(plat.strip().lower(), set()).add(uid.strip())
                else:
                    self._allowed_users.setdefault("generic", set()).add(item.strip())

        if db_path is None:
            override = os.environ.get("HOMUN_PAIRING_DB")
            if override:
                db_path = override
            else:
                root = default_data_dir() / "gateway"
                root.mkdir(parents=True, exist_ok=True)
                db_path = root / f"pairing-{self.workspace_id}.sqlite"
        self._db_path = str(db_path)
        self._db_lock = threading.RLock()
        if self._db_path != ":memory:":
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        if self._db_path != ":memory:":
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pairing_kv (
                kind TEXT NOT NULL,
                key TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (kind, key)
            )
            """
        )
        self._conn.commit()
        self._load()

    def _put(self, kind: str, key: str, payload: Dict[str, Any]) -> None:
        with self._db_lock:
            self._conn.execute(
                """
                INSERT INTO pairing_kv(kind, key, payload, updated_at)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(kind, key) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (kind, key, json.dumps(payload, ensure_ascii=False, sort_keys=True), time.time()),
            )
            self._conn.commit()

    def _delete(self, kind: str, key: str) -> None:
        with self._db_lock:
            self._conn.execute(
                "DELETE FROM pairing_kv WHERE kind = ? AND key = ?",
                (kind, key),
            )
            self._conn.commit()

    def _persist_all(self) -> None:
        """Rewrite durable allowlist/lockout/rate state (codes persist individually)."""
        with self._db_lock:
            self._conn.execute("DELETE FROM pairing_kv WHERE kind IN ('allow','deny','lockout','rate','fail','meta')")
            for plat, users in self._allowed_users.items():
                self._conn.execute(
                    "INSERT INTO pairing_kv(kind, key, payload, updated_at) VALUES(?, ?, ?, ?)",
                    ("allow", plat, json.dumps(sorted(users)), time.time()),
                )
            if self._denylist_users:
                self._conn.execute(
                    "INSERT INTO pairing_kv(kind, key, payload, updated_at) VALUES(?, ?, ?, ?)",
                    ("deny", "users", json.dumps(sorted(self._denylist_users)), time.time()),
                )
            for (plat, uid), until in self._lockouts.items():
                self._conn.execute(
                    "INSERT INTO pairing_kv(kind, key, payload, updated_at) VALUES(?, ?, ?, ?)",
                    ("lockout", f"{plat}|{uid}", json.dumps({"until": until}), time.time()),
                )
            for (plat, uid), ts in self._user_requests.items():
                self._conn.execute(
                    "INSERT INTO pairing_kv(kind, key, payload, updated_at) VALUES(?, ?, ?, ?)",
                    ("rate", f"{plat}|{uid}", json.dumps({"at": ts}), time.time()),
                )
            for (plat, uid), n in self._failed_attempts.items():
                self._conn.execute(
                    "INSERT INTO pairing_kv(kind, key, payload, updated_at) VALUES(?, ?, ?, ?)",
                    ("fail", f"{plat}|{uid}", json.dumps({"n": n}), time.time()),
                )
            self._conn.execute(
                "INSERT INTO pairing_kv(kind, key, payload, updated_at) VALUES(?, ?, ?, ?)",
                ("meta", "global_failures", json.dumps({"n": self._global_failures}), time.time()),
            )
            self._conn.commit()

    def _persist_request(self, req: PairingRequest) -> None:
        self._put("code", req.code, req.to_dict())

    def _load(self) -> None:
        rows = self._conn.execute("SELECT kind, key, payload FROM pairing_kv").fetchall()
        for kind, key, payload in rows:
            try:
                data = json.loads(payload)
            except Exception:
                continue
            if kind == "code" and isinstance(data, dict):
                req = PairingRequest.from_dict(data)
                self._pairing[req.code] = req
            elif kind == "allow" and isinstance(data, list):
                self._allowed_users[key] = set(str(u) for u in data)
            elif kind == "deny" and isinstance(data, list):
                self._denylist_users |= set(str(u) for u in data)
            elif kind == "lockout" and isinstance(data, dict) and "|" in key:
                plat, uid = key.split("|", 1)
                self._lockouts[(plat, uid)] = float(data.get("until") or 0)
            elif kind == "rate" and isinstance(data, dict) and "|" in key:
                plat, uid = key.split("|", 1)
                self._user_requests[(plat, uid)] = float(data.get("at") or 0)
            elif kind == "fail" and isinstance(data, dict) and "|" in key:
                plat, uid = key.split("|", 1)
                self._failed_attempts[(plat, uid)] = int(data.get("n") or 0)
            elif kind == "meta" and key == "global_failures" and isinstance(data, dict):
                self._global_failures = int(data.get("n") or 0)

    def get_request_by_code(self, code: str, *, now: Optional[float] = None) -> Optional[PairingRequest]:
        curr = time.time() if now is None else float(now)
        req = self._pairing.get(code.strip().upper())
        if req and curr <= req.expires_at:
            return req
        return None

    def request_pairing(
        self,
        platform: str,
        user_id: str,
        *,
        username: Optional[str] = None,
        now: Optional[float] = None,
    ) -> PairingRequest:
        curr = time.time() if now is None else float(now)
        plat = platform.strip().lower()
        uid = user_id.strip()
        key = (plat, uid)

        # Check blocked user
        if f"{plat}:{uid}" in self._denylist_users or uid in self._denylist_users:
            raise ValueError("User is blocked from requesting pairing")

        # 1. Check lockout
        if locked_until := self._lockouts.get(key):
            if curr < locked_until:
                remaining = int(locked_until - curr)
                raise ValueError(f"User is locked out due to failed attempts. Try again in {remaining}s")
            else:
                self._lockouts.pop(key, None)
                self._failed_attempts.pop(key, None)

        # 2. Check if already authorized
        if self.is_user_authorized(plat, uid):
            raise ValueError(f"User {uid} is already authorized on {plat}")

        # 3. Rate limiting
        if last_req := self._user_requests.get(key):
            if curr - last_req < self.rate_limit_seconds:
                wait_sec = max(1, int(self.rate_limit_seconds - (curr - last_req)))
                raise ValueError(f"Please wait {wait_sec}s before requesting a new code.")

        # 4. Check max pending for this platform
        active_pending = [
            p for p in self._pairing.values()
            if p.platform == plat and p.status == "pending" and p.expires_at > curr
        ]
        if len(active_pending) >= self.max_pending_per_platform:
            raise ValueError(f"Maximum pending pairing codes ({self.max_pending_per_platform}) reached for {plat}")

        # 5. Generate code and create record
        code = generate_pairing_code()
        while code in self._pairing:
            code = generate_pairing_code()

        req = PairingRequest(
            code=code,
            platform=plat,
            user_id=uid,
            username=username.strip() if username else None,
            created_at=curr,
            expires_at=curr + self.code_ttl_seconds,
            status="pending",
        )
        self._pairing[code] = req
        self._user_requests[key] = curr
        self._persist_request(req)
        self._persist_all()
        return req

    def approve_code(
        self,
        code: str,
        *,
        approved_by: str = "operator",
        now: Optional[float] = None,
    ) -> PairingRequest:
        curr = time.time() if now is None else float(now)
        if self._global_failures >= self.max_failed_attempts:
            raise ValueError("Too many failed attempts. Operator console temporarily locked out.")

        clean_code = code.strip().upper()
        req = self._pairing.get(clean_code)

        if not req or curr > req.expires_at:
            self._global_failures += 1
            if req and curr > req.expires_at:
                req.status = "expired"
            raise ValueError("Invalid or expired pairing code")

        key = (req.platform, req.user_id)

        if req.status != "pending":
            raise ValueError(f"Pairing code is not pending (status: {req.status})")

        # Approval succeeds: grant allowlist access
        req.status = "approved"
        req.approved_by = approved_by
        req.approved_at = curr

        # Clear failed attempts
        self._failed_attempts.pop(key, None)
        self._allowed_users.setdefault(req.platform, set()).add(req.user_id)
        self._global_failures = 0
        self._persist_request(req)
        self._persist_all()
        return req

    def decline_code(self, code: str, *, now: Optional[float] = None) -> PairingRequest:
        curr = time.time() if now is None else float(now)
        clean_code = code.strip().upper()
        req = self._pairing.get(clean_code)

        if not req:
            raise ValueError(f"Invalid pairing code: {code}")

        key = (req.platform, req.user_id)
        req.status = "declined"
        req.failed_attempts += 1

        # Track failure & potential lockout
        fails = self._failed_attempts.get(key, 0) + 1
        self._failed_attempts[key] = fails
        if fails >= self.max_failed_attempts:
            self._lockouts[key] = curr + self.lockout_seconds

        self._persist_request(req)
        self._persist_all()
        return req

    def revoke_user(self, platform: str, user_id: str) -> bool:
        plat = platform.strip().lower()
        uid = user_id.strip()
        allowed = self._allowed_users.get(plat)
        if allowed and uid in allowed:
            allowed.remove(uid)
            self._persist_all()
            return True
        return False

    def is_user_authorized(self, platform: str, user_id: str) -> bool:
        plat = platform.strip().lower()
        uid = user_id.strip()
        if f"{plat}:{uid}" in self._denylist_users or uid in self._denylist_users:
            return False
        allowed = self._allowed_users.get(plat, set())
        return uid in allowed

    def list_pairing_requests(
        self,
        platform: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[PairingRequest]:
        reqs = list(self._pairing.values())
        if platform:
            plat = platform.strip().lower()
            reqs = [r for r in reqs if r.platform == plat]
        if status:
            st = status.strip().lower()
            reqs = [r for r in reqs if r.status == st]
        return reqs



_GLOBAL_PAIRING: Optional[GatewayPairingManager] = None
_GLOBAL_LOCK = threading.Lock()


def get_gateway_pairing_manager(workspace_id: str = "default") -> GatewayPairingManager:
    global _GLOBAL_PAIRING
    with _GLOBAL_LOCK:
        if _GLOBAL_PAIRING is None or _GLOBAL_PAIRING.workspace_id != workspace_id:
            _GLOBAL_PAIRING = GatewayPairingManager(workspace_id=workspace_id)
        return _GLOBAL_PAIRING


def set_gateway_pairing_manager(manager: Optional[GatewayPairingManager]) -> None:
    global _GLOBAL_PAIRING
    with _GLOBAL_LOCK:
        _GLOBAL_PAIRING = manager
