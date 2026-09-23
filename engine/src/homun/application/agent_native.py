"""Durable native rounds; source/provenance in homun/notices/hermes-agent.txt.

Like Hermes, persist an assistant round before executing its calls. Unlike a
request-time reconstruction, pending calls survive input and process restarts.
"""
import json
from homun.models.agent_turn import AgentDecision
from homun.models.native_turn import NativeMessage

from homun.application.agent_tool_contracts import PROTOCOL, QUESTION


def enabled(run):
    return run.get('_protocol') == PROTOCOL


def history(run):
    return [NativeMessage.model_validate(m) for m in run['_messages']]


def pending(run):
    messages = history(run)
    answered = {m.tool_call_id for m in messages if m.role == 'tool'}
    return next((c for m in messages for c in m.tool_calls if c.id not in answered), None)


def decision(run):
    call = pending(run)
    if call:
        if call.name == QUESTION.name:
            from homun.application.agent_tool_registry import registry_for
            args = registry_for(run).validate(call.name, call.arguments)
            return AgentDecision(kind='ask', message=args['question'])
        return AgentDecision(kind='tool', tool=call.name, arguments=call.arguments, message=f'Use {call.name}')
    return AgentDecision(kind='finish', message=history(run)[-1].content)


def append_round(run, message):
    message = NativeMessage.model_validate(message)
    if message.role != 'assistant' or pending(run):
        raise ValueError('Cannot append a round while calls are unresolved')
    used = {c.id for m in history(run) for c in m.tool_calls}
    if used.intersection(c.id for c in message.tool_calls):
        raise ValueError('Provider reused a tool call ID')
    if len(message.tool_calls) > run['limits']['max_turns'] - run['turns']:
        raise ValueError('Tool round exceeds remaining turn limit')
    run['_messages'].append(message.model_dump())


def append_result(run, result):
    call = pending(run)
    if call is None:
        raise ValueError('No pending tool call for result')
    from homun.application.agent_results import project
    result = project(run, call.name, call.id, result)
    run['_messages'].append(NativeMessage(role='tool', name=call.name, tool_call_id=call.id,
        content=json.dumps(result, ensure_ascii=False)).model_dump())
    return result
