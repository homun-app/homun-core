"""Durable native rounds; source/provenance in homun/notices/hermes-agent.txt.

Like Hermes, persist an assistant round before executing its calls. Unlike a
request-time reconstruction, pending calls survive input and process restarts.
"""
import json
from homun.models.agent_turn import AgentDecision, ToolDefinition
from homun.models.native_turn import NativeMessage

PROTOCOL = 'native-tools-v1'
QUESTION = ToolDefinition(name='request_user_input', description='Ask for required information unavailable through tools. Execution waits for the authorized human response.',
    input_schema={'type':'object', 'properties':{'question':{'type':'string','minLength':1,'maxLength':16000}},
                  'required':['question'],'additionalProperties':False})


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
            question = call.arguments.get('question')
            if not isinstance(question, str) or not question.strip() or set(call.arguments) != {'question'}:
                raise ValueError('Invalid human question')
            return AgentDecision(kind='ask', message=question)
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
    run['_messages'].append(NativeMessage(role='tool', name=call.name, tool_call_id=call.id,
        content=json.dumps(result, ensure_ascii=False)).model_dump())
