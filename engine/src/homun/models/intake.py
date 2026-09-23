"""Bounded structured intake; recommendations cannot grant capabilities."""
import json
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator
from homun.domain.capabilities import REGISTRY, require_capability
from homun.models.prompt_store import prompts_for
from homun.models.types import ChatMessage

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

RequestKind = Literal['work_request', 'question']
"""A message either asks for a durable work result or just asks / chats."""

class RequestClassification(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: RequestKind
    language: str | None = Field(default=None, max_length=8)
    """Detected language of the request (ISO code such as 'en'); routing aid only."""


class PlanStepDraft(BaseModel):
    """One phase the model may declare for a multi-phase work (slice F1).

    Tolerant on shape (small local models wrap labels in strings or add
    descriptive keys) and strict on meaning: capability stays a registry id
    and assignee must resolve to a real person.
    """
    model_config = ConfigDict(extra='ignore')
    title: str = Field(min_length=1, max_length=120)
    capability: Literal['compare_csv', 'read_material', 'synthesize', 'general'] = 'general'
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
    capability: Literal['compare_csv', 'read_material', 'synthesize', 'general'] = 'general'
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


_MODEL_HIDDEN_KEYS = {"ready", "eligible_materials"}
"""Kept out of the model-facing catalog: readiness signals made small models
decline executable work before the files were uploaded. IO detail stays: it
anchors the output language and never caused the downgrade."""


_CATALOG_LABELS = {
    'it': {'executable': '(eseguibile dal motore)', 'preparation': '(solo preparazione, nessuna esecuzione automatica)',
           'limits': 'Limiti', 'none': 'nessuno',
           'note': 'I materiali si caricano dopo la conferma dell\'accordo: la loro assenza ora non cambia la scelta della capability.'},
    'en': {'executable': '(executable by the engine)', 'preparation': '(preparation only, no automatic execution)',
           'limits': 'Limits', 'none': 'none',
           'note': 'Materials are uploaded after the agreement is confirmed: their absence now does not change the capability choice.'},
}


def _capability_catalog_lines(capabilities, language='it'):
    """Registry-grounded capability descriptions for the model."""
    labels = _CATALOG_LABELS.get(language, _CATALOG_LABELS['it'])
    if not capabilities:
        capabilities = [spec.public() for spec in REGISTRY.values()]
    lines = []
    for item in capabilities:
        limits = ", ".join(f"{key}={value}" for key, value in sorted(item.get("limits", {}).items()))
        if item.get("kind") == "executable":
            lines.append(
                f"- {item['id']} {labels['executable']}: {item['summary']} "
                f"{labels['limits']}: {limits or labels['none']}. {labels['note']}"
            )
        else:
            lines.append(f"- {item['id']} {labels['preparation']}: {item['summary']}")
    return "\n".join(lines)


def _model_capabilities(capabilities):
    """Minimal shape before anything reaches the model."""
    if not capabilities:
        return None
    return [{key: value for key, value in item.items() if key not in _MODEL_HIDDEN_KEYS}
            for item in capabilities]


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


def synthesize(registry, text, agents, *, previous_brief=None, latest_request=None, capabilities=None, language=None, usage_out=None):
    catalog = _model_capabilities(capabilities)
    # Language selection is structural: a known language picks its template, an
    # unknown one falls back to the workspace default. Output language follows
    # the template plus each template's own request-language rule.
    template = prompts_for(registry).get('intake/synthesize', language=language)
    system = template.render(
        schema=json.dumps(IntakeBrief.model_json_schema(), ensure_ascii=False),
        catalog=_capability_catalog_lines(catalog, template.language))
    skills = approved_skills_index()
    payload = json.dumps({'request':text,'latest_request':latest_request or text,'previous_brief':previous_brief,
                          'agents':agents,'skills':skills,
                          'capabilities':catalog or [spec.public() for spec in REGISTRY.values()]},ensure_ascii=False)
    messages = [ChatMessage(role='system',content=system),
                ChatMessage(role='user',content=payload)]
    # Small local models sometimes wrap the schema in prose or drift from it:
    # one strict retry (billed and ledgered like any attempt) keeps the brief
    # durable instead of failing the whole proposal on a formatting hiccup.
    from pydantic import ValidationError as _ValidationError
    for attempt in range(2):
        result = registry.complete(messages if attempt == 0 else
                                   messages + [ChatMessage(role='user',content='La risposta precedente non era JSON valido per lo schema. Restituisci SOLO il JSON valido, senza testo attorno.')])
        usage = getattr(result, 'usage', None)
        if usage_out is not None and usage is not None:
            usage_out.append(usage)
        try:
            brief = IntakeBrief.model_validate_json(_extract_json_payload(result.text))
            break
        except (_ValidationError, ValueError):
            if attempt:
                raise
    if any(len(item)>500 for item in brief.constraints + brief.missing_information):
        raise ValueError('Intake list item too long')
    spec = require_capability(brief.capability)
    if spec.kind == 'executable' and not (brief.suggested_agent_id or brief.new_agent):
        if not agents and spec.fallback_collaborator:
            # Empty roster on a first-run workspace: the engine, not the model,
            # guarantees that executable work always carries a confirmable
            # collaborator proposal. Nothing is created before human confirmation.
            brief.new_agent = NewAgent.model_validate(spec.fallback_collaborator)
        elif len(agents) == 1:
            # A single candidate leaves no recommendation to invent; the person
            # still confirms the assignment explicitly.
            brief.suggested_agent_id = agents[0]['id']
        else:
            raise ValueError('Executable work requires a collaborator proposal')
    if brief.suggested_agent_id and brief.new_agent:
        raise ValueError('Choose existing agent or new profile')
    if brief.suggested_agent_id:
        # Engine-side validation: the recommended agent must have the required
        # capability in its structural link, not just a plausible-sounding role.
        from homun.domain.capabilities import REGISTRY as _registry
        selected = next((a for a in agents if a['id'] == brief.suggested_agent_id), None)
        if selected is None:
            raise ValueError('Suggested agent does not exist in active roster')
        linked = selected.get('capabilities') or []
        if brief.capability in _registry and _registry[brief.capability].kind == 'executable':
            matching = [a for a in agents if brief.capability in (a.get('capabilities') or [])]
            if matching and brief.suggested_agent_id not in [a['id'] for a in matching]:
                # The model recommended someone without the capability link while
                # a linked candidate exists: prefer the linked one.
                brief.suggested_agent_id = matching[0]['id']
    return brief


def classify_request(registry, text, *, pending_brief=None, usage_out=None):
    """Routing only: does this message ask for a work result or just ask a question?

    Stateless by design — the durable record of whatever is said lives in the
    transcript of the path chosen by the caller, never here.
    """
    system = prompts_for(registry).get('intake/classify').render(
        schema=json.dumps(RequestClassification.model_json_schema(), ensure_ascii=False))
    result = registry.complete([ChatMessage(role='system',content=system), ChatMessage(role='user',content=json.dumps({'request':text,'pending_brief':pending_brief},ensure_ascii=False))])
    usage = getattr(result, 'usage', None)
    if usage_out is not None and usage is not None:
        usage_out.append(usage)
    raw = _extract_json_payload(result.text)
    classification = RequestClassification.model_validate_json(raw)
    language = (classification.language or '').strip().lower()[:8] or None
    return classification.kind, language

