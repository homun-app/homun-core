"""Portable tool decisions over ModelPort; model proposals never authorize IO."""
import json
from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from homun.models.intake import _extract_json_payload
from homun.models.prompt_store import prompts_for
from homun.models.types import ChatMessage


class ToolDefinition(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str
    description: str
    input_schema: dict[str, Any]


class AgentDecision(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['tool', 'finish', 'ask']
    message: str = Field(min_length=1, max_length=16000)
    tool: str | None = None
    arguments: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode='after')
    def consistent(self):
        if not self.message.strip():
            raise ValueError('Decision must contain a message')
        if self.kind == 'tool' and not self.tool:
            raise ValueError('Tool decision requires a tool name')
        if self.kind != 'tool' and (self.tool is not None or self.arguments):
            raise ValueError('Only tool decisions may carry a tool and arguments')
        return self


def decide(models, *, objective, tools, observations, connection_id=None,
           instructions='', language=None):
    """One typed turn, with no hidden retries or side effects beyond model IO.

    JSON transport also works with local providers lacking native tool calling.
    The application validates arguments and permissions independently afterwards.
    """
    system = prompts_for(models).get('agent/decide', language).render(
        schema=json.dumps(AgentDecision.model_json_schema(), ensure_ascii=False))
    payload = {'objective': objective, 'instructions': instructions,
               'tools': [tool.model_dump() for tool in tools], 'observations': observations}
    result = models.complete([
        ChatMessage(role='system', content=system),
        ChatMessage(role='user', content=json.dumps(payload, ensure_ascii=False)),
    ], connection_id=connection_id)
    decision = AgentDecision.model_validate_json(_extract_json_payload(result.text))
    if decision.kind == 'tool' and decision.tool not in {tool.name for tool in tools}:
        raise ValueError('Model requested a tool outside the available catalog')
    return decision, result
