"""Durable same-session idle heartbeats (H26).

and gateway/run_heartbeat_restore.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun maintains idle recurring session heartbeats with human input preemption,
tick coalescing, claim abandon/rewind on unexecuted admission, and strict conversation
boundary isolation across compression and reset.
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional, Tuple

from homun.application.automation_store import load_typed, save_typed

logger = logging.getLogger(__name__)

MIN_INTERVAL_SECONDS = 60
HEARTBEAT_PROMPT_TEMPLATE = (
    "[Heartbeat — recurring instruction, fires every {interval}]\n{prompt}\n\n"
    "If there is nothing meaningful to do or report for this instruction "
    "right now, reply briefly that nothing has changed and stop — do not invent work."
)

_INTERVAL_RE = re.compile(
    r"^\s*(?:every\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s*$",
    re.IGNORECASE,
)

_UNIT_SECONDS = {
    "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
    "d": 86400, "day": 86400, "days": 86400,
}


def parse_interval(text: str, *, min_seconds: int = MIN_INTERVAL_SECONDS) -> Optional[int]:
    """Parse text like '10m', 'every 2h', '30s' into seconds. Returns -1 if below min_seconds."""
    m = _INTERVAL_RE.match(text) if text else None
    if not m:
        return None
    seconds = int(float(m.group(1)) * _UNIT_SECONDS[m.group(2).lower()])
    return -1 if seconds < min_seconds else seconds


def format_interval(seconds: int) -> str:
    """Format seconds into human interval (e.g. 600 -> '10m')."""
    seconds = int(seconds)
    units = ((86400, "d"), (3600, "h"), (60, "m"))
    return next((f"{seconds // unit}{suffix}" for unit, suffix in units if seconds % unit == 0), f"{seconds}s")


@dataclass
class HeartbeatState:
    """Serializable per-session heartbeat."""
    prompt: str
    interval_seconds: int
    status: str = "active"          # active | paused | cleared
    created_at: float = 0.0
    last_fired_at: float = 0.0
    fire_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "HeartbeatState":
        return cls(
            prompt=str(data.get("prompt") or ""),
            interval_seconds=int(data.get("interval_seconds") or 0),
            status=str(data.get("status") or "active"),
            created_at=float(data.get("created_at") or 0.0),
            last_fired_at=float(data.get("last_fired_at") or 0.0),
            fire_count=int(data.get("fire_count") or 0),
        )

    def is_due(self, now: Optional[float] = None) -> bool:
        if self.status != "active" or not self.prompt or self.interval_seconds <= 0:
            return False
        curr = time.time() if now is None else now
        anchor = self.last_fired_at or self.created_at
        return (curr - anchor) >= self.interval_seconds

    def render_prompt(self) -> str:
        return HEARTBEAT_PROMPT_TEMPLATE.format(
            interval=format_interval(self.interval_seconds),
            prompt=self.prompt,
        )


_KIND = "heartbeat"


def load_heartbeat(session_id: str) -> Optional[HeartbeatState]:
    if not session_id:
        return None
    state = load_typed(_KIND, session_id, HeartbeatState.from_dict)
    if state is None or state.status == "cleared":
        return None
    return state


def save_heartbeat(session_id: str, state: HeartbeatState) -> None:
    if not session_id or state is None:
        return
    save_typed(_KIND, session_id, state)


def clear_heartbeat(session_id: str) -> bool:
    if not session_id:
        return False
    state = load_typed(_KIND, session_id, HeartbeatState.from_dict)
    if state is None or state.status == "cleared":
        return False
    state.status = "cleared"
    save_typed(_KIND, session_id, state)
    return True


def migrate_heartbeat_to_session(old_session_id: str, new_session_id: str) -> bool:
    """Carry heartbeat across compression rotation; archive parent row."""
    if not old_session_id or not new_session_id or old_session_id == new_session_id:
        return False
    state = load_heartbeat(old_session_id)
    if state is None or load_heartbeat(new_session_id) is not None:
        return False
    child_state = HeartbeatState.from_dict(state.to_dict())
    save_heartbeat(new_session_id, child_state)
    clear_heartbeat(old_session_id)
    return True


def reset_session_heartbeats(session_id: str) -> None:
    """Clear departing conversation's heartbeat so it never enters a new/replacement conversation."""
    clear_heartbeat(session_id)


