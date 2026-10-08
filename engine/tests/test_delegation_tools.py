"""Structured child output keeps raw work when validation fails."""
from homun.application.delegation_schema import _validate_schema


def test_output_schema_and_bounded_fence_repair():
    schema = {'type':'object','properties':{'summary':{'type':'string'}}, 'required':['summary']}
    data, error = _validate_schema('```json\n{"summary":"Analisi completata"}\n```', schema)
    assert data == {'summary':'Analisi completata'}
    assert error is None
    data, error = _validate_schema('{"other":1}', schema)
    assert data == {'other':1}
    assert 'Schema validation error' in error
    data, error = _validate_schema('raw non JSON output', schema)
    assert data is None
    assert 'Failed to parse' in error
