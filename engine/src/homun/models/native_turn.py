"""Canonical tool conversation and transport projection owned by Homun.

Architecture follows Hermes agent/conversation_loop.py and turn_tool_round.py;
see homun/notices/hermes-agent.txt for provenance and upstream MIT license.
"""
import json
from typing import Any, Literal
from uuid import uuid4
from pydantic import BaseModel, ConfigDict, Field, model_validator
from homun.models.types import UsageEntry


class ToolCall(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    arguments: dict[str, Any] = Field(default_factory=dict)


class NativeMessage(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['system', 'user', 'assistant', 'tool']
    content: str = ''
    tool_calls: list[ToolCall] = Field(default_factory=list, max_length=8)
    tool_call_id: str | None = None
    name: str | None = None

    @model_validator(mode='after')
    def consistent(self):
        if self.tool_calls and self.role != 'assistant':
            raise ValueError('Only assistant messages may request tools')
        if len({c.id for c in self.tool_calls}) != len(self.tool_calls):
            raise ValueError('Duplicate tool call IDs')
        if self.role == 'tool' and (not self.tool_call_id or not self.name):
            raise ValueError('Tool results require a call ID and name')
        if self.role != 'tool' and (self.tool_call_id or self.name):
            raise ValueError('Only tool messages may carry result identifiers')
        return self


class NativeResult(BaseModel):
    message: NativeMessage
    usage: UsageEntry


def project_messages(messages, *, ollama=False):
    """Project without mutating the canonical, provider-independent transcript."""
    rows = []
    for message in messages:
        row = {'role': message.role, 'content': message.content}
        if message.tool_calls:
            row['tool_calls'] = [dict(id=c.id, type='function', function={
                'name': c.name, 'arguments': c.arguments if ollama else json.dumps(c.arguments, ensure_ascii=False)
            }) for c in message.tool_calls]
        if message.role == 'tool':
            row['tool_call_id'] = message.tool_call_id
            if ollama:
                row['tool_name'] = message.name
        rows.append(row)
    return rows


def parse_response(response, *, ollama=False):
    try:
        return _parse_response(response, ollama=ollama)
    except (KeyError, IndexError, AttributeError, TypeError) as exc:
        raise ValueError('Malformed native agent response') from exc


def _parse_response(response, *, ollama=False):
    choice = response if ollama else response['choices'][0]
    from homun.models.repetition import is_runaway_repetition, RepetitionError
    if is_runaway_repetition(choice['message'].get('content')):
        raise RepetitionError()
    reason = choice.get('done_reason' if ollama else 'finish_reason')
    if reason == 'length':
        from homun.models.truncation import continuable_text, TruncatedTextError
        text = continuable_text(choice['message'])
        if text is not None:
            raise TruncatedTextError(text)
    if reason not in {'stop', 'tool_calls'}:
        raise ValueError(f'Incomplete agent response: {reason}')
    message = choice['message']
    calls = []
    for call in message.get('tool_calls') or []:
        function = call['function']
        arguments = function.get('arguments', {})
        if isinstance(arguments, str):
            arguments = json.loads(arguments)
        calls.append(ToolCall(id=call.get('id') or f'call_{uuid4().hex}',
                              name=function['name'], arguments=arguments))
    if reason == 'tool_calls' and not calls:
        raise ValueError('Provider declared a tool round without tool calls')
    result = NativeMessage(role='assistant', content=message.get('content') or '', tool_calls=calls)
    if not result.tool_calls and not result.content.strip():
        raise ValueError('Agent response contains neither tools nor a final answer')
    return result
