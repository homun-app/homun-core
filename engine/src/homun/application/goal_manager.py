"""GoalManager: lifecycle, quality gates, wait barriers, and continuation judging for persistent goals (H25).

Homun manages multi-turn goals with deterministic gate evaluation, wait barriers
on background processes or sessions, fail-open auxiliary judging, and budget backstops
without mutating the system prompt or creating implicit Kanban cards.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from homun.application.goal_contracts import (
    CONTINUATION_PROMPT_GATE_FAILED_TEMPLATE,
    CONTINUATION_PROMPT_TEMPLATE,
    CONTINUATION_PROMPT_WITH_CONTRACT_TEMPLATE,
    CONTINUATION_PROMPT_WITH_SUBGOALS_TEMPLATE,
    DEFAULT_GATE_MAX_RETRIES,
    DEFAULT_MAX_TURNS,
    GoalContract,
    GoalGate,
    GoalGateAddArguments,
    GoalState,
    _MAX_BARRIER_WAIT_S,
    run_gate,
)
from homun.application.goal_store import get_goal_store

logger = logging.getLogger(__name__)

DEFAULT_JUDGE_TIMEOUT = 30.0
DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES = 3
DEFAULT_MAX_CONSECUTIVE_TRANSPORT_FAILURES = 5


def load_goal(session_id: str) -> Optional[GoalState]:
    """Load the goal state for a given session from durable storage."""
    if not session_id:
        return None
    return get_goal_store().get(session_id)


def save_goal(session_id: str, state: GoalState) -> None:
    """Persist the goal state for a given session."""
    if not session_id or state is None:
        return
    get_goal_store().put(session_id, state)


def clear_goal(session_id: str) -> None:
    """Mark goal cleared and persist for a given session."""
    if not session_id:
        return
    store = get_goal_store()
    state = store.get(session_id)
    if state is not None:
        state.status = "cleared"
        store.put(session_id, state)


def migrate_goal_to_session(old_session_id: str, new_session_id: str, *, reason: str = "") -> bool:
    """Migrate active goal across session compression/rotation."""
    if not old_session_id or not new_session_id or old_session_id == new_session_id:
        return False
    state = load_goal(old_session_id)
    if state is None or state.status == "cleared":
        return False
    if load_goal(new_session_id) is not None:
        return False
    child_state = GoalState.from_dict(state.to_dict())
    save_goal(new_session_id, child_state)
    clear_goal(old_session_id)
    logger.debug("GoalManager: migrated goal %s -> %s (%s)", old_session_id, new_session_id, reason or "rotation")
    return True


_JSON_OBJECT_RE = re.compile(r"\{.*?\}", re.DOTALL)


def extract_json_object(raw: str) -> Optional[Dict[str, Any]]:
    """Extract a JSON dictionary from markdown fences or text."""
    if not raw:
        return None
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        nl = text.find("\n")
        if nl != -1:
            text = text[nl + 1:]
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except Exception:
        match = _JSON_OBJECT_RE.search(text)
        if match:
            try:
                data = json.loads(match.group(0))
                if isinstance(data, dict):
                    return data
            except Exception:
                pass
    return None


def parse_judge_response(raw: str) -> Tuple[str, str, bool, Optional[Dict[str, Any]]]:
    """Parse judge response into (verdict, reason, parse_failed, wait_directive)."""
    data = extract_json_object(raw)
    if not data:
        return "continue", "unparseable judge output (fail-open)", True, None

    # Legacy {"done": bool}
    if "done" in data and "verdict" not in data:
        verdict = "done" if bool(data["done"]) else "continue"
        reason = str(data.get("reason") or "legacy done format").strip()
        return verdict, reason, False, None

    raw_verdict = str(data.get("verdict") or "").strip().lower()
    reason = str(data.get("reason") or "").strip() or "no reason provided"

    if raw_verdict in {"done", "blocked", "continue"}:
        return raw_verdict, reason, False, None

    if raw_verdict == "wait":
        wait_directive: Dict[str, Any] = {}
        if data.get("wait_on_session"):
            wait_directive["session_id"] = str(data["wait_on_session"]).strip()
        elif data.get("wait_on_pid") is not None:
            try:
                wait_directive["pid"] = int(data["wait_on_pid"])
            except (ValueError, TypeError):
                pass
        elif data.get("wait_for_seconds") is not None:
            try:
                wait_directive["seconds"] = int(data["wait_for_seconds"])
            except (ValueError, TypeError):
                pass
        if wait_directive:
            return "wait", reason, False, wait_directive
        # Wait without directive downgrades to continue
        return "continue", f"wait without target: {reason}", False, None

    return "continue", f"unknown verdict {raw_verdict!r} (fail-open)", True, None


def _check_pid_alive(pid: int) -> bool:
    """Safe process existence check."""
    if not pid or pid <= 0:
        return False
    try:
        import os
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def _decision(
    status: Optional[str],
    should_continue: bool,
    prompt: Optional[str],
    verdict: str,
    reason: str,
    message: str,
) -> Dict[str, Any]:
    return {
        "status": status,
        "should_continue": should_continue,
        "continuation_prompt": prompt,
        "verdict": verdict,
        "reason": reason,
        "message": message,
    }


class GoalManager:
    """Per-session goal management and turn evaluation."""

    def __init__(self, session_id: str, *, default_max_turns: int = DEFAULT_MAX_TURNS, persist: bool = True):
        self.session_id = str(session_id)
        self._persist_state = persist
        self.default_max_turns = int(default_max_turns or DEFAULT_MAX_TURNS)
        self._state: Optional[GoalState] = load_goal(self.session_id)

    @property
    def state(self) -> Optional[GoalState]:
        return self._state

    def is_active(self) -> bool:
        return self._state is not None and self._state.status == "active"

    def has_goal(self) -> bool:
        return self._state is not None and self._state.status in {"active", "paused"}

    def has_contract(self) -> bool:
        return self._state is not None and self._state.has_contract()

    def _save(self) -> GoalState:
        self._state.revision += 1
        if self._persist_state:
            save_goal(self.session_id, self._state)
        return self._state

    def _require_goal(self) -> GoalState:
        if self._state is None or not self.has_goal():
            raise RuntimeError("no active goal")
        return self._state

    def _require_active(self) -> GoalState:
        if self._state is None or self._state.status != "active":
            raise RuntimeError("no active goal to park")
        return self._state

    def status_line(self) -> str:
        s = self._state
        if s is None or s.status == "cleared":
            return "No active goal. Set one with /goal <text>."
        turns = f"{s.turns_used}/{s.max_turns} turns"
        sub = f", {len(s.subgoals)} subgoal{'s' if len(s.subgoals) != 1 else ''}" if s.subgoals else ""
        con = ", contract" if self.has_contract() else ""
        gat = f", {len(s.gates)} gate{'s' if len(s.gates) != 1 else ''}" if s.gates else ""
        meta = f"{turns}{sub}{con}{gat}"
        if s.status == "active":
            if s.waiting_on_session:
                return f"⏳ Goal (parked on session {s.waiting_on_session}, {meta}): {s.goal}"
            if s.waiting_on_pid:
                return f"⏳ Goal (parked on pid {s.waiting_on_pid}, {meta}): {s.goal}"
            if s.waiting_until and time.time() < s.waiting_until:
                remaining = int(s.waiting_until - time.time())
                return f"⏳ Goal (parked {remaining}s, {meta}): {s.goal}"
            return f"⊙ Goal (active, {meta}): {s.goal}"
        if s.status == "paused":
            extra = f" — {s.paused_reason}" if s.paused_reason else ""
            return f"⏸ Goal (paused, {meta}{extra}): {s.goal}"
        if s.status == "done":
            return f"✓ Goal done ({meta}): {s.goal}"
        return f"Goal ({s.status}, {meta}): {s.goal}"

    def set(
        self,
        goal: str,
        *,
        max_turns: Optional[int] = None,
        contract: Optional[GoalContract] = None,
    ) -> GoalState:
        goal = (goal or "").strip()
        if not goal:
            raise ValueError("goal text is empty")
        self._state = GoalState(
            goal=goal,
            status="active",
            turns_used=0,
            created_at=time.time(),
            last_turn_at=0.0,
            max_turns=int(max_turns) if max_turns else self.default_max_turns,
            contract=contract if contract is not None else GoalContract(),
        )
        return self._save()

    def set_contract(self, contract: GoalContract) -> Optional[GoalState]:
        if self._state is None:
            return None
        self._state.contract = contract or GoalContract()
        return self._save()

    def pause(self, reason: str = "user-paused") -> Optional[GoalState]:
        if not self._state:
            return None
        self._state.status = "paused"
        self._state.paused_reason = reason
        self._state.clear_wait()
        return self._save()

    def resume(self, *, reset_budget: bool = True) -> Optional[GoalState]:
        if not self._state:
            return None
        self._state.status = "active"
        self._state.paused_reason = None
        self._state.clear_wait()
        if reset_budget:
            self._state.turns_used = 0
        return self._save()

    def clear(self) -> None:
        if self._state is None:
            return
        self._state.status = "cleared"
        self._save()
        self._state = None

    def mark_done(self, reason: str) -> None:
        if not self._state:
            return
        self._state.status = "done"
        self._state.last_verdict = "done"
        self._state.last_reason = reason
        self._save()

    # --- Subgoals ---

    def add_subgoal(self, text: str) -> str:
        state = self._require_goal()
        clean = (text or "").strip()
        if not clean:
            raise ValueError("subgoal text is empty")
        state.subgoals.append(clean)
        self._save()
        return clean

    def remove_subgoal(self, index_1based: int) -> str:
        state = self._require_goal()
        idx = int(index_1based) - 1
        if idx < 0 or idx >= len(state.subgoals):
            raise IndexError(f"index out of range (1..{len(state.subgoals)})")
        removed = state.subgoals.pop(idx)
        self._save()
        return removed

    def clear_subgoals(self) -> int:
        state = self._require_goal()
        prev = len(state.subgoals)
        state.subgoals = []
        self._save()
        return prev

    # --- Quality Gates ---

    def add_gate(
        self,
        command: str,
        *,
        timeout_seconds: Optional[int] = None,
        max_retries: Optional[int] = None,
    ) -> GoalGate:
        state = self._require_goal()
        command = (command or "").strip()
        if not command:
            raise ValueError("gate command is empty")
        limits = GoalGateAddArguments.model_validate({"command":command, **{
            key:value for key, value in {"timeout_seconds":timeout_seconds, "max_retries":max_retries}.items()
            if value is not None}})
        gate = GoalGate(command=command, timeout_seconds=limits.timeout_seconds, max_retries=limits.max_retries)
        state.gates.append(gate)
        self._save()
        return gate

    def remove_gate(self, index_1based: int) -> str:
        state = self._require_goal()
        idx = int(index_1based) - 1
        if idx < 0 or idx >= len(state.gates):
            raise IndexError(f"index out of range (1..{len(state.gates)})")
        removed = state.gates.pop(idx)
        self._save()
        return removed.command

    def clear_gates(self) -> int:
        state = self._require_goal()
        prev = len(state.gates)
        state.gates = []
        self._save()
        return prev

    def _check_gates(self, gate_runner=None) -> Optional[Dict[str, Any]]:
        state = self._state
        if state is None or not state.gates:
            return None

        for gate in state.gates:
            passed, exit_code, tail = (gate_runner or run_gate)(gate)
            gate.last_exit_code = exit_code
            gate.last_output_tail = tail
            if passed:
                gate.attempts = 0
                continue

            gate.attempts += 1
            if gate.attempts > gate.max_retries:
                state.status = "paused"
                state.paused_reason = f"quality gate exhausted {gate.attempts - 1} retries: $ {gate.command}"
                self._save()
                return _decision(
                    "paused",
                    False,
                    None,
                    "gate_failed",
                    f"gate exhausted retries: $ {gate.command}",
                    f"⏸ Goal paused — quality gate still failing after {gate.max_retries} retries: $ {gate.command}",
                )

            self._save()
            prompt = CONTINUATION_PROMPT_GATE_FAILED_TEMPLATE.format(
                goal=state.goal,
                command=gate.command,
                exit_code=exit_code,
                attempt=gate.attempts,
                max_retries=gate.max_retries,
                output=tail or "(no output)",
            )
            return _decision(
                "active",
                True,
                prompt,
                "gate_failed",
                f"gate failed (exit {exit_code}): $ {gate.command}",
                f"✗ Quality gate failed ({state.turns_used}/{state.max_turns} turns, attempt {gate.attempts}/{gate.max_retries}): $ {gate.command}",
            )

        self._save()
        return None

    # --- Wait Barriers ---

    def wait_on(self, pid: int, reason: str = "") -> GoalState:
        self._require_active()
        pid = int(pid)
        if pid <= 0:
            raise ValueError("pid must be a positive integer")
        if not _check_pid_alive(pid):
            raise ValueError("pid is not alive on this host")
        self._state.clear_wait()
        self._state.waiting_on_pid = pid
        self._state.waiting_reason = (reason or "").strip() or None
        self._state.waiting_since = time.time()
        return self._save()

    def wait_on_session(self, session_id: str, reason: str = "") -> GoalState:
        self._require_active()
        session_id = str(session_id or "").strip()
        if not session_id:
            raise ValueError("session_id must be a non-empty string")
        self._state.clear_wait()
        self._state.waiting_on_session = session_id
        self._state.waiting_reason = (reason or "").strip() or None
        self._state.waiting_since = time.time()
        return self._save()

    def wait_for_seconds(self, seconds: int, reason: str = "", *, on_delegations: int = 0) -> GoalState:
        self._require_active()
        seconds = int(seconds)
        if seconds <= 0:
            raise ValueError("seconds must be a positive integer")
        self._state.clear_wait()
        self._state.waiting_until = time.time() + seconds
        self._state.waiting_on_delegations = max(0, int(on_delegations))
        self._state.waiting_reason = (reason or "").strip() or None
        self._state.waiting_since = time.time()
        return self._save()

    def stop_waiting(self) -> bool:
        s = self._state
        if s is None or (s.waiting_on_pid is None and s.waiting_on_session is None and not s.waiting_until):
            return False
        s.clear_wait()
        self._save()
        return True

    def is_waiting(self, *, live_delegations: int = 0, session_waiting_check: Optional[Callable[[str], bool]] = None, now: Optional[float] = None) -> bool:
        s = self._state
        if s is None:
            return False
        current_time = time.time() if now is None else now
        if s.waiting_on_session is not None:
            if session_waiting_check is not None:
                still = session_waiting_check(s.waiting_on_session)
            else:
                still = True
        elif s.waiting_on_pid is not None:
            still = _check_pid_alive(s.waiting_on_pid)
        elif s.waiting_until:
            still = current_time < s.waiting_until
            if still and s.waiting_on_delegations > 0:
                if live_delegations < s.waiting_on_delegations:
                    still = False
        else:
            return False

        if still and s.waiting_since and s.waiting_until == 0.0 and (current_time - s.waiting_since) > _MAX_BARRIER_WAIT_S:
            logger.info("goal: wait barrier exceeded %ds; resuming judging", _MAX_BARRIER_WAIT_S)
            still = False

        if not still:
            self.stop_waiting()
        return still

    # --- Turn Evaluation & Continuation ---

    def next_continuation_prompt(self) -> Optional[str]:
        s = self._state
        if not s or s.status != "active":
            return None
        if s.has_contract():
            contract_block = s.contract.render_block()
            if s.subgoals:
                criteria = "\n".join(f"- Extra criterion {i}: {text}" for i, text in enumerate(s.subgoals, 1))
                contract_block = f"{contract_block}\n{criteria}"
            return CONTINUATION_PROMPT_WITH_CONTRACT_TEMPLATE.format(goal=s.goal, contract_block=contract_block)
        if s.subgoals:
            return CONTINUATION_PROMPT_WITH_SUBGOALS_TEMPLATE.format(goal=s.goal, subgoals_block=s.render_subgoals_block())
        return CONTINUATION_PROMPT_TEMPLATE.format(goal=s.goal)

    def evaluate_after_turn(
        self,
        last_response: str,
        *,
        judge_fn: Optional[Callable[..., Tuple[str, str, bool, Optional[Dict[str, Any]], bool]]] = None,
        background_processes: Optional[List[Dict[str, Any]]] = None,
        active_delegations: int = 0,
        session_waiting_check: Optional[Callable[[str], bool]] = None,
        gate_runner: Optional[Callable] = None,
    ) -> Dict[str, Any]:
        """Evaluate agent response against quality gates, barriers, and judge."""
        state = self._state
        if state is None or state.status != "active":
            return _decision(state.status if state else None, False, None, "inactive", "no active goal", "")

        if self.is_waiting(live_delegations=active_delegations, session_waiting_check=session_waiting_check):
            tgt = (
                f"session {state.waiting_on_session}" if state.waiting_on_session
                else f"pid {state.waiting_on_pid}" if state.waiting_on_pid
                else f"{max(0, int(state.waiting_until - time.time()))}s remaining"
            )
            reason = state.waiting_reason or tgt
            return _decision("active", False, None, "waiting", reason, f"⏳ Goal parked — waiting on {tgt}: {reason}")

        state.turns_used += 1
        state.last_turn_at = time.time()

        # Deterministic gates execute BEFORE judge
        gate_decision = self._check_gates(gate_runner)
        if gate_decision is not None:
            if gate_decision.get("should_continue") and state.turns_used >= state.max_turns:
                state.status = "paused"
                state.paused_reason = f"turn budget exhausted ({state.turns_used}/{state.max_turns})"
                self._save()
                return _decision(
                    "paused",
                    False,
                    None,
                    "gate_failed",
                    gate_decision.get("reason", ""),
                    f"⏸ Goal paused — {state.turns_used}/{state.max_turns} turns used (a quality gate is still failing).",
                )
            return gate_decision

        # Run judge (fail-open to continue)
        if judge_fn is not None:
            try:
                verdict, reason, parse_failed, wait_directive, transport_failed = judge_fn(
                    goal=state.goal,
                    last_response=last_response,
                    subgoals=state.subgoals,
                    contract=state.contract if state.has_contract() else None,
                    background_processes=background_processes,
                    active_delegations=active_delegations,
                )
            except Exception as exc:
                verdict, reason, parse_failed, wait_directive, transport_failed = "continue", f"judge exception: {exc}", False, None, True
        else:
            verdict, reason, parse_failed, wait_directive, transport_failed = "continue", "default judge: continuing", False, None, False

        state.last_verdict = verdict
        state.last_reason = reason
        state.consecutive_parse_failures = state.consecutive_parse_failures + 1 if parse_failed else 0
        state.consecutive_transport_failures = state.consecutive_transport_failures + 1 if transport_failed else 0

        # Handle wait verdict from judge
        if verdict == "wait" and wait_directive:
            if wait_directive.get("session_id"):
                self.wait_on_session(str(wait_directive["session_id"]), reason=reason)
                return _decision("active", False, None, "wait", reason, f"⏳ Goal parked (judge) — waiting on session: {reason}")
            elif wait_directive.get("pid"):
                pid = int(wait_directive["pid"])
                try:
                    self.wait_on(pid, reason=reason)
                    return _decision("active", False, None, "wait", reason, f"⏳ Goal parked (judge) — waiting on pid {pid}: {reason}")
                except ValueError:
                    logger.info("goal judge: pid %s not alive on host, continuing", pid)
            elif wait_directive.get("seconds"):
                self.wait_for_seconds(int(wait_directive["seconds"]), reason=reason, on_delegations=active_delegations)
                return _decision("active", False, None, "wait", reason, f"⏳ Goal parked (judge) — waiting {wait_directive['seconds']}s: {reason}")

        # Blocked
        if verdict == "blocked":
            state.status = "paused"
            state.paused_reason = f"judged unachievable: {reason}"
            self._save()
            return _decision(
                "paused",
                False,
                None,
                "blocked",
                reason,
                f"🚫 Goal judged unachievable — paused: {reason}. Re-scope with /goal set, or override with /goal resume.",
            )

        # Done
        if verdict == "done":
            state.status = "done"
            self._save()
            return _decision("done", False, None, "done", reason, f"✓ Goal achieved: {reason}")

        # Persistent parse or transport failures auto-pause
        if state.consecutive_transport_failures >= DEFAULT_MAX_CONSECUTIVE_TRANSPORT_FAILURES:
            state.status = "paused"
            state.paused_reason = f"judge API unreachable {state.consecutive_transport_failures} turns in a row"
            self._save()
            return _decision("paused", False, None, "continue", reason, f"⏸ Goal paused — judge API unreachable.")

        if state.consecutive_parse_failures >= DEFAULT_MAX_CONSECUTIVE_PARSE_FAILURES:
            state.status = "paused"
            state.paused_reason = f"judge model returned unparseable output {state.consecutive_parse_failures} turns in a row"
            self._save()
            return _decision("paused", False, None, "continue", reason, f"⏸ Goal paused — judge model unparseable.")

        # Turn budget check
        if state.turns_used >= state.max_turns:
            state.status = "paused"
            state.paused_reason = f"turn budget exhausted ({state.turns_used}/{state.max_turns})"
            self._save()
            return _decision(
                "paused",
                False,
                None,
                "continue",
                reason,
                f"⏸ Goal paused — {state.turns_used}/{state.max_turns} turns used. Use /goal resume to keep going, or /goal clear to stop.",
            )

        self._save()
        return _decision(
            "active",
            True,
            self.next_continuation_prompt(),
            "continue",
            reason,
            f"↻ Continuing toward goal ({state.turns_used}/{state.max_turns}): {reason}",
        )
