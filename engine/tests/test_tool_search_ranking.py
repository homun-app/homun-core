from homun.tools.registry import ToolRegistry, ToolEntry
from homun.models.agent_turn import ToolDefinition
from homun.application.agent_tools import NoArguments


def catalog(rows):
    registry = ToolRegistry()
    for name, description in rows:
        registry.register(ToolEntry(ToolDefinition(name=name, description=description,
            input_schema=NoArguments.model_json_schema()), 'project', '1', NoArguments))
    return registry


def names(registry, query, limit=5):
    return [r['name'] for r in registry.search(query, limit)]


def test_exact_name_beats_description_and_word_boundaries():
    registry = catalog([('a', 'read_record read_record read_record'), ('read_record', 'Read one item')])
    assert names(registry, 'read_record')[0] == 'read_record'
    assert set(names(registry, 'record')) == {'read_record', 'a'}
    assert names(registry, 'cord') == []


def test_rarest_intent_and_coverage_exclude_unrelated_tools():
    registry = catalog([('gmail_send', 'Send email gmail'), ('incident', 'Send email incident'),
        ('read', 'Read email incident'), ('python', 'Execute python shell'), ('rerun', 'Run workflow command')])
    assert names(registry, 'send gmail email') == ['gmail_send']
    assert names(registry, 'send unknown email') == []
    assert names(registry, 'run shell command execute code python') == []


def test_ranked_partial_match_and_deterministic_ties():
    rows = [('a', 'Read archive'), ('b', 'Read files'), ('c', 'archive files')]
    registry = catalog(rows)
    assert names(registry, 'read archive') == ['a', 'b']
    assert names(catalog(list(reversed(rows))), 'read archive') == names(registry, 'read archive')
    assert names(registry, '   ') == []
    assert names(registry, 'read', 1) == ['a']


def test_schema_parameter_and_unicode_are_searchable_without_schema_noise():
    from pydantic import BaseModel
    class Args(BaseModel):
        città: str
    registry = ToolRegistry()
    registry.register(ToolEntry(ToolDefinition(name='weather', description='Forecast',
        input_schema=Args.model_json_schema()), 'meteo', '1', Args))
    assert names(registry, 'CITTÀ') == ['weather']
    assert names(registry, 'string') == []


def test_long_query_requires_half_the_answerable_terms():
    registry = catalog([('a', 'run shell'), ('b', 'command execute'), ('c', 'python run'),
                        ('d', 'run shell command')])
    assert names(registry, 'python run shell command execute') == []
    assert names(registry, 'run shell command') == ['d', 'a']


def test_half_coverage_boundary_accepts_exactly_two_of_four_known_terms():
    registry = catalog([('below', 'rare'), ('boundary', 'rare alpha'),
        ('x', 'alpha beta gamma'), ('y', 'alpha beta gamma'), ('z', 'beta gamma')])
    assert names(registry, 'rare alpha beta gamma') == ['boundary']
