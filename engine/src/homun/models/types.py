"""Model provider types, usage ledger entries, and chat messages (F3.1 / F3.5)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class UsageEntry(BaseModel):
    """Ledger row for one model call. Unknown usage stays explicit — never invent zero."""

    id: str
    provider_id: str
    model_id: str
    created_at: datetime = Field(default_factory=utc_now)
    input_tokens: int | None = None
    output_tokens: int | None = None
    estimated_cost: float | None = None
    currency: str | None = None
    status: Literal["ok", "error", "unknown"] = "ok"
    error_code: str | None = None
    notes: str = ""


class AttemptContext(BaseModel):
    """Caller context for a model attempt — never claim tool/actions executed."""

    command_id: str | None = None
    conversation_id: str | None = None
    work_id: str | None = None
    actor_id: str = ""
    purpose: str = "interpret"  # interpret | complete | plan_draft | chat


class UsageAttempt(BaseModel):
    """One try (including retries) for a model-backed operation (F3.5)."""

    id: str
    workspace_id: str = ""
    command_id: str | None = None
    conversation_id: str | None = None
    work_id: str | None = None
    actor_id: str = ""
    purpose: str = "interpret"
    attempt_index: int = 0
    provider_id: str
    model_id: str | None = None
    status: Literal["ok", "error", "cancelled", "unknown"] = "unknown"
    error_code: str | None = None
    usage_entry_id: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    started_at: datetime = Field(default_factory=utc_now)
    finished_at: datetime | None = None
    notes: str = ""


class CompletionResult(BaseModel):
    text: str
    model_id: str
    provider_id: str
    usage: UsageEntry
    finish_reason: str = "stop"


class ProviderInfo(BaseModel):
    id: str
    kind: Literal["fake", "openai_compatible", "pydantic_ai"]
    display_name: str
    configured: bool
    credential_present: bool
    base_url: str | None = None
    default_model: str | None = None
    notes: list[str] = Field(default_factory=list)


class VerifyResult(BaseModel):
    ok: bool
    provider_id: str
    message: str
    checked_at: datetime = Field(default_factory=utc_now)
