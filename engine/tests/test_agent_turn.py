"""Typed decisions preserve observations and reject invented tools before IO."""
import json
from types import SimpleNamespace
import pytest


def test_decision_sees_tool_schema_and_observation():
    from homun.models.agent_turn import decide, ToolDefinition
    calls = []
    def complete(messages, **kwargs):
        calls.append((messages, kwargs))
        return SimpleNamespace(text=json.dumps({'kind': 'tool', 'tool': 'read_material',
            'arguments': {'material_id': 'mat_a'}, 'message': 'Leggo il documento'}))
    model = SimpleNamespace(complete=complete)
    result, _ = decide(model, objective='Trova le scadenze', tools=[ToolDefinition(
        name='read_material', description='Read selected material',
        input_schema={'type': 'object', 'properties': {'material_id': {'type': 'string'}}})],
        observations=[{'tool': 'list_materials', 'result': [{'id': 'mat_a'}]}],
        connection_id='local')
    assert result.tool == 'read_material'
    assert calls[0][1]['connection_id'] == 'local'
    payload = json.loads(calls[0][0][1].content)
    assert payload['observations'][0]['result'][0]['id'] == 'mat_a'
    assert payload['tools'][0]['input_schema']['properties']['material_id']['type'] == 'string'


def test_unknown_tool_and_ambiguous_decisions_rejected():
    from homun.models.agent_turn import decide
    for body in [
        {'kind': 'tool', 'tool': 'shell', 'arguments': {}, 'message': 'Run'},
        {'kind': 'finish', 'tool': 'shell', 'arguments': {}, 'message': 'Done'},
        {'kind': 'finish', 'message': ''},
    ]:
        model = SimpleNamespace(complete=lambda *a, **k: SimpleNamespace(text=json.dumps(body)))
        with pytest.raises(ValueError):
            decide(model, objective='Help', tools=[], observations=[])


def test_finish_and_question_are_distinct():
    from homun.models.agent_turn import decide
    for kind in ['finish', 'ask']:
        model = SimpleNamespace(complete=lambda *a, **k: SimpleNamespace(
            text=json.dumps({'kind': kind, 'message': 'Testo per la persona'})))
        result, _ = decide(model, objective='Help', tools=[], observations=[])
        assert result.kind == kind
        assert result.tool is None
