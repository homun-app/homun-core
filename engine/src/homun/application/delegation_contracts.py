"""Tool contracts for isolated async/parallel subagent delegation (H21/H22).

and tools/async_delegation.py (MIT).
"""
from __future__ import annotations

from typing import Any
from pydantic import BaseModel, ConfigDict, Field
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class DelegateTaskArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    task: str = Field(min_length=1, max_length=4000)
    agent_id: str | None = Field(default=None, max_length=100)
    tools_include: list[str] | None = Field(default=None, max_length=20)
    max_turns: int = Field(default=3, ge=1, le=10)
    output_schema: dict[str, Any] | None = None
    run_in_background: bool = Field(default=False)


class DelegationPollArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    delegation_id: str = Field(min_length=1, max_length=100)


class DelegationCancelArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    delegation_id: str = Field(min_length=1, max_length=100)


def entries(handler, version=1):
    delegate_def = ToolDefinition(
        name="delegate_task",
        description=(
            "Delegate a task to an isolated subagent with its own context, tool subset, "
            "turn limit, and optional structured output schema. Can run synchronously or in the background."
        ),
        input_schema=DelegateTaskArguments.model_json_schema(),
    )
    poll_def = ToolDefinition(
        name="delegation_poll",
        description="Poll the status and deliverable of a background delegated subagent by delegation ID.",
        input_schema=DelegationPollArguments.model_json_schema(),
    )
    cancel_def = ToolDefinition(
        name="delegation_cancel",
        description="Cancel a running background delegated subagent by delegation ID.",
        input_schema=DelegationCancelArguments.model_json_schema(),
    )

    def run_delegate(ctx, actor, run, args):
        return handler(ctx, actor, run, "delegate_task", args)

    def run_poll(ctx, actor, run, args):
        return handler(ctx, actor, run, "delegation_poll", args)

    def run_cancel(ctx, actor, run, args):
        return handler(ctx, actor, run, "delegation_cancel", args)

    return [
        ToolEntry(delegate_def, "delegation", str(version), DelegateTaskArguments, run_delegate, replay="model"),
        ToolEntry(poll_def, "delegation", str(version), DelegationPollArguments, run_poll, replay="read_only"),
        ToolEntry(cancel_def, "delegation", str(version), DelegationCancelArguments, run_cancel, replay="never"),
    ]
