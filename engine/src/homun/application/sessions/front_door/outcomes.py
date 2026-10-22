"""From a front-door model decision to a domain outcome — model proposes, engine decides.

Pure conversions and previews: nothing here writes to the store. The turn
orchestrator validates arguments against a fresh snapshot and, only at commit
time, applies outcomes through the same intake / patch paths the UI already
uses.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from homun.application.work.intake_brief import effective_values
from homun.application.work.intake_policy import revisable
from homun.domain.models import Work
from homun.domain.patch import WorkPatchChange, build_preview
from homun.domain.states import WorkStatus
from homun.i18n import user_text
from homun.models.intake import IntakeBrief, validate_brief

from . import tools

TEXT = 'text'
CLARIFICATION = 'clarification'
WORK_PROPOSAL = 'work_proposal'
PLAN_CHANGE = 'plan_change'


@dataclass
class FrontDoorOutcome:
    kind: str
    text: str = ''
    questions: list[dict[str, Any]] = field(default_factory=list)
    brief: IntakeBrief | None = None
    plan_preview: dict[str, Any] | None = None
    # The person's language as the model reported it ('it'/'en'), when it did:
    # the engine remembers it on the conversation and uses it for its texts.
    language: str | None = None


def work_accepts_proposal(work: Work | None, *, anchor: dict | None = None) -> str | None:
    """Engine-side gate mirroring the intake ``idle``/``revisable`` rules, as an error message."""
    if work is None:
        return None
    if anchor is not None and revisable(work):
        return None
    if work.status != WorkStatus.DRAFT or work.current_plan_revision or work.current_artifact_version:
        return ('This work already has an agreement or has started: propose_work needs an idle draft. '
                'Use propose_plan_change for changes, or reply with text.')
    return None


def _blank_non_collaborator_assignees(brief, agents) -> None:
    """Phase assignees that are not active collaborators cannot be assigned.

    The engine, not the model, keeps the proposal confirmable: an unknown name
    is blanked (the standing collaborator takes the phase, visible on the
    card) instead of exhausting the correction budget and losing the turn —
    the message the old check returned is what this does deterministically.
    """
    from homun.models.intake import invalid_plan_step_assignees
    collaborator_name = None
    if brief.suggested_agent_id:
        collaborator_name = next((a['name'] for a in agents if a['id'] == brief.suggested_agent_id), None)
    elif brief.new_agent:
        collaborator_name = brief.new_agent.name
    raw_steps = [step.model_dump() for step in brief.plan_steps]
    invalid = {name.strip().casefold() for name in invalid_plan_step_assignees(raw_steps, agents, collaborator_name)}
    if not invalid:
        return
    for step in brief.plan_steps:
        if (step.assignee or '').strip().casefold() in invalid:
            step.assignee = ''


PATCH_FIELDS = ('objective', 'owner_id', 'step_assignee')


def plan_change_preview(work, plan, arguments, *, roster_ids):
    """Reuse the patch preview builder; issues come back as an error message."""
    unsupported = sorted({change.field for change in arguments.changes} - set(PATCH_FIELDS))
    if unsupported:
        return None, ('propose_plan_change only supports these fields: ' + ', '.join(PATCH_FIELDS)
                      + f'. {", ".join(unsupported)} belong to the work agreement:'
                        ' revise it with propose_work (changed_fields) instead.')
    changes = [WorkPatchChange(field=change.field, to_value=change.to_value, step_id=change.step_id)
               for change in arguments.changes]
    if not changes:
        return None, 'propose_plan_change requires at least one change.'
    preview = build_preview(work, plan, changes, roster_ids=roster_ids)
    if preview.missing_or_ambiguous:
        return None, ('Invalid plan change: ' + '; '.join(preview.missing_or_ambiguous)
                      + '. Only roster/agent ids are valid for owner_id and step_assignee.')
    return preview.model_dump(mode='json'), None


def outcome_from_call(name: str, arguments, *, work, plan, agents, anchor, roster_ids) -> tuple[FrontDoorOutcome | None, str | None]:
    """Validate one tool call against fresh state.

    Returns ``(outcome, None)`` when the model's proposal is valid, or
    ``(None, error_message_for_the_model)`` when it must correct itself.
    """
    if name == tools.ASK_CLARIFICATION:
        try:
            questions = arguments.normalized_questions()
        except ValueError as exc:
            return None, f'Invalid ask_clarification arguments: {exc}'
        return FrontDoorOutcome(kind=CLARIFICATION, questions=questions,
                                language=tools.normalized_language(arguments.language)), None

    if name == tools.PROPOSE_WORK:
        if blocked := work_accepts_proposal(work, anchor=anchor):
            return None, blocked
        try:
            # Su una revisione i campi non detti arrivano dall'accordo
            # esistente (anchor): il modello non deve ripeterli.
            brief = validate_brief(arguments.to_brief(anchor), agents)
            _blank_non_collaborator_assignees(brief, agents)
            # The same effective-agreement rules the first-message path applies
            # before persisting (anchor, staffing, plan-step people): the model
            # learns here, not at commit time.
            effective_values(brief, agents, anchor, owner_id=work.owner_id if work else None)
        except Exception as exc:  # noqa: BLE001 — pydantic or ValueError, both model-correctable
            return None, f'Invalid propose_work arguments: {exc}. Fix the arguments and call again.'
        return FrontDoorOutcome(kind=WORK_PROPOSAL, brief=brief,
                                language=tools.normalized_language(arguments.language)), None

    if name == tools.PROPOSE_PLAN_CHANGE:
        if work is None:
            return None, 'No work is linked to this conversation: propose_work or reply with text instead.'
        if plan is None:
            return None, ('This work has no accepted plan yet, so there is nothing to patch: '
                          'reply with text or use propose_work.')
        preview, error = plan_change_preview(work, plan, arguments, roster_ids=roster_ids)
        if error:
            return None, error
        return FrontDoorOutcome(kind=PLAN_CHANGE, plan_preview=preview,
                                language=tools.normalized_language(arguments.language)), None

    return None, f'Unknown tool: {name}.'


def display_for(outcome: FrontDoorOutcome, *, language: str) -> str:
    """The assistant text shown in chat for each outcome, in the person's language."""
    if outcome.kind == TEXT:
        return outcome.text
    if outcome.kind == CLARIFICATION:
        lines = []
        for question in outcome.questions:
            lines.append(question['question'])
            lines.extend(f'  • {choice}' for choice in question.get('choices') or [])
        return '\n'.join(lines)
    if outcome.kind == WORK_PROPOSAL:
        title = outcome.brief.title if outcome.brief else ''
        missing = outcome.brief.missing_information if outcome.brief else []
        text = user_text('front_door.work_proposed', {'title': title}, language=language) or ''
        if missing:
            joined = '; '.join(missing)
            note = user_text('front_door.work_proposed_missing', {'items': joined}, language=language)
            if note:
                text = f'{text}\n{note}'
        return text
    if outcome.kind == PLAN_CHANGE and outcome.plan_preview:
        lines = outcome.plan_preview.get('summary_lines') or []
        header = user_text('front_door.plan_change_proposed', language=language) or ''
        footer = user_text('front_door.plan_change_confirm', language=language) or ''
        return '\n'.join([header, *lines, footer]).strip()
    return ''
