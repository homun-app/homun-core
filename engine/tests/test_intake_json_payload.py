"""The tolerant JSON extractor keeps thinking-model output usable."""
import json

import pytest

from homun.models.intake import _extract_json_payload


def test_plain_and_fenced_json_pass_through() -> None:
    assert _extract_json_payload('{"a": 1}') == '{"a": 1}'
    assert _extract_json_payload('```json\n{"a": 1}\n```') == '{"a": 1}'


def test_prose_before_and_after_the_object_is_tolerated() -> None:
    assert _extract_json_payload('Ecco la proposta: {"a": 1}') == '{"a": 1}'
    assert _extract_json_payload('{"a": 1}\n\nSe serve altro dimmi.') == '{"a": 1}'
    assert _extract_json_payload('```json\n{"a": 1}\n```\nNota a margine.') == '{"a": 1}'


def test_first_complete_object_wins_over_trailing_blocks() -> None:
    text = '{"title": "brief", "objective": "o"}\n\n{"second": "block"} e una graffa } sparso'
    payload = _extract_json_payload(text)
    assert json.loads(payload) == {"title": "brief", "objective": "o"}


def test_brace_in_prose_before_the_object_is_skipped() -> None:
    text = 'Il vincolo {max 10 righe} vale.\n{"capability": "compare_csv"}'
    payload = _extract_json_payload(text)
    assert json.loads(payload) == {"capability": "compare_csv"}


def test_no_json_raises_value_error() -> None:
    with pytest.raises(ValueError):
        _extract_json_payload('nessun oggetto qui')
    with pytest.raises(ValueError):
        _extract_json_payload('{non json}')
