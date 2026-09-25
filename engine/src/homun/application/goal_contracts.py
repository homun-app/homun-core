"""Contracts and data models for persistent goals, contracts, and quality gates (H25).

Homun maintains goals as first-class multi-turn contracts with deterministic quality gates,
wait barriers (pid/session/time), fail-open auxiliary judging, and budget backstops
without implicit Kanban card creation.
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

DEFAULT_MAX_TURNS = 20
DEFAULT_GATE_TIMEOUT_SECONDS = 300
DEFAULT_GATE_MAX_RETRIES = 3
_MAX_BARRIER_WAIT_S = 30 * 60
_GATE_OUTPUT_TAIL_CHARS = 3000

CONTINUATION_PROMPT_TEMPLATE = (
    "[Continuing toward your standing goal]\n"
    "Goal: {goal}\n\n"
    "Continue working toward this goal. Take the next concrete step. "
    "If you believe the goal is complete, state so explicitly and stop. "
    "If you are blocked and need input from the user, say so clearly and stop."
)

CONTINUATION_PROMPT_WITH_CONTRACT_TEMPLATE = (
    "[Continuing toward your standing goal]\n"
    "Goal: {goal}\n\n"
    "Completion contract:\n"
    "{contract_block}\n\n"
    "Continue working toward the outcome above. Take the next concrete step. "
    "Stay within the stated boundaries and do not violate the constraints. "
    "Before claiming the goal is done, satisfy the Verification criterion and "
    "show the concrete evidence (command output, file contents, test result). "
    "If you hit the stated stop condition or are otherwise blocked and need "
    "user input, say so clearly and stop."
)

CONTINUATION_PROMPT_WITH_SUBGOALS_TEMPLATE = (
    "[Continuing toward your standing goal]\n"
    "Goal: {goal}\n\n"
    "Additional criteria the user added mid-loop:\n"
    "{subgoals_block}\n\n"
    "Continue working toward the goal AND all additional criteria. Take "
    "the next concrete step. If you believe the goal and every "
    "additional criterion are complete, state so explicitly and stop. "
    "If you are blocked and need input from the user, say so clearly "
    "and stop."
)

CONTINUATION_PROMPT_GATE_FAILED_TEMPLATE = (
    "[Continuing toward your standing goal — a quality gate failed]\n"
    "Goal: {goal}\n\n"
    "The quality gate command below must pass before this goal can be "
    "declared done, and it just failed (attempt {attempt}/{max_retries}):\n"
    "  $ {command}\n"
    "Exit code: {exit_code}\n"
    "Output (tail):\n"
    "```\n"
    "{output}\n"
    "```\n\n"
    "Fix the underlying problem so this gate passes, then re-run it to "
    "confirm. Do not declare the goal complete while any gate fails. If the "
    "gate itself is wrong or cannot pass, say so clearly and stop."
)

_CONTRACT_FIELDS = ("outcome", "verification", "constraints", "boundaries", "stop_when")
_CONTRACT_LABELS = {
    "outcome": "Outcome",
    "verification": "Verification",
    "constraints": "Constraints",
    "boundaries": "Boundaries",
    "stop_when": "Stop when blocked",
}
_CONTRACT_ALIASES = {
    "outcome": "outcome", "goal": "outcome", "done": "outcome", "done when": "outcome",
    "verification": "verification", "verify": "verification", "verified by": "verification",
    "evidence": "verification", "proof": "verification",
    "constraints": "constraints", "constraint": "constraints", "preserve": "constraints",
    "must not": "constraints", "do not change": "constraints",
    "boundaries": "boundaries", "boundary": "boundaries", "scope": "boundaries",
    "allowed": "boundaries", "files": "boundaries",
    "stop when": "stop_when", "stop_when": "stop_when", "blocked": "stop_when",
}


@dataclass
class GoalContract:
    """Structured completion contract establishing clear done criteria."""
    outcome: str = ""
    verification: str = ""
    constraints: str = ""
    boundaries: str = ""
    stop_when: str = ""

    def is_empty(self) -> bool:
        return not any(getattr(self, f).strip() for f in _CONTRACT_FIELDS)

    def to_dict(self) -> Dict[str, str]:
        return {f: getattr(self, f) for f in _CONTRACT_FIELDS}

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "GoalContract":
        if not isinstance(data, dict):
            return cls()
        return cls(**{f: str(data.get(f) or "").strip() for f in _CONTRACT_FIELDS})

    def render_block(self) -> str:
        return "\n".join(
            f"- {_CONTRACT_LABELS[f]}: {getattr(self, f).strip()}"
            for f in _CONTRACT_FIELDS
            if getattr(self, f).strip()
        )


def parse_contract(text: str) -> Tuple[str, GoalContract]:
    """Parse text into headline and structured contract from inline key-values."""
    if not text:
        return "", GoalContract()
    headline_parts: List[str] = []
    fields: Dict[str, List[str]] = {f: [] for f in _CONTRACT_FIELDS}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if ":" in line:
            prefix, _, value = line.partition(":")
            key = _CONTRACT_ALIASES.get(prefix.strip().lower())
            if key is not None and value.strip():
                fields[key].append(value.strip())
                continue
        headline_parts.append(line)
    contract = GoalContract(**{f: " ".join(v).strip() for f, v in fields.items()})
    return " ".join(headline_parts).strip(), contract


@dataclass
class GoalGate:
    """Deterministic shell command that must pass before declaring a goal complete."""
    command: str
    timeout_seconds: int = DEFAULT_GATE_TIMEOUT_SECONDS
    max_retries: int = DEFAULT_GATE_MAX_RETRIES
    attempts: int = 0
    last_exit_code: Optional[int] = None
    last_output_tail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "GoalGate":
        if not isinstance(data, dict):
            return cls(command="")
        return cls(
            command=str(data.get("command") or ""),
            timeout_seconds=int(data.get("timeout_seconds") or DEFAULT_GATE_TIMEOUT_SECONDS),
            max_retries=int(data.get("max_retries") or DEFAULT_GATE_MAX_RETRIES),
            attempts=int(data.get("attempts") or 0),
            last_exit_code=(int(data["last_exit_code"]) if data.get("last_exit_code") is not None else None),
            last_output_tail=str(data.get("last_output_tail") or ""),
        )


def run_gate(gate: GoalGate, *, cwd: Optional[str] = None) -> Tuple[bool, int, str]:
    """Run a quality gate command, returning (passed, exit_code, output_tail)."""
    try:
        proc = subprocess.run(
            gate.command,
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(1, int(gate.timeout_seconds)),
            cwd=cwd or None,
        )
        combined = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
        return proc.returncode == 0, proc.returncode, combined[-_GATE_OUTPUT_TAIL_CHARS:]
    except subprocess.TimeoutExpired as exc:
        out = "".join(c if isinstance(c, str) else c.decode("utf-8", "replace") for c in (exc.stdout, exc.stderr) if c)
        return False, -1, (out + f"\n[gate timed out after {gate.timeout_seconds}s]")[-_GATE_OUTPUT_TAIL_CHARS:]
    except Exception as exc:
        return False, -1, f"[gate could not run: {type(exc).__name__}: {exc}]"


@dataclass
class GoalState:
    """Serializable persistent goal state."""
    goal: str
    status: str = "active"          # active | paused | done | cleared
    turns_used: int = 0
    max_turns: int = DEFAULT_MAX_TURNS
    created_at: float = 0.0
    last_turn_at: float = 0.0
    last_verdict: Optional[str] = None        # "done" | "blocked" | "continue" | "wait" | "skipped"
    last_reason: Optional[str] = None
    paused_reason: Optional[str] = None
    consecutive_parse_failures: int = 0
    consecutive_transport_failures: int = 0
    subgoals: List[str] = field(default_factory=list)
    waiting_on_pid: Optional[int] = None
    waiting_on_session: Optional[str] = None
    waiting_until: float = 0.0
    waiting_on_delegations: int = 0
    waiting_reason: Optional[str] = None
    waiting_since: float = 0.0
    contract: GoalContract = field(default_factory=GoalContract)
    gates: List[GoalGate] = field(default_factory=list)

    def has_contract(self) -> bool:
        return not self.contract.is_empty()

    def clear_wait(self) -> None:
        self.waiting_on_pid = None
        self.waiting_on_session = None
        self.waiting_until = 0.0
        self.waiting_on_delegations = 0
        self.waiting_reason = None
        self.waiting_since = 0.0

    def render_subgoals_block(self) -> str:
        return "\n".join(f"- Subgoal {i}: {s}" for i, s in enumerate(self.subgoals, start=1))

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "GoalState":
        subgoals = [str(s).strip() for s in (data.get("subgoals") or []) if str(s).strip()]
        gates = [GoalGate.from_dict(g) for g in (data.get("gates") or [])]
        contract = GoalContract.from_dict(data.get("contract"))
        return cls(
            goal=str(data.get("goal") or ""),
            status=str(data.get("status") or "active"),
            turns_used=int(data.get("turns_used") or 0),
            max_turns=int(data.get("max_turns") or DEFAULT_MAX_TURNS),
            created_at=float(data.get("created_at") or 0.0),
            last_turn_at=float(data.get("last_turn_at") or 0.0),
            last_verdict=data.get("last_verdict"),
            last_reason=data.get("last_reason"),
            paused_reason=data.get("paused_reason"),
            consecutive_parse_failures=int(data.get("consecutive_parse_failures") or 0),
            consecutive_transport_failures=int(data.get("consecutive_transport_failures") or 0),
            subgoals=subgoals,
            waiting_on_pid=(int(data["waiting_on_pid"]) if data.get("waiting_on_pid") else None),
            waiting_on_session=(str(data["waiting_on_session"]) if data.get("waiting_on_session") else None),
            waiting_until=float(data.get("waiting_until") or 0.0),
            waiting_on_delegations=int(data.get("waiting_on_delegations") or 0),
            waiting_reason=data.get("waiting_reason"),
            waiting_since=float(data.get("waiting_since") or 0.0),
            contract=contract,
            gates=gates,
        )


# --- Pydantic Tool Arguments for Agent Tool Registry ---

class GoalSetArguments(BaseModel):
    goal: str = Field(description="The persistent goal statement or objective.")
    max_turns: Optional[int] = Field(default=None, description="Maximum number of turns allowed before auto-pausing.")
    outcome: Optional[str] = Field(default="", description="The specific end-state outcome required.")
    verification: Optional[str] = Field(default="", description="The concrete test/evidence proving completion.")
    constraints: Optional[str] = Field(default="", description="Constraints and invariants that must not be violated.")
    boundaries: Optional[str] = Field(default="", description="Scope boundaries (files, directories, services).")
    stop_when: Optional[str] = Field(default="", description="Condition when the agent must stop and ask for human input.")


class GoalStatusArguments(BaseModel):
    pass


class GoalPauseArguments(BaseModel):
    reason: Optional[str] = Field(default="user-paused", description="Reason for pausing the goal loop.")


class GoalResumeArguments(BaseModel):
    reset_budget: Optional[bool] = Field(default=True, description="Whether to reset the turns used counter.")


class SubgoalAddArguments(BaseModel):
    subgoal: str = Field(description="Criterion or subgoal to add to the active goal.")


class SubgoalRemoveArguments(BaseModel):
    index: int = Field(description="1-based index of the subgoal to remove.")


class GoalGateAddArguments(BaseModel):
    command: str = Field(description="Shell command that must exit 0 before goal can be marked done.")
    timeout_seconds: Optional[int] = Field(default=DEFAULT_GATE_TIMEOUT_SECONDS, description="Execution timeout in seconds.")
    max_retries: Optional[int] = Field(default=DEFAULT_GATE_MAX_RETRIES, description="Max retries before auto-pausing.")


class GoalGateRemoveArguments(BaseModel):
    index: int = Field(description="1-based index of the quality gate to remove.")


class GoalWaitArguments(BaseModel):
    pid: Optional[int] = Field(default=None, description="Wait until background PID exits.")
    session_id: Optional[str] = Field(default=None, description="Wait until process session triggers/exits.")
    seconds: Optional[int] = Field(default=None, description="Wait for a fixed duration in seconds.")
    reason: Optional[str] = Field(default="", description="Explanation of why the goal is parked.")


def entries(executor: Callable, version: int) -> list:
    """Return ToolEntry list for registration in agent tool registry."""
    from homun.application.agent_tool_contracts import ToolDefinition, ToolEntry

    return [
        ToolEntry(
            ToolDefinition(
                name="goal_set",
                description="Set or update the active persistent multi-turn goal and its completion contract.",
                input_schema=GoalSetArguments.model_json_schema(),
            ),
            "goal",
            str(version),
            GoalSetArguments,
            executor,
        ),
        ToolEntry(
            ToolDefinition(
                name="goal_status",
                description="Inspect the current goal, turns used, quality gates, subgoals, and wait barriers.",
                input_schema=GoalStatusArguments.model_json_schema(),
            ),
            "goal",
            str(version),
            GoalStatusArguments,
            executor,
        ),
        ToolEntry(
            ToolDefinition(
                name="goal_pause",
                description="Pause the persistent goal loop with an optional explanation.",
                input_schema=GoalPauseArguments.model_json_schema(),
            ),
            "goal",
            str(version),
            GoalPauseArguments,
            executor,
        ),
        ToolEntry(
            ToolDefinition(
                name="goal_resume",
                description="Resume a paused persistent goal loop, optionally resetting its turn budget.",
                input_schema=GoalResumeArguments.model_json_schema(),
            ),
            "goal",
            str(version),
            GoalResumeArguments,
            executor,
        ),
        ToolEntry(
            ToolDefinition(
                name="subgoal_add",
                description="Add an extra criterion/subgoal that must be satisfied before the goal is done.",
                input_schema=SubgoalAddArguments.model_json_schema(),
            ),
            "goal",
            str(version),
            SubgoalAddArguments,
            executor,
        ),
        ToolEntry(
            ToolDefinition(
                name="subgoal_remove",
                description="Remove an extra criterion/subgoal by its 1-based index.",
                input_schema=SubgoalRemoveArguments.model_json_schema(),
            ),
            "goal",
            str(version),
            SubgoalRemoveArguments,
            executor,
        ),
        ToolEntry(
            ToolDefinition(
                name="goal_gate_add",
                description="Add a deterministic shell command that must pass before the goal can be declared done.",
                input_schema=GoalGateAddArguments.model_json_schema(),
            ),
            "goal",
            str(version),
            GoalGateAddArguments,
            executor,
        ),
        ToolEntry(
            ToolDefinition(
                name="goal_gate_remove",
                description="Remove a quality gate command by its 1-based index.",
                input_schema=GoalGateRemoveArguments.model_json_schema(),
            ),
            "goal",
            str(version),
            GoalGateRemoveArguments,
            executor,
        ),
        ToolEntry(
            ToolDefinition(
                name="goal_wait",
                description="Park the goal on a background PID, background process session, or duration.",
                input_schema=GoalWaitArguments.model_json_schema(),
            ),
            "goal",
            str(version),
            GoalWaitArguments,
            executor,
        ),
    ]
