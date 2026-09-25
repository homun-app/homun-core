"""Tool contracts for curated persistent memory and session search (H17/H18).

tools/session_search_tool.py (MIT).
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class MemoryRecallArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=5, ge=1, le=20)


class MemoryRememberArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(min_length=1, max_length=1000)


class SessionSearchArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=5, ge=1, le=20)
    from_date: str | None = Field(default=None, max_length=10)
    to_date: str | None = Field(default=None, max_length=10)


def entries(handler, version=1):
    recall_def = ToolDefinition(
        name="memory_recall",
        description=(
            "Search persistent approved memories and facts for the current workspace and project. "
            "Returns relevant saved notes or guidelines."
        ),
        input_schema=MemoryRecallArguments.model_json_schema(),
    )
    remember_def = ToolDefinition(
        name="memory_remember",
        description=(
            "Save an important fact, guideline, or user preference to persistent approved memory. "
            "Avoid transient notes or duplicates."
        ),
        input_schema=MemoryRememberArguments.model_json_schema(),
    )
    session_search_def = ToolDefinition(
        name="session_search",
        description=(
            "Search past conversation messages and turns in the workspace by query and optional date range (YYYY-MM-DD)."
        ),
        input_schema=SessionSearchArguments.model_json_schema(),
    )

    def run_recall(ctx, actor, run, args):
        return handler(ctx, actor, run, "memory_recall", args)

    def run_remember(ctx, actor, run, args):
        return handler(ctx, actor, run, "memory_remember", args)

    def run_search(ctx, actor, run, args):
        return handler(ctx, actor, run, "session_search", args)

    return [
        ToolEntry(recall_def, "memory", str(version), MemoryRecallArguments, run_recall, replay="read_only"),
        ToolEntry(remember_def, "memory", str(version), MemoryRememberArguments, run_remember, replay="read_only"),
        ToolEntry(session_search_def, "memory", str(version), SessionSearchArguments, run_search, replay="read_only"),
    ]
