"""Canonical domain entities for F1 (in-memory; persistence in F2)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

from homun.domain.states import StepStatus, WorkStatus


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class Actor(BaseModel):
    """Authenticated actor — never trust client-supplied elevation."""

    id: str
    workspace_id: str
    display_name: str
    kind: str = "person"  # person | agent


class AgentProfile(BaseModel):
    """A collaborator with professional identity — never just a text blob.

    The structured fields (responsibility, specializations, method, tone,
    autonomy_mode) are what the UI, the intake recommendation and the
    capability registry consume. Instructions remain the free-form operating
    manual; they do not grant permissions.
    """
    id: str
    workspace_id: str
    name: str
    revision: int = 1
    role: str = ""
    avatar: str | None = None
    instructions: str = ""
    preferred_connection_id: str | None = None
    status: str = "active"  # draft | active | paused | retired
    # Professional identity (structured, queryable, versioned).
    responsibility: str = ""
    specializations: list[str] = Field(default_factory=list, max_length=12)
    method: str = ""
    tone: str = ""
    autonomy_mode: str = "supervised"  # supervised | autonomous
    # Structural link to the capability registry: what this collaborator is
    # known to be able to execute. Declarations never grant authorization —
    # grants and policy decide access per project.
    capabilities: list[str] = Field(default_factory=list, max_length=8)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Project(BaseModel):
    id: str
    workspace_id: str
    name: str
    description: str = ""
    version: int = 1
    team_ids: list[str] = Field(default_factory=list)
    member_ids: list[str] = Field(default_factory=list)
    conversation_ids: list[str] = Field(default_factory=list)
    status: str = "active"  # active | archived
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Team(BaseModel):
    id: str
    workspace_id: str
    name: str
    description: str = ""
    revision: int = 1
    member_ids: list[str] = Field(default_factory=list)
    coordinator_id: str | None = None
    status: str = "active"  # active | archived
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AccessGrant(BaseModel):
    id: str
    workspace_id: str
    subject_id: str
    resource_type: str = "project"  # B2: project only
    resource_id: str
    capability: str  # read | write | admin
    issuer_id: str
    status: str = "active"  # active | revoked
    expires_at: datetime | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class MaterialVersion(BaseModel):
    id: str
    workspace_id: str
    project_id: str
    title: str
    kind: str = "note"  # note | link | file_ref
    text: str = ""
    source_uri: str | None = None
    content_hash: str | None = None
    mime_type: str | None = None
    origin_name: str | None = None
    relative_path: str | None = None
    storage_relpath: str | None = None
    byte_size: int | None = None
    extract_status: str = "none"  # none | extracted | unsupported | failed
    version: int = 1
    status: str = "active"  # active | archived
    created_by: str = ""
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Conversation(BaseModel):
    id: str
    workspace_id: str
    title: str
    project_id: str | None = None
    version: int = 1
    archived: bool = False
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Message(BaseModel):
    id: str
    workspace_id: str
    conversation_id: str
    author_id: str
    text: str
    created_at: datetime = Field(default_factory=utc_now)


class PlanStep(BaseModel):
    id: str
    title: str
    assignee_id: str
    status: StepStatus = StepStatus.PENDING
    depends_on: list[str] = Field(default_factory=list)
    output_expected: str = ""


class PlanRevision(BaseModel):
    id: str
    work_id: str
    revision: int
    steps: list[PlanStep]
    created_at: datetime = Field(default_factory=utc_now)
    created_by: str


class ContributionRequest(BaseModel):
    id: str
    work_id: str
    step_id: str
    to_actor_id: str
    need: str
    status: str = "pending"  # pending | resolved | rejected
    response_text: str | None = None
    response_material_ids: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utc_now)
    resolved_at: datetime | None = None


class ArtifactVersion(BaseModel):
    id: str
    work_id: str
    version: int
    title: str
    content: str
    created_at: datetime = Field(default_factory=utc_now)
    created_by: str


class Review(BaseModel):
    id: str
    work_id: str
    artifact_version_id: str
    decision: str  # approve | request_changes
    reviewer_id: str
    comment: str = ""
    created_at: datetime = Field(default_factory=utc_now)


class Work(BaseModel):
    id: str
    workspace_id: str
    title: str
    objective: str
    status: WorkStatus = WorkStatus.DRAFT
    version: int = 1
    primary_conversation_id: str
    conversation_ids: list[str] = Field(default_factory=list)
    project_id: str | None = None
    requester_id: str
    owner_id: str
    reviewer_id: str | None = None
    current_plan_revision: int = 0
    current_artifact_version: int = 0
    archived: bool = False
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class BudgetCounters(BaseModel):
    """Unknown usage stays unknown: absent values are never filled with zero."""

    attempts: int = 0
    input_tokens: int = 0
    output_tokens: int = 0


class BudgetCaps(BaseModel):
    model_attempts: int = 40
    input_tokens: int | None = None
    output_tokens: int | None = None


class BudgetReservation(BaseModel):
    """In-flight estimate held before a provider call; reconciled or recovered."""

    id: str
    created_at: datetime = Field(default_factory=utc_now)
    estimate: BudgetCounters = Field(default_factory=BudgetCounters)
    purpose: str = ""
    actor_id: str = ""


class BudgetAllocation(BaseModel):
    """Delegate sub-cap inside the work envelope: own limit, own counters.

    A delegate that exhausts its allocation stops even when the work envelope
    still has room; other actors are unaffected (the Hermes subagent lesson).
    """

    actor_id: str
    model_attempts: int = 10
    input_tokens: int | None = None
    output_tokens: int | None = None
    reserved: BudgetCounters = Field(default_factory=BudgetCounters)
    spent: BudgetCounters = Field(default_factory=BudgetCounters)
    unknown: BudgetCounters = Field(default_factory=BudgetCounters)


class WorkBudget(BaseModel):
    """Persisted per-work spend envelope over model attempts and tokens."""

    id: str
    workspace_id: str
    work_id: str
    version: int = 1
    caps: BudgetCaps = Field(default_factory=BudgetCaps)
    reserved: BudgetCounters = Field(default_factory=BudgetCounters)
    spent: BudgetCounters = Field(default_factory=BudgetCounters)
    unknown: BudgetCounters = Field(default_factory=BudgetCounters)
    pending: list[BudgetReservation] = Field(default_factory=list)
    allocations: dict[str, BudgetAllocation] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class Run(BaseModel):
    """Operational attempt for a Work, bound to a DBOS workflow (F4.1)."""

    id: str
    workspace_id: str
    work_id: str
    workflow_id: str
    command_id: str
    status: str = "pending"  # pending | running | waiting_input | completed | failed | cancelled
    waiting_topic: str | None = "contribution"
    waiting_step_id: str | None = None
    contribution_request_id: str | None = None
    last_error: str | None = None
    effect_status: str | None = None  # applied | reconciled | null
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class RuntimeIntent(BaseModel):
    id: str
    command_id: str
    run_id: str
    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)
    sequence: int
    delivered: bool = False
    cancelled: bool = False
    claim_token: str | None = None
    claim_expires_at: datetime | None = None
    attempts: int = 0
    error_code: str | None = None


class DomainEvent(BaseModel):
    event_id: str
    schema_version: int = 1
    workspace_id: str
    aggregate_id: str
    aggregate_type: str
    aggregate_version: int
    sequence: int
    occurred_at: datetime = Field(default_factory=utc_now)
    type: str
    actor_id: str
    command_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class CommandRecord(BaseModel):
    request_fingerprint: str | None = None
    followup_status: str = "none"  # none | processing | completed | failed
    followup_token: str | None = None
    followup_expires_at: datetime | None = None
    followup_error: str | None = None
    followup_body: dict[str, Any] | None = None
    followup_actor: dict[str, Any] | None = None
    followup_attempts: int = 0
    followup_next_attempt_at: datetime | None = None
    command_id: str
    type: str
    actor_id: str
    workspace_id: str
    result: dict[str, Any]
    created_at: datetime = Field(default_factory=utc_now)