class HeartbeatManager:
    """Per-session heartbeat manager."""

    def __init__(self, session_id: str, *, min_seconds: int = MIN_INTERVAL_SECONDS):
        self.session_id = str(session_id)
        self.min_seconds = min_seconds
        self._state: Optional[HeartbeatState] = load_heartbeat(self.session_id)
        self._last_claim: Optional[Tuple[float, int]] = None

    @property
    def state(self) -> Optional[HeartbeatState]:
        return self._state

    def has_heartbeat(self) -> bool:
        return self._state is not None and self._state.status in {"active", "paused"}

    def is_active(self) -> bool:
        return self._state is not None and self._state.status == "active"

    def status_line(self) -> str:
        s = self._state
        if s is None or s.status == "cleared":
            return "No heartbeat set. Set one with /heartbeat every <interval> <prompt>."
        every = format_interval(s.interval_seconds)
        fired = f", fired {s.fire_count}×" if s.fire_count else ""
        if s.status == "active":
            next_in = max(0, int((s.last_fired_at or s.created_at) + s.interval_seconds - time.time()))
            return f"♥ Heartbeat (every {every}, next in ~{next_in}s{fired}): {s.prompt}"
        icon = "⏸ " if s.status == "paused" else ""
        return f"{icon}Heartbeat ({s.status}, every {every}{fired}): {s.prompt}"

    def set(self, prompt: str, interval_seconds: int) -> HeartbeatState:
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("heartbeat prompt is empty")
        interval_seconds = int(interval_seconds)
        if interval_seconds < self.min_seconds:
            raise ValueError(f"interval must be at least {self.min_seconds}s")
        self._state = HeartbeatState(
            prompt=prompt,
            interval_seconds=interval_seconds,
            status="active",
            created_at=time.time(),
        )
        save_heartbeat(self.session_id, self._state)
        return self._state

    def pause(self) -> Optional[HeartbeatState]:
        if not self._state:
            return None
        self._state.status = "paused"
        save_heartbeat(self.session_id, self._state)
        return self._state

    def resume(self) -> Optional[HeartbeatState]:
        if not self._state:
            return None
        self._state.status = "active"
        # Re-anchor so resuming doesn't instantly fire a stale tick
        self._state.last_fired_at = time.time()
        save_heartbeat(self.session_id, self._state)
        return self._state

    def clear(self) -> bool:
        if self._state is None:
            return False
        self._state.status = "cleared"
        save_heartbeat(self.session_id, self._state)
        self._state = None
        return True

    def due_prompt(
        self,
        now: Optional[float] = None,
        *,
        has_pending_user_input: bool = False,
        is_session_busy: bool = False,
    ) -> Optional[str]:
        """Claim a due tick, returning injection prompt or None.

        Human input always takes precedence (if user input is pending or session is busy,
        heartbeat waits).
        Ticks coalesce: anchor resets to NOW, not theoretical schedule.
        Claim is recorded immediately to prevent double-firing.
        """
        if has_pending_user_input or is_session_busy:
            return None
        s = self._state
        if s is None or not s.is_due(now):
            return None
        curr = time.time() if now is None else now
        self._last_claim = (s.last_fired_at, s.fire_count)
        s.last_fired_at = curr
        s.fire_count += 1
        save_heartbeat(self.session_id, s)
        return s.render_prompt()

    def abandon_fire(self) -> bool:
        """Rewind the fire recorded by due_prompt if the turn never started.

        Ensures the tick remains due on the next poll instead of being consumed.
        """
        claim, s = self._last_claim, self._state
        if claim is None or s is None:
            return False
        current = load_heartbeat(self.session_id)
        if current is None or current.status != "active":
            return False
        if (current.last_fired_at, current.fire_count) != (s.last_fired_at, s.fire_count):
            return False
        s.last_fired_at, s.fire_count = claim
        self._last_claim = None
        save_heartbeat(self.session_id, s)
        return True


def find_due_heartbeats(now: Optional[float] = None) -> list[tuple[str, HeartbeatState]]:
    """Scan all stored heartbeats and return active sessions whose heartbeat is due."""
    from homun.application.automation_store import get_automation_store
    items = get_automation_store().list_all(_KIND)
    due: list[tuple[str, HeartbeatState]] = []
    curr = time.time() if now is None else now
    for session_id, data in items:
        try:
            state = HeartbeatState.from_dict(data)
            if state.status == "active" and state.is_due(curr):
                due.append((session_id, state))
        except Exception as exc:
            logger.warning("Failed parsing heartbeat state for %s: %s", session_id, exc)
    return due

