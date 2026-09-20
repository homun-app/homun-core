"""Provider request tests with deterministic models; never call a live endpoint."""
from types import SimpleNamespace

import pytest

from homun.models.conversation_context import ContextManifest, ConversationContext
from homun.models.interpret import run_interpret
from homun.models.interpretation import MessageInterpretation
from homun.models.types import ChatMessage
from homun.planning.extract import extract_plan_draft


def context():
    return ConversationContext(messages=[
        ChatMessage(role='user', content='Compare the September price list.'),
        ChatMessage(role='assistant', content='Which country?'),
    ], manifest=ContextManifest(conversation_id='conv', current_message_id='now', cutoff_sequence=3))


@pytest.mark.parametrize('operation', ['interpret', 'plan'])
def test_json_requests_keep_native_roles_and_exact_current_input(operation):
    seen = []
    output = ({'kind': 'reply', 'text': 'ok'} if operation == 'interpret' else
              {'objective': 'September Italy', 'expected_result': 'Comparison', 'steps': []})
    import json
    registry = SimpleNamespace(active_provider_id='openai_compatible',
        _openai=SimpleNamespace(base_url='http://localhost:11434/v1', _api_key=lambda: 'test'),
        complete=lambda messages, **kw: seen.append(messages) or SimpleNamespace(text=json.dumps(output)))
    original = context()
    original.manifest.omitted_count = 4
    before = original.model_dump()
    text = '  Italy.\nUse EUR.  '
    if operation == 'interpret':
        result = run_interpret(registry, text, roster=[], provider_id='openai_compatible', conversation_context=original)
        assert result.kind == 'reply'
    else:
        result = extract_plan_draft(registry, text, roster=[], conversation_context=original)
        assert result.objective == 'September Italy'
    assert [m.role for m in seen[0]] == ['user', 'assistant', 'user']
    assert seen[0][-1].content.endswith('User message:\n' + text)
    assert '4 authorized messages omitted' in seen[0][-1].content
    assert original.model_dump() == before


def test_structured_adapter_passes_history_as_native_pydantic_messages():
    from pydantic_ai.messages import ModelRequest, ModelResponse, ToolCallPart
    from pydantic_ai.models.function import FunctionModel
    from homun.models.adapters.pydantic_ai import structured_output
    seen = []
    def model(messages, info):
        seen.append(messages)
        return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name,
                                                {'kind': 'reply', 'text': 'Italy'})])
    result = structured_output(model=FunctionModel(model), instructions='Classify current input',
        user_prompt='  Italy  ', output_type=MessageInterpretation, history=context().messages)
    assert result.text == 'Italy'
    messages = seen[0]
    assert isinstance(messages[0], ModelRequest)
    assert isinstance(messages[1], ModelResponse)
    assert messages[0].parts[0].content == 'Compare the September price list.'
    assert messages[1].parts[0].content == 'Which country?'
    assert messages[-1].parts[-1].content == '  Italy  '


@pytest.mark.parametrize('operation', ['interpret', 'plan'])
def test_structured_path_and_json_fallback_share_selected_context(operation, monkeypatch):
    from homun.models.adapters import pydantic_ai as adapter
    import json
    selected = context()
    calls = []
    monkeypatch.setattr(adapter, 'build_openai_compatible_chat_model', lambda **kw: object())
    def structured(**kw):
        calls.append(('structured', kw['history']))
        raise RuntimeError('Structured unsupported')
    monkeypatch.setattr(adapter, 'structured_output', structured)
    output = ({'kind': 'reply', 'text': 'ok'} if operation == 'interpret' else
              {'objective': 'Italy', 'expected_result': 'Comparison', 'steps': []})
    registry = SimpleNamespace(active_provider_id='openai_compatible',
        _openai=SimpleNamespace(base_url='https://example.invalid/v1', default_model='test', _api_key=lambda: 'test'),
        complete=lambda messages, **kw: calls.append(('json', messages[:-1])) or SimpleNamespace(text=json.dumps(output)))
    if operation == 'interpret':
        run_interpret(registry, 'Italy', roster=[], provider_id='openai_compatible', conversation_context=selected)
    else:
        extract_plan_draft(registry, 'Italy', roster=[], conversation_context=selected)
    assert calls == [('structured', selected.messages), ('json', selected.messages)]
