"""Proactive execution loops with fixed and self-paced cadence and goal precedence (H27).

Derived from Hermes hermes_cli/loops.py and cli_loops_mixin.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun supports recurring proactive execution loops with self-paced exponential backoff,
stop markers (LOOP_COMPLETE), count caps (--times), evidence-based stop conditions (--until),
and strict goal precedence: active running goals defer loop ticks, while waiting/parked
goals permit loop ticks to proceed.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, Optional, Tuple

from homun.application.automation_store import load_typed, save_typed

logger = logging.getLogger(__name__)

DEFAULT_MIN_INTERVAL_SECONDS = 30
DEFAULT_MAX_TICKS = 100
DEFAULT_SELF_PACED_FLOOR_SECONDS = 60
DEFAULT_SELF_PACED_CEILING_SECONDS = 15 * 60

LOOP_COMPLETE_MARKER = "LOOP_COMPLETE"
_LOOP_COMPLETE_RE = re.compile(
    r"(?im)^\s*" + re.escape(LOOP_COMPLETE_MARKER) + r"\s*[.!]?\s*$"
)

_INTERVAL_TOKEN_RE = re.compile(
    r"^(?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$", re.IGNORECASE
)

WAKEUP_PROMPT_TEMPLATE = (
    "[/loop wakeup #{tick}{cadence}]\n"
    "Recurring task: {prompt}\n\n"
    "This is an automatic wakeup from the /loop the user set. Perform the "
    "task now against the CURRENT state (re-check files, processes, or "
    "services fresh — do not assume anything from earlier iterations still "
    "holds). Report concisely what you found or did this iteration.\n"
    "If the task is now complete, no longer applicable, or the thing you "
    "were watching has finished, say so and end your reply with "
    f"{LOOP_COMPLETE_MARKER} on its own line — that stops the loop."
)

WAKEUP_PROMPT_WITH_UNTIL_TEMPLATE = (
    "[/loop wakeup #{tick}{cadence}]\n"
    "Recurring task: {prompt}\n\n"
    "Stop condition: {until}\n\n"
    "This is an automatic wakeup from the /loop the user set. Perform the "
    "task now against the CURRENT state (re-check files, processes, or "
    "services fresh — do not assume anything from earlier iterations still "
    "holds). Report concisely what you found or did this iteration, and "
    "show concrete evidence of the stop condition's status.\n"
    "If the stop condition is met, or the task is no longer applicable, say "
    f"so and end your reply with {LOOP_COMPLETE_MARKER} on its own line — "
    "that stops the loop."
)


def parse_interval_token(token: str) -> Optional[int]:
    """Parse token like '30s', '5m', '2h', '1h30m' into seconds."""
    m = _INTERVAL_TOKEN_RE.match(token.strip()) if token else None
    if not m:
        return None
    h, mnt, s = (int(g) if g else 0 for g in m.groups())
    total = h * 3600 + mnt * 60 + s
    return total if total > 0 else None


def parse_loop_args(text: str) -> Dict[str, Any]:
    """Parse command text into loop parameters.

    Returns dict with interval_seconds (None = self-paced), prompt, times, until, error.
    """
    raw = (text or "").strip()
    result: Dict[str, Any] = {"interval_seconds": None, "prompt": "", "times": 0, "until": "", "error": None}
    if not raw:
        return {**result, "error": "empty"}

    times = 0
    m_times = re.search(r"\s--times\s+(\S+)", raw)
    if m_times:
        try:
            times = int(m_times.group(1))
            if times < 1:
                raise ValueError
        except ValueError:
            return {**result, "error": f"--times expects a positive integer, got {m_times.group(1)!r}"}
        raw = (raw[: m_times.start()] + raw[m_times.end():]).strip()

    until = ""
    m_until = re.search(r"\s--until\s+(.+)$", raw, re.DOTALL)
    if m_until:
        until = m_until.group(1).strip()
        raw = raw[: m_until.start()].strip()

    tokens = raw.split(None, 1)
    if tokens and tokens[0].lower() == "every" and len(tokens) > 1:
        raw = tokens[1]
        tokens = raw.split(None, 1)

    interval = parse_interval_token(tokens[0]) if tokens else None
    if interval is not None:
        raw = tokens[1].strip() if len(tokens) > 1 else ""

    if not raw:
        return {**result, "error": "missing prompt"}
    return {**result, "interval_seconds": interval, "prompt": raw, "times": times, "until": until}


def format_interval(seconds: float) -> str:
    h, rem = divmod(int(max(0, round(seconds))), 3600)
    m, s = divmod(rem, 60)
    parts = [f"{h}h"] if h else []
    if m:
        parts.append(f"{m}m")
    if s or not parts:
        parts.append(f"{s}s")
    return "".join(parts)


def response_signals_complete(response: str) -> bool:
    """True when response ends with LOOP_COMPLETE marker on its own line."""
    return bool(response) and _LOOP_COMPLETE_RE.search(response) is not None


def _digest_response(response: str) -> str:
    """Digest for self-paced backoff; strips timestamps and durations to prevent trivial drift."""
    text = (response or "").strip().lower()
    text = re.sub(r"\d{1,2}:\d{2}(:\d{2})?", "", text)
    text = re.sub(r"\d{4}-\d{2}-\d{2}", "", text)
    text = re.sub(r"\b\d+(\.\d+)?\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b", "", text)
    text = re.sub(r"\s+", " ", text)
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


@dataclass
class LoopState:
    """Serializable per-session loop state."""
    prompt: str
    status: str = "active"            # active | paused | done | cleared
    mode: str = "interval"            # interval | self_paced
    interval_seconds: float = 0.0
    current_delay: float = 0.0
    times: int = 0                    # user cap (--times N)
    until: str = ""                   # stop condition (--until condition)
    max_ticks: int = DEFAULT_MAX_TICKS
    ticks_fired: int = 0
    created_at: float = 0.0
    last_fired_at: float = 0.0
    next_due_at: float = 0.0
    awaiting_response: bool = False
    last_response_digest: str = ""
    paused_reason: Optional[str] = None
    last_stop_reason: Optional[str] = None
    route: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LoopState":
        return cls(
            prompt=str(data.get("prompt") or ""),
            status=str(data.get("status") or "active"),
            mode=str(data.get("mode") or "interval"),
            interval_seconds=float(data.get("interval_seconds") or 0.0),
            current_delay=float(data.get("current_delay") or 0.0),
            times=int(data.get("times") or 0),
            until=str(data.get("until") or ""),
            max_ticks=int(data.get("max_ticks") or DEFAULT_MAX_TICKS),
            ticks_fired=int(data.get("ticks_fired") or 0),
            created_at=float(data.get("created_at") or 0.0),
            last_fired_at=float(data.get("last_fired_at") or 0.0),
            next_due_at=float(data.get("next_due_at") or 0.0),
            awaiting_response=bool(data.get("awaiting_response") or False),
            last_response_digest=str(data.get("last_response_digest") or ""),
            paused_reason=data.get("paused_reason"),
            last_stop_reason=data.get("last_stop_reason"),
            route=dict(data.get("route") or {}),
        )

    def cadence_label(self) -> str:
        if self.mode == "self_paced":
            live = f", currently {format_interval(self.current_delay)}" if self.current_delay else ""
            return f"self-paced{live}"
        return f"every {format_interval(self.interval_seconds)}"


_KIND = "loop"


def load_loop(session_id: str) -> Optional[LoopState]:
    if not session_id:
        return None
    state = load_typed(_KIND, session_id, LoopState.from_dict)
    if state is None or state.status == "cleared":
        return None
    return state


def save_loop(session_id: str, state: LoopState) -> None:
    if not session_id or state is None:
        return
    save_typed(_KIND, session_id, state)


def clear_loop(session_id: str) -> bool:
    if not session_id:
        return False
    state = load_typed(_KIND, session_id, LoopState.from_dict)
    if state is None or state.status == "cleared":
        return False
    state.status = "cleared"
    save_typed(_KIND, session_id, state)
    return True


def migrate_loop_to_session(old_session_id: str, new_session_id: str) -> bool:
    """Carry loop across compression rotation."""
    if not old_session_id or not new_session_id or old_session_id == new_session_id:
        return False
    state = load_loop(old_session_id)
    if state is None or load_loop(new_session_id) is not None:
        return False
    child_state = LoopState.from_dict(state.to_dict())
    save_loop(new_session_id, child_state)
    clear_loop(old_session_id)
    return True


def goal_blocks_loop_tick(goal_manager: Any) -> bool:
    """True when an ACTIVE, non-waiting goal defers this session's loop tick.

    An active, unparked goal takes precedence to prevent burning its turn budget with loop turns.
    Waiting (parked) goals, paused goals, or finished goals permit loop execution!
    """
    if goal_manager is None:
        return False
    try:
        return bool(goal_manager.is_active() and not goal_manager.is_waiting())
    except Exception:
        return False


class LoopManager:
    """Per-session loop state and tick lifecycle."""

    def __init__(self, session_id: str, *, min_interval: int = DEFAULT_MIN_INTERVAL_SECONDS):
        self.session_id = str(session_id)
        self.min_interval = min_interval
        self._state: Optional[LoopState] = load_loop(self.session_id)

    @property
    def state(self) -> Optional[LoopState]:
        return self._state

    def is_active(self) -> bool:
        return self._state is not None and self._state.status == "active"

    def has_loop(self) -> bool:
        return self._state is not None and self._state.status in {"active", "paused"}

    def _save(self) -> LoopState:
        save_loop(self.session_id, self._state)
        return self._state

    def status_line(self) -> str:
        s = self._state
        if s is None or s.status == "cleared":
            return "No loop set. Start one with /loop [interval] <prompt>."
        runs_txt = f"{s.ticks_fired}/{s.times} runs" if s.times else f"{s.ticks_fired}/{s.max_ticks} budget"
        until_txt = f", until: {s.until}" if s.until else ""
        meta = f"{s.cadence_label()}, {runs_txt}{until_txt}"
        if s.status == "active":
            return f"↻ Loop (active, {meta}): {s.prompt}"
        if s.status == "paused":
            return f"⏸ Loop (paused, {meta}): {s.prompt}"
        if s.status == "done":
            return f"✓ Loop finished ({s.ticks_fired} ticks): {s.prompt}"
        return f"Loop ({s.status}, {meta}): {s.prompt}"

    def set(
        self,
        prompt: str,
        *,
        interval_seconds: Optional[int] = None,
        times: int = 0,
        until: str = "",
        max_ticks: int = DEFAULT_MAX_TICKS,
        route: Optional[Dict[str, str]] = None,
        now: Optional[float] = None,
    ) -> LoopState:
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("loop prompt is empty")
        curr = time.time() if now is None else float(now)
        self_paced = interval_seconds is None
        interval = 0.0 if self_paced else float(max(int(interval_seconds), self.min_interval))
        self._state = LoopState(
            prompt=prompt,
            mode="self_paced" if self_paced else "interval",
            interval_seconds=interval,
            current_delay=float(DEFAULT_SELF_PACED_FLOOR_SECONDS) if self_paced else interval,
            times=max(0, int(times or 0)),
            until=(until or "").strip(),
            max_ticks=int(max_ticks or DEFAULT_MAX_TICKS),
            created_at=curr,
            next_due_at=curr,
            route=dict(route or {}),
        )
        return self._save()

    def pause(self, reason: str = "user-paused") -> Optional[LoopState]:
        s = self._state
        if not s or s.status not in {"active", "paused"}:
            return None
        s.status, s.paused_reason, s.awaiting_response = "paused", reason, False
        return self._save()

    def resume(self) -> Optional[LoopState]:
        s = self._state
        if not s or s.status == "cleared":
            return None
        s.status, s.paused_reason, s.awaiting_response = "active", None, False
        delay = s.current_delay or s.interval_seconds or DEFAULT_SELF_PACED_FLOOR_SECONDS
        s.next_due_at = time.time() + min(delay, 5.0)
        return self._save()

    def clear(self) -> bool:
        if self._state is None or self._state.status == "cleared":
            return False
        self._state.status = "cleared"
        self._save()
        self._state = None
        return True

    def is_due(self, now: Optional[float] = None, *, goal_manager: Any = None) -> bool:
        s = self._state
        if s is None or s.status != "active" or s.awaiting_response:
            return False
        if goal_blocks_loop_tick(goal_manager):
            # Deferred by active running goal
            return False
        curr = time.time() if now is None else now
        return curr >= s.next_due_at

    def fire_tick(self, *, goal_manager: Any = None, now: Optional[float] = None) -> Optional[str]:
        if not self.is_due(now=now, goal_manager=goal_manager):
            return None
        s = self._state
        curr = time.time() if now is None else float(now)
        s.ticks_fired += 1
        s.last_fired_at = curr
        s.awaiting_response = True
        s.next_due_at = s.last_fired_at + (s.current_delay or s.interval_seconds or DEFAULT_SELF_PACED_FLOOR_SECONDS)
        self._save()

        if s.prompt.lstrip().startswith("/"):
            return s.prompt.strip()
        cadence = f", {s.cadence_label()}" if s.mode == "interval" else ", self-paced"
        template = WAKEUP_PROMPT_WITH_UNTIL_TEMPLATE if s.until else WAKEUP_PROMPT_TEMPLATE
        return template.format(tick=s.ticks_fired, cadence=cadence, prompt=s.prompt, until=s.until)

    def abandon_tick(self) -> None:
        s = self._state
        if s is None or not s.awaiting_response:
            return
        s.awaiting_response = False
        s.ticks_fired = max(0, s.ticks_fired - 1)
        self._save()

    def _stop(self, status: str, reason: str, message: str) -> Dict[str, Any]:
        s = self._state
        s.status = status
        if status == "done":
            s.last_stop_reason = reason
        else:
            s.paused_reason = reason
        self._save()
        return {"status": status, "stopped": True, "reason": reason, "message": message}

    def complete_tick(
        self,
        last_response: str,
        *,
        until_judge: Optional[Callable[[str, str], Tuple[str, str]]] = None,
        now: Optional[float] = None,
    ) -> Dict[str, Any]:
        s = self._state
        if s is None or not s.awaiting_response:
            return {"status": s.status if s else None, "stopped": False, "reason": "no tick in flight", "message": ""}
        s.awaiting_response = False
        curr = time.time() if now is None else float(now)

        # 1. Agent self-stop marker
        if response_signals_complete(last_response):
            return self._stop("done", "agent signaled complete", f"✓ Loop finished after {s.ticks_fired} ticks — complete.")

        # 2. Evidence-based until judge
        if s.until and (last_response or "").strip():
            if until_judge is not None:
                try:
                    verdict, reason = until_judge(s.until, last_response)
                except Exception as exc:
                    verdict, reason = "continue", f"judge exception: {exc}"
            else:
                verdict, reason = "continue", "default judge"

            if verdict == "done":
                return self._stop("done", f"stop condition met: {reason}", f"✓ Loop finished after {s.ticks_fired} ticks — {reason}")
            if verdict == "blocked":
                return self._stop("paused", f"stop condition unachievable: {reason}", f"⏸ Loop paused — unachievable: {reason}")

        # 3. User requested times cap
        if s.times and s.ticks_fired >= s.times:
            return self._stop("done", f"completed {s.times} runs", f"✓ Loop finished — ran {s.times} times.")

        # 4. Max ticks budget
        if s.max_ticks and s.ticks_fired >= s.max_ticks:
            return self._stop("paused", f"tick budget exhausted ({s.ticks_fired}/{s.max_ticks})", f"⏸ Loop paused — tick budget exhausted.")

        # 5. Continue looping: cadence adjustment
        if s.mode == "self_paced":
            digest = _digest_response(last_response)
            floor = DEFAULT_SELF_PACED_FLOOR_SECONDS
            if digest and digest == s.last_response_digest:
                s.current_delay = min(max(s.current_delay, floor) * 2, DEFAULT_SELF_PACED_CEILING_SECONDS)
            else:
                s.current_delay = float(floor)
            s.last_response_digest = digest
        else:
            s.current_delay = s.interval_seconds

        s.next_due_at = curr + s.current_delay
        self._save()
        return {"status": "active", "stopped": False, "reason": "loop continues", "message": ""}
