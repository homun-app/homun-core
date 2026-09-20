"""Typed domain shapes used by the F0.2 spike (not Homun product schema)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class PlanStep(BaseModel):
    id: str
    title: str
    assignee: str
    needs_material: bool = False


class WorkPlan(BaseModel):
    objective: str
    steps: list[PlanStep] = Field(min_length=1)


class Contribution(BaseModel):
    request_id: str
    material_path: str
    note: str = ""


class UncertainReceipt(BaseModel):
    command_id: str
    effect: str
    path: str
