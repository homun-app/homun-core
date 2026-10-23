"""Bounded structured intake; recommendations cannot grant capabilities."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator
from homun.domain.capabilities import REGISTRY, require_capability

class NewAgent(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=80)
    role: str = Field(min_length=1, max_length=180)
    instructions: str = Field(min_length=1, max_length=2000)
    responsibility: str = Field(default='', max_length=500)
    specializations: list[str] = Field(default_factory=list, max_length=12)
    method: str = Field(default='', max_length=500)
    tone: str = Field(default='', max_length=120)
    capabilities: list[str] = Field(default_factory=list, max_length=8)

BriefField = Literal['title', 'objective', 'output', 'constraints', 'capability', 'staffing', 'plan_steps']
"""Parts of a brief the model may declare as intentionally changed by a clarification."""

_BRIEF_FIELDS = {'title', 'objective', 'output', 'constraints', 'capability', 'staffing', 'plan_steps'}


class PlanStepDraft(BaseModel):
    """One phase the model may declare for a multi-phase work (slice F1).

    Tolerant on shape (small local models wrap labels in strings or add
    descriptive keys) and strict on meaning: capability stays a registry id
    and assignee must resolve to a real person.
    """
    model_config = ConfigDict(extra='ignore')
    title: str = Field(min_length=1, max_length=120)
    capability: Literal['compare_csv', 'read_material', 'synthesize', 'general', 'agent_run'] = 'general'
    expected_materials: list[str] = Field(default_factory=list, max_length=6)
    """Human labels of what this phase waits for; display only, never matched to files."""
    output_expected: str = Field(default='', max_length=300)
    assignee: str = Field(default='', max_length=80)
    """Display name of an active roster collaborator, or of the brief's proposed one."""

    @field_validator('expected_materials', mode='before')
    @classmethod
    def _coerce_labels(cls, value):
        if isinstance(value, str):
            stripped = value.strip()
            return [stripped] if stripped else []
        return value


class IntakeBrief(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=100)
    objective: str = Field(min_length=1, max_length=700)
    output: str = Field(min_length=1, max_length=500)
    constraints: list[str] = Field(default_factory=list, max_length=12)
    missing_information: list[str] = Field(default_factory=list, max_length=12)
    suggested_agent_id: str | None = None
    new_agent: NewAgent | None = None
    rationale: str = Field(min_length=1, max_length=1000)
    capability: Literal['compare_csv', 'read_material', 'synthesize', 'general', 'agent_run'] = 'general'
    changed_fields: list[BriefField] = Field(default_factory=list, max_length=6)
    plan_steps: list[PlanStepDraft] = Field(default_factory=list, max_length=5)
    """Optional phases (raccolta → confronto → sintesi); the engine validates them."""

    @field_validator('changed_fields', mode='before')
    @classmethod
    def _known_fields_only(cls, value):
        # Models sometimes echo catalog vocabulary here; unknown entries only
        # ever shrink the declared set, which preserves more of the brief.
        if not isinstance(value, list):
            return value
        return [item for item in value if item in _BRIEF_FIELDS]


def invalid_plan_step_assignees(steps, agents, collaborator_name) -> list[str]:
    """Phase assignees that resolve to nobody: not an active roster collaborator
    and not the brief's own proposed one. An empty name is the default (the
    brief's collaborator takes the phase) and is always valid."""
    roster = {agent['name'].strip().casefold() for agent in agents}
    collaborator = (collaborator_name or '').strip().casefold()
    invalid = []
    for step in steps or []:
        raw = (step.get('assignee', '') if isinstance(step, dict) else step.assignee)
        name = str(raw).strip()
        if name and name.casefold() not in roster and name.casefold() != collaborator:
            invalid.append(name)
    return invalid


def plan_step_assignee_error(invalid: list[str], agents, collaborator_name) -> str:
    """The correction a model can act on: who was wrong and who is allowed."""
    allowed = sorted({agent['name'] for agent in agents} | ({collaborator_name} if collaborator_name else set()))
    options = ', '.join(f"'{name}'" for name in allowed) or 'none yet'
    return (f"Plan step assignee not in the active roster: {', '.join(repr(n) for n in invalid)}. "
            f"Valid assignees: {options}; leave assignee empty for the proposed collaborator. "
            "People named in the request who are not collaborators belong in the step title or the constraints.")


def validate_brief(brief: IntakeBrief, agents: list[dict]) -> IntakeBrief:
    """The ONE engine-side validation of a brief as the model produced it.

    Used both by ``synthesize`` (first-message intake) and by the front-door
    native turn (``propose_work`` arguments): registry capability, staffing
    consistency and length limits. The people named in the phases are checked
    afterwards, on the EFFECTIVE agreement (``effective_values``), because a
    staffing-only refinement may legitimately echo old assignments that the
    engine normalises before persisting. Raises ``ValueError`` or
    ``pydantic.ValidationError`` — the caller decides whether that becomes a
    failed proposal or a tool error the model can correct.
    """
    if any(len(item) > 500 for item in brief.constraints + brief.missing_information):
        raise ValueError('Intake list item too long')
    require_capability(brief.capability)
    if brief.suggested_agent_id and brief.new_agent:
        raise ValueError('Choose existing agent or new profile')
    if brief.suggested_agent_id:
        # Engine-side validation: the recommended agent must have the required
        # capability in its structural link, not just a plausible-sounding role.
        selected = next((a for a in agents if a['id'] == brief.suggested_agent_id), None)
        if selected is None:
            raise ValueError('Suggested agent does not exist in active roster')
        if brief.capability in REGISTRY and REGISTRY[brief.capability].kind == 'executable':
            matching = [a for a in agents if brief.capability in (a.get('capabilities') or [])]
            if matching and brief.suggested_agent_id not in [a['id'] for a in matching]:
                # The model recommended someone without the capability link while
                # a linked candidate exists: prefer the linked one.
                brief.suggested_agent_id = matching[0]['id']
    return brief


def _extract_json_payload(text):
    """Tolerant extraction shared with the interpret parser (see json_payload)."""
    from homun.models.json_payload import extract_json_payload
    return extract_json_payload(text)


def approved_skills_index() -> list:
    """L0 skill index for the model: name and description of approved skills only."""
    from homun.context import get_context
    try:
        store = get_context().repository.load()
    except Exception:
        return []
    return [{'name': s.name, 'description': s.description}
            for s in sorted(store.skills.values(), key=lambda s: s.name)
            if s.status == 'approved'][:40]
