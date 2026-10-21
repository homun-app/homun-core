"""Front-door tool catalog: tolerant in shape, strict in meaning.

The schemas sent to the model stay simple (three required fields for
``propose_work``); the argument models below accept what small models actually
emit — ``null`` lists, single strings instead of lists, unknown keys — exactly
like ``PlanStepDraft``. Meaning is enforced afterwards by the shared
``validate_brief`` rules, never by schema rigidity.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from homun.models.agent_turn import ToolDefinition
from homun.models.intake import IntakeBrief, PlanStepDraft
from homun.models.prompt_store import prompts_for

ASK_CLARIFICATION = 'ask_clarification'
PROPOSE_WORK = 'propose_work'
PROPOSE_PLAN_CHANGE = 'propose_plan_change'

# Catalog order as the model reads it: small models lean on the first entry,
# and proposing the agreement (with missing_information) is the safe default.
TOOL_ORDER = (PROPOSE_WORK, ASK_CLARIFICATION, PROPOSE_PLAN_CHANGE)

CAPABILITY_VALUES = ('general', 'synthesize', 'read_material', 'compare_csv', 'agent_run')


def _tolerant_list(value):
    """``None`` → empty list; a bare string → one-element list."""
    if value is None:
        return []
    if isinstance(value, str):
        stripped = value.strip()
        return [stripped] if stripped else []
    return value


class _TolerantModel(BaseModel):
    model_config = ConfigDict(extra='ignore')


class NewAgentDraft(_TolerantModel):
    name: str = Field(min_length=1, max_length=80)
    role: str = Field(min_length=1, max_length=180)
    instructions: str = Field(default='Profilo proposto dalla chat.', max_length=2000)
    responsibility: str = Field(default='', max_length=500)
    specializations: list[str] = Field(default_factory=list, max_length=12)
    method: str = Field(default='', max_length=500)
    tone: str = Field(default='', max_length=120)
    capabilities: list[str] = Field(default_factory=list, max_length=8)

    @field_validator('specializations', 'capabilities', mode='before')
    @classmethod
    def _list(cls, value):
        return _tolerant_list(value)


class PlanStepDraftArgs(_TolerantModel):
    title: str = Field(min_length=1, max_length=120)
    capability: str = 'general'
    expected_materials: list[str] = Field(default_factory=list, max_length=6)
    output_expected: str = Field(default='', max_length=300)
    assignee: str = Field(default='', max_length=80)

    @field_validator('expected_materials', mode='before')
    @classmethod
    def _labels(cls, value):
        return _tolerant_list(value)


class ProposeWorkArgs(_TolerantModel):
    """``propose_work`` arguments: few required fields, tolerant lists."""

    title: str = Field(min_length=1, max_length=100)
    objective: str = Field(min_length=1, max_length=700)
    output: str = Field(min_length=1, max_length=500)
    constraints: list[str] = Field(default_factory=list, max_length=12)
    missing_information: list[str] = Field(default_factory=list, max_length=12)
    suggested_agent_id: str | None = None
    new_agent: NewAgentDraft | None = None
    rationale: str | None = Field(default=None, max_length=1000)
    capability: str = 'general'
    changed_fields: list[str] = Field(default_factory=list, max_length=6)
    plan_steps: list[PlanStepDraftArgs] = Field(default_factory=list, max_length=5)

    @field_validator('constraints', 'missing_information', 'changed_fields', mode='before')
    @classmethod
    def _lists(cls, value):
        return _tolerant_list(value)

    def to_brief(self) -> IntakeBrief:
        """Project onto the strict IntakeBrief; validation stays with the engine."""
        return IntakeBrief(
            title=self.title.strip(),
            objective=self.objective.strip(),
            output=self.output.strip(),
            constraints=self.constraints,
            missing_information=self.missing_information,
            suggested_agent_id=self.suggested_agent_id,
            new_agent=self.new_agent.model_dump() if self.new_agent else None,
            rationale=(self.rationale or '').strip() or f'{self.title.strip()[:80]} — proposta dalla chat',
            capability=self.capability,
            changed_fields=self.changed_fields,
            plan_steps=[PlanStepDraft.model_validate(step.model_dump()) for step in self.plan_steps],
        )


class ClarifyQuestion(_TolerantModel):
    question: str = Field(min_length=1, max_length=1000)
    choices: list[str] = Field(default_factory=list, max_length=4)
    multi_select: bool = False

    @field_validator('choices', mode='before')
    @classmethod
    def _choices(cls, value):
        return _tolerant_list(value)


class AskClarificationArgs(_TolerantModel):
    """Same contract as the agent ``ClarifyArguments``: questions, or one question."""

    questions: list[Any] | None = None
    question: str | None = None
    choices: list[str] | None = None
    multi_select: bool = False

    @field_validator('questions', 'choices', mode='before')
    @classmethod
    def _lists(cls, value):
        return _tolerant_list(value)

    def normalized_questions(self) -> list[dict[str, Any]]:
        """Plain question dicts for the transcript payload; raises when empty."""
        raw = list(self.questions or [])
        if not raw and (self.question or '').strip():
            raw = [{'question': self.question, 'choices': self.choices or [], 'multi_select': self.multi_select}]
        questions = []
        for item in raw:
            if isinstance(item, str):
                text = item.strip()
                if text:
                    questions.append({'question': text, 'choices': [], 'multi_select': False})
                continue
            parsed = ClarifyQuestion.model_validate(item)
            questions.append({'question': parsed.question, 'choices': parsed.choices,
                              'multi_select': parsed.multi_select})
        if not questions:
            raise ValueError('ask_clarification requires at least one question')
        return questions[:5]


class PlanChangeDraftArgs(_TolerantModel):
    field: str
    to_value: str | None = None
    step_id: str | None = None


class ProposePlanChangeArgs(_TolerantModel):
    changes: list[PlanChangeDraftArgs] = Field(default_factory=list)

    @field_validator('changes', mode='before')
    @classmethod
    def _changes(cls, value):
        return _tolerant_list(value)


PROPOSE_WORK_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'title': {'type': 'string'},
        'objective': {'type': 'string'},
        'output': {'type': 'string'},
        'constraints': {'type': 'array', 'items': {'type': 'string'}},
        'missing_information': {'type': 'array', 'items': {'type': 'string'}},
        'capability': {'type': 'string', 'enum': list(CAPABILITY_VALUES)},
        'suggested_agent_id': {'type': 'string'},
        'new_agent': {'type': 'object'},
        'rationale': {'type': 'string'},
        'changed_fields': {'type': 'array', 'items': {'type': 'string', 'enum': [
            'title', 'objective', 'output', 'constraints', 'capability', 'staffing', 'plan_steps']}},
        'plan_steps': {'type': 'array', 'items': {
            'type': 'object',
            'properties': {'title': {'type': 'string'}, 'capability': {'type': 'string'},
                           'assignee': {'type': 'string'}, 'output_expected': {'type': 'string'},
                           'expected_materials': {'type': 'array', 'items': {'type': 'string'}}},
        }},
    },
    'required': ['title', 'objective', 'output'],
}

CLARIFY_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'questions': {'type': 'array', 'items': {
            'type': 'object',
            'properties': {'question': {'type': 'string'},
                           'choices': {'type': 'array', 'items': {'type': 'string'}},
                           'multi_select': {'type': 'boolean'}},
            'required': ['question'],
        }},
        'question': {'type': 'string'},
        'choices': {'type': 'array', 'items': {'type': 'string'}},
        'multi_select': {'type': 'boolean'},
    },
}

PLAN_CHANGE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'changes': {'type': 'array', 'items': {
            'type': 'object',
            'properties': {'field': {'type': 'string', 'enum': ['objective', 'owner_id', 'step_assignee']},
                           'to_value': {'type': 'string'}, 'step_id': {'type': 'string'}},
            'required': ['field'],
        }},
    },
    'required': ['changes'],
}

_ARGUMENT_MODELS = {
    ASK_CLARIFICATION: AskClarificationArgs,
    PROPOSE_WORK: ProposeWorkArgs,
    PROPOSE_PLAN_CHANGE: ProposePlanChangeArgs,
}

_SCHEMAS = {
    ASK_CLARIFICATION: CLARIFY_SCHEMA,
    PROPOSE_WORK: PROPOSE_WORK_SCHEMA,
    PROPOSE_PLAN_CHANGE: PLAN_CHANGE_SCHEMA,
}


def parse_arguments(name: str, arguments: dict[str, Any]):
    """Tolerant parse of one tool call's arguments; raises with a model-facing message."""
    model = _ARGUMENT_MODELS.get(name)
    if model is None:
        raise ValueError(f'Unknown tool: {name}. Available: ask_clarification, propose_work, propose_plan_change.')
    return model.model_validate(arguments or {})


def front_door_tools(registry, language: str | None) -> list[ToolDefinition]:
    """Tool definitions with descriptions in the prompt's language."""
    prompts = prompts_for(registry)
    return [ToolDefinition(name=name, description=prompts.get(f'front_door/tool.{name}', language).text.strip(),
                           input_schema=_SCHEMAS[name])
            for name in TOOL_ORDER]


def tools_block(tools: list[ToolDefinition]) -> str:
    """Compact catalog for the system prompt (small models read it twice: here
    and in the tools parameter)."""
    import json
    return '\n\n'.join(f'{tool.name}\n{tool.description}\nArgomenti (JSON): '
                       f'{json.dumps(tool.input_schema, ensure_ascii=False)}' for tool in tools)
