"""Budget admission and immutable settlement entities."""
from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field
from homun.domain.timestamps import utc_now


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
    admitted_actor_id: str = ""

    run_id: str | None = None
    connection_id: str | None = None
    provider_id: str | None = None
    model_id: str | None = None


class BudgetUsageReceipt(BaseModel):
    """Immutable provider settlement, keyed by its original reservation ID."""
    model_config = {"frozen": True}
    id: str
    workspace_id: str
    work_id: str
    run_id: str | None = None
    connection_id: str | None = None
    requested_provider_id: str | None = None
    requested_model_id: str | None = None
    reported_provider_id: str | None = None
    reported_model_id: str | None = None
    accounting_actor_id: str = ""
    admitted_actor_id: str = ""
    purpose: str = ""
    reserved_at: datetime
    settled_at: datetime = Field(default_factory=utc_now)
    status: Literal['known', 'partial', 'unknown', 'released']
    estimate: BudgetCounters
    charged_known: BudgetCounters = Field(default_factory=BudgetCounters)
    charged_unknown: BudgetCounters = Field(default_factory=BudgetCounters)
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost: float | None = None
    currency: str | None = None
    reason: str = ""
    settlement_fingerprint: str


class BudgetAllocation(BaseModel):
    """Delegate sub-cap inside the work envelope: own limit, own counters.

    A delegate that exhausts its allocation stops even when the work envelope
    still has room; other actors are unaffected (subagent isolation pattern).
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

