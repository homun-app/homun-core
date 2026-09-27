"""Contracts and data models for durable scheduling, cron jobs, occurrences, and incidents (H28/H29).

and tools/cronjob_tools.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun maintains scheduled jobs as durable entities supporting prompt-based, skill-based,
and script-only execution, inference pins, chained context from prior runs, preflight
verification, quota hold, and deduplicated incident reporting.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Union

from pydantic import BaseModel, Field


@dataclass
class CronJob:
    """Serializable record of a scheduled cron job."""
    id: str
    schedule_raw: str
    schedule_kind: str = "cron"         # cron | interval | once | event
    name: Optional[str] = None
    prompt: Optional[str] = None
    skills: List[str] = field(default_factory=list)
    script: Optional[str] = None
    no_agent: bool = False
    workdir: Optional[str] = None
    model_pin: Optional[str] = None
    provider_pin: Optional[str] = None
    context_from: List[str] = field(default_factory=list)   # job IDs whose prior output is injected
    repeat: Optional[int] = None                            # None = infinite, 1 = once, N = times
    deliver: str = "local"                                  # local | origin | chat
    status: str = "active"                                  # active | paused | completed | cleared
    paused_reason: Optional[str] = None
    created_at: float = 0.0
    last_run_at: float = 0.0
    next_run_at: float = 0.0
    run_count: int = 0
    error_count: int = 0
    consecutive_errors: int = 0
    quota_hold: bool = False
    last_output: Optional[str] = None
    owner_actor: Optional[Dict[str, Any]] = None
    source_work_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CronJob":
        skills = [str(s).strip() for s in (data.get("skills") or []) if str(s).strip()]
        ctx_from = [str(c).strip() for c in (data.get("context_from") or []) if str(c).strip()]
        return cls(
            id=str(data.get("id") or ""),
            schedule_raw=str(data.get("schedule_raw") or ""),
            schedule_kind=str(data.get("schedule_kind") or "cron"),
            name=data.get("name"),
            prompt=data.get("prompt"),
            skills=skills,
            script=data.get("script"),
            no_agent=bool(data.get("no_agent") or False),
            workdir=data.get("workdir"),
            model_pin=data.get("model_pin"),
            provider_pin=data.get("provider_pin"),
            context_from=ctx_from,
            repeat=(int(data["repeat"]) if data.get("repeat") is not None else None),
            deliver=str(data.get("deliver") or "local"),
            status=str(data.get("status") or "active"),
            paused_reason=data.get("paused_reason"),
            created_at=float(data.get("created_at") or 0.0),
            last_run_at=float(data.get("last_run_at") or 0.0),
            next_run_at=float(data.get("next_run_at") or 0.0),
            run_count=int(data.get("run_count") or 0),
            error_count=int(data.get("error_count") or 0),
            consecutive_errors=int(data.get("consecutive_errors") or 0),
            quota_hold=bool(data.get("quota_hold") or False),
            last_output=data.get("last_output"),
            owner_actor=data.get("owner_actor"),
            source_work_id=data.get("source_work_id"),
        )


@dataclass
class CronOccurrence:
    """Historical execution record of a single job occurrence."""
    occurrence_id: str
    job_id: str
    run_at: float
    completed_at: float
    status: str                         # success | failed | timeout | skipped
    exit_code: Optional[int] = None
    output_preview: str = ""
    error: Optional[str] = None
    duration_s: float = 0.0
    claim_token: Optional[str] = None
    lease_until: float = 0.0
    activation_id: Optional[str] = None
    recovery_safe: bool = False
    agent_run_id: Optional[str] = None
    work_id: Optional[str] = None

    @property
    def id(self) -> str:
        """Compatibility for callers inspecting the claimed job identity."""
        return self.job_id

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CronOccurrence":
        return cls(
            occurrence_id=str(data.get("occurrence_id") or ""),
            job_id=str(data.get("job_id") or ""),
            run_at=float(data.get("run_at") or 0.0),
            completed_at=float(data.get("completed_at") or 0.0),
            status=str(data.get("status") or "success"),
            exit_code=(int(data["exit_code"]) if data.get("exit_code") is not None else None),
            output_preview=str(data.get("output_preview") or ""),
            error=data.get("error"),
            duration_s=float(data.get("duration_s") or 0.0),
            claim_token=data.get("claim_token"),
            lease_until=float(data.get("lease_until") or 0),
            activation_id=data.get("activation_id"),
            recovery_safe=bool(data.get("recovery_safe")),
            agent_run_id=data.get("agent_run_id"),
            work_id=data.get("work_id"),
        )


@dataclass
class CronExecutionResult:
    """Staging is not execution success; unresolved effects stay unknown."""
    status: str
    output: str = ""
    error: Optional[str] = None
    exit_code: Optional[int] = None
    agent_run_id: Optional[str] = None
    work_id: Optional[str] = None


@dataclass
class CronIncident:
    """Tracked incident report with failure deduplication."""
    job_id: str
    error_message: str
    first_seen_at: float
    last_seen_at: float
    occurrence_count: int = 1
    resolved: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CronIncident":
        return cls(
            job_id=str(data.get("job_id") or ""),
            error_message=str(data.get("error_message") or ""),
            first_seen_at=float(data.get("first_seen_at") or 0.0),
            last_seen_at=float(data.get("last_seen_at") or 0.0),
            occurrence_count=int(data.get("occurrence_count") or 1),
            resolved=bool(data.get("resolved") or False),
        )


# --- Pydantic Tool Arguments for Agent Tool Registry ---

class CronjobManageArguments(BaseModel):
    action: str = Field(description="Action to perform: add | list | remove | pause | resume | update | run | history | incidents")
    job_id: Optional[str] = Field(default=None, description="Job identifier for get/remove/pause/resume/update/run/history")
    schedule: Optional[str] = Field(default=None, description="Schedule string: cron ('0 9 * * *'), interval ('every 2h'), one-shot ('at 2026-10-01T12:00:00Z'), or event ('on event:deploy')")
    prompt: Optional[str] = Field(default=None, description="Instruction prompt to run for agent-driven jobs")
    name: Optional[str] = Field(default=None, description="Human-readable title/name for the job")
    skills: Optional[List[str]] = Field(default=None, description="List of skill names to equip for the job")
    script: Optional[str] = Field(default=None, description="Script file path to run in workdir")
    no_agent: Optional[bool] = Field(default=False, description="When true, runs script directly without agent reasoning")
    workdir: Optional[str] = Field(default=None, description="Working directory for tool and script execution")
    model_pin: Optional[str] = Field(default=None, description="Pinned model identifier for deterministic execution")
    provider_pin: Optional[str] = Field(default=None, description="Pinned provider identifier")
    context_from: Optional[List[str]] = Field(default=None, description="List of prior job IDs whose latest output is chained as context")
    repeat: Optional[int] = Field(default=None, description="Max execution count (None = infinite, 1 = once)")
    deliver: Optional[str] = Field(default="local", description="Delivery target: local | origin | chat")
    reason: Optional[str] = Field(default=None, description="Reason for pausing or updating the job")


def entries(executor: Callable, version: int) -> list:
    from homun.application.agent_tool_contracts import ToolDefinition, ToolEntry

    return [
        ToolEntry(
            ToolDefinition(
                name="cronjob_manage",
                description="Manage durable scheduled jobs: add, list, pause, resume, update, remove, run manually, and inspect execution history and incidents.",
                input_schema=CronjobManageArguments.model_json_schema(),
            ),
            "cron",
            str(version),
            CronjobManageArguments,
            executor,
        ),
    ]
