"""Plan draft types and validation (F3.3)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class PlanStepDraft(BaseModel):
    title: str
    assignee_id: str
    output_expected: str = ""
    depends_on: list[str] = Field(default_factory=list)


class PlanDraft(BaseModel):
    objective: str = ""
    expected_result: str = ""
    criteria: list[str] = Field(default_factory=list)
    steps: list[PlanStepDraft] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)


def validate_plan_draft(draft: PlanDraft, *, allowed_assignee_ids: set[str]) -> PlanDraft:
    """Return a copy with missing_fields/questions filled; never invent assignees."""
    missing: list[str] = []
    questions: list[str] = []
    steps: list[PlanStepDraft] = []

    objective = draft.objective.strip()
    expected = draft.expected_result.strip()
    if not objective:
        missing.append("objective")
        questions.append("Qual è l'obiettivo del lavoro?")
    if not expected:
        missing.append("expected_result")
        questions.append("Quale risultato atteso deve essere verificabile?")

    if not draft.steps:
        missing.append("steps")
        questions.append("Quali passi servono e chi li svolge?")
    else:
        for index, step in enumerate(draft.steps, start=1):
            title = step.title.strip()
            assignee = step.assignee_id.strip()
            if not title:
                missing.append(f"steps[{index}].title")
                questions.append(f"Manca il titolo del passo {index}.")
                continue
            if not assignee:
                missing.append(f"steps[{index}].assignee_id")
                questions.append(f"Chi è responsabile del passo «{title}»?")
                continue
            if allowed_assignee_ids and assignee not in allowed_assignee_ids:
                missing.append(f"steps[{index}].assignee_id")
                questions.append(
                    f"L'assegnatario «{assignee}» non è nel roster. Scegli un ID noto per «{title}»."
                )
                continue
            steps.append(
                PlanStepDraft(
                    title=title,
                    assignee_id=assignee,
                    output_expected=step.output_expected.strip(),
                    depends_on=list(step.depends_on),
                )
            )
        if draft.steps and not steps and "steps" not in missing:
            missing.append("steps")
            questions.append("Nessun passo valido dopo i controlli di roster.")

    return PlanDraft(
        objective=objective,
        expected_result=expected,
        criteria=[c.strip() for c in draft.criteria if c.strip()],
        steps=steps if not missing else list(draft.steps),
        missing_fields=missing,
        questions=questions,
    )


def format_plan_draft_for_chat(draft: PlanDraft, *, proposed: bool, revision: int | None = None) -> str:
    if draft.missing_fields:
        lines = ["Serve qualche dato prima di creare la bozza piano:"]
        lines.extend(f"- {q}" for q in draft.questions)
        return "\n".join(lines)
    lines = [
        f"Obiettivo: {draft.objective}",
        f"Risultato atteso: {draft.expected_result}",
    ]
    if draft.criteria:
        lines.append("Criteri: " + "; ".join(draft.criteria))
    lines.append("Passi:")
    for index, step in enumerate(draft.steps, start=1):
        out = f" → {step.output_expected}" if step.output_expected else ""
        lines.append(f"  {index}. {step.title} (@{step.assignee_id}){out}")
    if proposed and revision is not None:
        lines.append(f"Bozza piano creata sul dominio (revisione {revision}).")
    elif not proposed:
        lines.append("(Bozza non ancora applicata al dominio.)")
    return "\n".join(lines)
