"""Contract and schemas for workspace checkpoint tools (C1 / H12).

Provides registered tools for listing checkpoints, calculating diffs, planning
safe restores, and performing approved rollbacks.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Generator, Optional
from pydantic import BaseModel, Field

from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class CheckpointListArguments(BaseModel):
    limit: int = Field(default=20, ge=1, le=100, description="Maximum number of checkpoints to return.")


class CheckpointDiffArguments(BaseModel):
    commit_hash: Optional[str] = Field(
        default=None,
        description="Target checkpoint hash. If omitted, diffs against the most recent checkpoint.",
    )


class CheckpointPlanRestoreArguments(BaseModel):
    commit_hash: str = Field(description="Target checkpoint hash to evaluate for safe restore.")


class CheckpointRestoreArguments(BaseModel):
    commit_hash: str = Field(description="Target checkpoint commit hash to restore.")
    file_path: Optional[str] = Field(
        default=None,
        description="Optional single file path to selectively restore. If omitted, restores all modified files.",
    )
    safe: bool = Field(
        default=True,
        description="Preserve subsequent user edits not authored by the agent during rollback.",
    )


def entries(execute: Callable, version: int = 1) -> Generator[ToolEntry, None, None]:
    if version != 1:
        return

    list_def = ToolDefinition(
        name="checkpoint_list",
        description="List previous filesystem checkpoints for the workspace from newest to oldest.",
        input_schema=CheckpointListArguments.model_json_schema(),
    )
    yield ToolEntry(
        list_def,
        "checkpoints",
        "1",
        CheckpointListArguments,
        lambda ctx, actor, run, args: execute(ctx, actor, run, "checkpoint_list", args),
        replay="read_only",
    )

    diff_def = ToolDefinition(
        name="checkpoint_diff",
        description="Show working tree diff and change statistics between a checkpoint and current files.",
        input_schema=CheckpointDiffArguments.model_json_schema(),
    )
    yield ToolEntry(
        diff_def,
        "checkpoints",
        "1",
        CheckpointDiffArguments,
        lambda ctx, actor, run, args: execute(ctx, actor, run, "checkpoint_diff", args),
        replay="read_only",
    )

    plan_def = ToolDefinition(
        name="checkpoint_plan_restore",
        description="Preview a rollback plan to a checkpoint, identifying files safe to restore versus preserved user edits.",
        input_schema=CheckpointPlanRestoreArguments.model_json_schema(),
    )
    yield ToolEntry(
        plan_def,
        "checkpoints",
        "1",
        CheckpointPlanRestoreArguments,
        lambda ctx, actor, run, args: execute(ctx, actor, run, "checkpoint_plan_restore", args),
        replay="read_only",
    )

    restore_def = ToolDefinition(
        name="checkpoint_restore",
        description="Roll back workspace files to a previous checkpoint. Requires human approval before execution.",
        input_schema=CheckpointRestoreArguments.model_json_schema(),
    )
    yield ToolEntry(
        restore_def,
        "checkpoints",
        "1",
        CheckpointRestoreArguments,
        lambda ctx, actor, run, args: execute(ctx, actor, run, "checkpoint_restore", args),
        replay="never",
    )
