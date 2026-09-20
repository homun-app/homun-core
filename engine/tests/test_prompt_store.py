"""Prompt templates as data: substitution, language fallback, presence."""
from pathlib import Path

import pytest

from homun.models.prompt_store import PromptStore, prompts_for


def test_render_substitutes_placeholders_without_format_parsing(tmp_path):
    (tmp_path / 'demo.it.txt').write_text('Ciao {{name}}, schema: {{schema}}', encoding='utf-8')
    rendered = PromptStore(root=tmp_path).get('demo').render(name='Fabio', schema='{"x": {"y": 1}}')
    assert rendered == 'Ciao Fabio, schema: {"x": {"y": 1}}'
    (tmp_path / 'bad.it.txt').write_text('left {{unknown}}', encoding='utf-8')
    with pytest.raises(ValueError, match='Unresolved placeholder'):
        PromptStore(root=tmp_path).get('bad').render()


def test_language_fallback_never_breaks_a_call(tmp_path):
    (tmp_path / 'greet.en.txt').write_text('hello', encoding='utf-8')
    store = PromptStore(root=tmp_path, default_language='it')
    assert store.get('greet', language='en').language == 'en'
    # Missing default translation falls back to any available variant.
    assert store.get('greet').text == 'hello'
    with pytest.raises(ValueError, match='not found'):
        store.get('missing')
    (tmp_path / 'neutral.txt').write_text('lang-neutral', encoding='utf-8')
    assert store.get('neutral').text == 'lang-neutral'


def test_production_templates_exist_in_default_and_english():
    store = PromptStore()
    for name in ('intake/synthesize', 'intake/classify', 'interpret/instructions', 'planning/instructions'):
        assert store.get(name).language == 'it', name
        assert store.get(name, language='en').language == 'en', name
    for name in ('interpret/schema_hint', 'planning/schema_hint'):
        assert store.get(name).text.lstrip().startswith('{'), name


def test_registry_owns_the_configured_store(tmp_path):
    from homun.models.registry import ModelRegistry
    registry = ModelRegistry(data_dir=Path(tmp_path))
    assert isinstance(registry.prompts, PromptStore)
    assert registry.prompts.default_language == 'it'


def test_test_fakes_fall_back_to_the_default_store():
    class Capture:
        def complete(self, messages):
            raise AssertionError('not called')

    assert prompts_for(Capture()).get('intake/classify').language == 'it'


def test_capability_catalog_lines_follow_the_template_language():
    from homun.models.intake import _capability_catalog_lines
    assert 'eseguibile dal motore' in _capability_catalog_lines(None, 'it')
    assert 'executable by the engine' in _capability_catalog_lines(None, 'en')
