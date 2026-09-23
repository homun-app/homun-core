from copy import deepcopy

import pytest
from pydantic import BaseModel, ConfigDict

from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError
from homun.models.agent_turn import ToolDefinition
from homun.tools.registry import ToolEntry, ToolRegistry


class Arguments(BaseModel):
    model_config = ConfigDict(extra='forbid')
    count: int


def entry(name='read', handler=None, **kwargs):
    return ToolEntry(ToolDefinition(name=name, description='Read project files',
                                   input_schema=Arguments.model_json_schema()),
                     'project', '1', Arguments, handler, **kwargs)


def test_registration_snapshots_schema_and_returns_independent_definitions():
    registry = ToolRegistry()
    original = entry()
    registry.register(original)
    pinned = registry.manifest()
    original.definition.input_schema['properties'].clear()
    original.definition.name = 'changed'
    definitions = registry.definitions()
    definitions[0].input_schema.clear()
    assert registry.definitions()[0].name == 'read'
    assert 'count' in registry.definitions()[0].input_schema['properties']
    assert registry.manifest() == pinned
    assert ToolRegistry().definitions() == []
    with pytest.raises(ConflictError):
        registry.register(entry())


def test_manifest_is_deterministic_and_detects_drift():
    a, b = ToolRegistry(), ToolRegistry()
    for name in ['z', 'a']:
        a.register(entry(name))
    for name in ['a', 'z']:
        b.register(entry(name))
    assert a.manifest() == b.manifest()
    assert len(a.manifest()[0]['schema_hash']) == 64
    a.validate_manifest(b.manifest())
    changed = deepcopy(a.manifest())
    changed[0]['version'] = '2'
    with pytest.raises(ConflictError):
        a.validate_manifest(changed)


@pytest.mark.parametrize('args', [{'count': '1'}, {'count': True}, {'count': 1, 'extra': 1}, {}, []])
def test_arguments_strict_and_unknown_names_fail(args):
    registry = ToolRegistry()
    registry.register(entry())
    with pytest.raises(ValidationError):
        registry.validate('read', args)
    with pytest.raises(ValidationError):
        registry.validate('unknown', {'count': 1})


def test_dispatch_validates_then_calls_handler_with_context():
    registry = ToolRegistry()
    calls = []
    def handler(ctx, actor, run, arguments):
        calls.append((ctx, actor, run, arguments))
        return {'result': arguments['count']}
    registry.register(entry(handler=handler))
    assert registry.dispatch('read', {'count': 3}, ctx='ctx', actor='actor', run='run') == {'result': 3}
    assert calls == [('ctx', 'actor', 'run', {'count': 3})]
    with pytest.raises(ValidationError):
        registry.dispatch('read', {'count': '3'}, ctx=None, actor=None, run=None)
    assert len(calls) == 1


@pytest.mark.parametrize('failure', [PermissionDeniedError('denied'), ConflictError('stale'), RuntimeError('broken')])
def test_dispatch_propagates_original_failures(failure):
    registry = ToolRegistry()
    def handler(*args):
        raise failure
    registry.register(entry(handler=handler))
    with pytest.raises(type(failure)) as caught:
        registry.dispatch('read', {'count': 1}, ctx=None, actor=None, run=None)
    assert caught.value is failure


def test_ask_without_handler_and_search_never_execute():
    registry = ToolRegistry()
    registry.register(entry('ask', kind='ask', replay='never'))
    registry.register(entry('read', handler=lambda *args: pytest.fail('Executed during search')))
    assert [r['name'] for r in registry.search('PROJECT', limit=1)] == ['ask']
    assert len(registry.search('files')) == 2
    assert registry.search('missing') == []
    assert registry.search('project', limit=0) == []
    assert registry.search('project')[0]['kind'] == 'ask'
    with pytest.raises(ValidationError):
        registry.dispatch('ask', {'count': 1}, ctx=None, actor=None, run=None)


def test_validation_contract_survives_callers_rebuilding_the_argument_model():
    class MutableArguments(BaseModel):
        model_config = ConfigDict(extra='forbid')
        count: int
    registry = ToolRegistry()
    registry.register(ToolEntry(
        ToolDefinition(name='read', description='Read', input_schema=MutableArguments.model_json_schema()),
        'project', '1', MutableArguments))
    MutableArguments.model_fields.clear()
    MutableArguments.model_rebuild(force=True)
    assert registry.validate('read', {'count': 7}) == {'count': 7}
    with pytest.raises(ValidationError):
        registry.validate('read', {'count': 7, 'extra': 'bad'})


def test_manifest_detects_description_only_changes():
    original, changed = ToolRegistry(), ToolRegistry()
    original.register(entry())
    altered = entry()
    altered.definition.description = 'Different model-facing instructions'
    changed.register(altered)
    assert original.manifest()[0]['schema_hash'] == changed.manifest()[0]['schema_hash']
    assert original.manifest()[0]['definition_hash'] != changed.manifest()[0]['definition_hash']
    with pytest.raises(ConflictError):
        changed.validate_manifest(original.manifest())


def test_validation_error_does_not_echo_argument_values():
    registry = ToolRegistry()
    registry.register(entry())
    secret = 'private-credential-value'
    with pytest.raises(ValidationError) as caught:
        registry.validate('read', {'count': secret})
    assert secret not in str(caught.value)
    assert caught.value.__cause__ is not None
