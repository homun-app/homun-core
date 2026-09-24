"""Tool contracts for procedural skills discovery, disclosure, and proposal (H19/H20).

Derived from Hermes tools/skills_tool.py, tools/skill_manager.py, and
tools/skills_guard.py (MIT).
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry


class SkillSearchArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    query: str | None = Field(default=None, max_length=100)
    tag: str | None = Field(default=None, max_length=50)
    limit: int = Field(default=5, ge=1, le=20)


class SkillViewArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    skill_id: str | None = Field(default=None, max_length=50)
    name: str | None = Field(default=None, max_length=80)


class SkillProposeArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=10000)
    tags: list[str] | None = Field(default=None, max_length=10)


def entries(handler, version=1):
    search_def = ToolDefinition(
        name="skill_search",
        description=(
            "Discover approved procedural skills and guidelines by keyword or tag. "
            "Returns skill metadata without full instruction bodies."
        ),
        input_schema=SkillSearchArguments.model_json_schema(),
    )
    view_def = ToolDefinition(
        name="skill_view",
        description=(
            "Load the full instructions and resource body for an approved skill by ID or exact name."
        ),
        input_schema=SkillViewArguments.model_json_schema(),
    )
    propose_def = ToolDefinition(
        name="skill_propose",
        description=(
            "Propose a new procedural skill learned during task execution. "
            "The proposed skill is quarantined in staging until approved by a human."
        ),
        input_schema=SkillProposeArguments.model_json_schema(),
    )

    def run_search(ctx, actor, run, args):
        return handler(ctx, actor, run, "skill_search", args)

    def run_view(ctx, actor, run, args):
        return handler(ctx, actor, run, "skill_view", args)

    def run_propose(ctx, actor, run, args):
        return handler(ctx, actor, run, "skill_propose", args)

    return [
        ToolEntry(search_def, "skills", str(version), SkillSearchArguments, run_search, replay="read_only"),
        ToolEntry(view_def, "skills", str(version), SkillViewArguments, run_view, replay="read_only"),
        ToolEntry(propose_def, "skills", str(version), SkillProposeArguments, run_propose, replay="read_only"),
    ]
