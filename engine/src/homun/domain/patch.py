"""Versioned work patch types and preview builder (F3.4)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from homun.domain.models import PlanRevision, Work
from homun.domain.states import StepStatus


PatchField = Literal["objective", "owner_id", "step_assignee"]


class WorkPatchChange(BaseModel):
    field: PatchField
    from_value: str | None = None
    to_value: str | None = None
    step_id: str | None = None


class WorkPatchProposal(BaseModel):
    work_id: str
    base_version: int
    changes: list[WorkPatchChange] = Field(default_factory=list)
    summary_lines: list[str] = Field(default_factory=list)
    missing_or_ambiguous: list[str] = Field(default_factory=list)


def build_preview(
    work: Work,
    plan: PlanRevision | None,
    changes: list[WorkPatchChange],
    *,
    roster_ids: set[str],
) -> WorkPatchProposal:
    """Fill from_value + summary; collect validation issues without mutating."""
    filled: list[WorkPatchChange] = []
    issues: list[str] = []
    summaries: list[str] = []

    for raw in changes:
        change = raw.model_copy(deep=True)
        to_value = (change.to_value or "").strip()
        if not to_value:
            issues.append(f"{change.field}: missing to_value")
            filled.append(change)
            continue

        if change.field == "objective":
            change.from_value = work.objective
            change.to_value = to_value
            summaries.append(f"Obiettivo: «{work.objective}» → «{to_value}»")
        elif change.field == "owner_id":
            if to_value not in roster_ids:
                issues.append(f"owner_id unknown: {to_value}")
            change.from_value = work.owner_id
            change.to_value = to_value
            summaries.append(f"Responsabile: {work.owner_id} → {to_value}")
        elif change.field == "step_assignee":
            if plan is None:
                issues.append("no plan to patch")
                filled.append(change)
                continue
            step_id = (change.step_id or "").strip()
            if not step_id:
                pending = next((s for s in plan.steps if s.status == StepStatus.PENDING), None)
                step_id = pending.id if pending else ""
                change.step_id = step_id or None
            step = next((s for s in plan.steps if s.id == step_id), None) if step_id else None
            if step is None:
                issues.append(f"unknown step_id: {change.step_id or '(missing)'}")
            else:
                if to_value not in roster_ids:
                    issues.append(f"assignee unknown: {to_value}")
                change.from_value = step.assignee_id
                change.to_value = to_value
                summaries.append(f"Passo «{step.title}»: {step.assignee_id} → {to_value}")
        else:
            # Exhaustiveness: PatchField has no other members in first cut.
            issues.append(f"unsupported field: {change.field}")

        filled.append(change)

    if not filled:
        issues.append("no changes")

    return WorkPatchProposal(
        work_id=work.id,
        base_version=work.version,
        changes=filled,
        summary_lines=summaries,
        missing_or_ambiguous=issues,
    )
