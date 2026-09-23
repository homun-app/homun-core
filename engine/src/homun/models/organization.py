"""Bounded company context and grounded team suggestions; never executes tools."""
import json
from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field, field_validator
from homun.domain.capabilities import REGISTRY
from homun.models.types import ChatMessage
from homun.models.prompt_store import prompts_for

BoundedNote = Annotated[str, Field(min_length=1, max_length=600)]

class OrganizationContext(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    company: str = Field(default='', max_length=6000)
    people: str = Field(default='', max_length=4000)
    tools: str = Field(default='', max_length=4000)
    goals: str = Field(default='', max_length=6000)
    team_size: int | None = Field(default=None, ge=1, le=6)

class ProposedAgent(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=80)
    role: str = Field(min_length=1, max_length=180)
    instructions: str = Field(min_length=1, max_length=2000)
    capabilities: list[str] = Field(default_factory=list, max_length=8)
    tools_required: list[BoundedNote] = Field(default_factory=list, max_length=8)

    @field_validator('capabilities')
    @classmethod
    def known_capabilities(cls, values):
        if any(value not in REGISTRY for value in values):
            raise ValueError('Unknown capability')
        return values

class TeamProposal(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(max_length=1000)
    agents: list[ProposedAgent] = Field(min_length=1, max_length=6)
    questions: list[BoundedNote] = Field(default_factory=list, max_length=8)
    limitations: list[BoundedNote] = Field(default_factory=list, max_length=8)

def generate(registry, context):
    schema = TeamProposal.model_json_schema()
    if context.get('team_size') is not None:
        schema['properties']['agents'].update(minItems=context['team_size'], maxItems=context['team_size'])
    system = prompts_for(registry).get('organization/propose').render(schema=json.dumps(schema, ensure_ascii=False))
    result = registry.complete([ChatMessage(role='system', content=system), ChatMessage(role='user', content=json.dumps({
        'context': context, 'capabilities': [spec.public() for spec in REGISTRY.values()]
    }, ensure_ascii=False))])
    proposal = TeamProposal.model_validate_json(result.text)
    if context.get('team_size') is not None and len(proposal.agents) != context['team_size']:
        raise ValueError('Model did not respect the requested team size')
    return proposal.model_dump()
